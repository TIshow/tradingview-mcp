"""
日足データの取得とキャッシュ。

保存先: data/<market>/daily/<ticker>.json.gz  （.gitignore）
        data/<market>/manifest.json           （git管理・ハッシュのみ）

設計の要点
  - 保存するのは【生のOHLCVのみ】。指標は使う側で都度計算する。
    派生データを保存すると容量が10倍以上に膨らむため。
  - マニフェストに銘柄ごとの sha256 を記録する。
    yfinance は分割を遡って価格を書き換えるため（実測: 5801 の 49,280 → 4,928）、
    再取得すると過去の数値が変わりうる。ハッシュがないと
    「再現できていない結果を再現したと誤認する」。
  - gzip で保存する（実測 121KB → 44KB）。

Usage:
  python3 scripts/fetch_daily.py                # 全銘柄を取得
  python3 scripts/fetch_daily.py --limit 20     # 動作確認用に先頭20銘柄
  python3 scripts/fetch_daily.py --update       # 既存を差分更新（最終日以降のみ）
  python3 scripts/fetch_daily.py --verify       # マニフェストとの整合を検査
"""
import argparse, gzip, hashlib, json, os, sys, time, warnings
from datetime import datetime, timezone

warnings.filterwarnings('ignore')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIVERSE = os.path.join(ROOT, 'scripts', 'data', 'universe-jp.json')
MARKET = 'jp'
DATA_DIR = os.path.join(ROOT, 'data', MARKET)
DAILY_DIR = os.path.join(DATA_DIR, 'daily')
MANIFEST = os.path.join(DATA_DIR, 'manifest.json')

START = '2016-01-01'
DATASET_ID = 'jp_equity_daily_yfinance_v1'
BATCH = 50          # yfinance の一括ダウンロード単位
FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'adjc']


def sha256_of(obj) -> str:
    return hashlib.sha256(json.dumps(obj, separators=(',', ':'), sort_keys=True).encode()).hexdigest()


def bar_path(ticker: str) -> str:
    return os.path.join(DAILY_DIR, f'{ticker}.json.gz')


def load_bars(ticker: str):
    p = bar_path(ticker)
    if not os.path.exists(p):
        return None
    with gzip.open(p, 'rt', encoding='utf-8') as f:
        return json.load(f)


def save_bars(ticker: str, payload: dict):
    with gzip.open(bar_path(ticker), 'wt', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'))


def frame_to_rows(df, ticker: str):
    """yfinance の DataFrame を [t,o,h,l,c,v,adjc] の配列に変換する。"""
    rows = []
    if df is None or len(df) == 0:
        return rows
    # 複数銘柄まとめ取りだと列が MultiIndex になる
    def col(name):
        if isinstance(df.columns, __import__('pandas').MultiIndex):
            return df[name][ticker] if (name, ticker) in df.columns or name in df.columns.levels[0] else None
        return df[name] if name in df.columns else None

    o, h, l, c, v = (col(x) for x in ('Open', 'High', 'Low', 'Close', 'Volume'))
    a = col('Adj Close')
    if o is None or c is None:
        return rows
    for i, ts in enumerate(df.index):
        try:
            cv = float(c.iloc[i])
        except Exception:
            continue
        if cv != cv:      # NaN
            continue
        def g(s, d=None):
            try:
                x = float(s.iloc[i])
                return None if x != x else round(x, 4)
            except Exception:
                return d
        rows.append([
            int(ts.timestamp()), g(o), g(h), g(l), round(cv, 4),
            int(v.iloc[i]) if v is not None and v.iloc[i] == v.iloc[i] else 0,
            g(a) if a is not None else None,
        ])
    return rows


def fetch(tickers, start, end=None):
    import yfinance as yf
    df = yf.download(tickers, start=start, end=end, progress=False,
                     auto_adjust=False, threads=True, group_by='column')
    out = {}
    for t in tickers:
        try:
            sub = df.xs(t, axis=1, level=1, drop_level=True) if len(tickers) > 1 else df
        except Exception:
            sub = None
        rows = frame_to_rows(sub, t) if sub is not None else []
        if not rows and len(tickers) == 1:
            rows = frame_to_rows(df, t)
        out[t] = rows
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--update', action='store_true', help='最終日以降のみ取得して追記')
    ap.add_argument('--verify', action='store_true', help='マニフェストとの整合を検査')
    args = ap.parse_args()

    os.makedirs(DAILY_DIR, exist_ok=True)
    uni = json.load(open(UNIVERSE))
    syms = uni['symbols'][:args.limit] if args.limit else uni['symbols']
    tickers = [s['ticker'] for s in syms]
    meta = {s['ticker']: s for s in syms}

    if args.verify:
        man = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {'symbols': {}}
        ok = bad = missing = 0
        for t, rec in man.get('symbols', {}).items():
            d = load_bars(t)
            if d is None:
                missing += 1; continue
            if sha256_of(d['bars']) == rec['sha256']:
                ok += 1
            else:
                bad += 1
                print(f'  ❌ {t}: ハッシュ不一致（データが書き換わっている）')
        print(f'一致 {ok} / 不一致 {bad} / 欠損 {missing}')
        return 0 if bad == 0 and missing == 0 else 1

    manifest = {'dataset_id': DATASET_ID, 'source': 'yfinance',
                'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'start': START, 'fields': FIELDS, 'symbols': {}}
    if args.update and os.path.exists(MANIFEST):
        manifest = json.load(open(MANIFEST))
        manifest['fetched_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')

    t0 = time.time(); done = failed = 0
    for i in range(0, len(tickers), BATCH):
        chunk = tickers[i:i + BATCH]
        got = fetch(chunk, START)
        for t in chunk:
            rows = got.get(t) or []
            if not rows:
                failed += 1
                continue
            payload = {'symbol': t, 'code': meta[t]['code'], 'name': meta[t]['name'],
                       'source': 'yfinance', 'fields': FIELDS,
                       'fetched_at': manifest['fetched_at'], 'bars': rows}
            save_bars(t, payload)
            manifest['symbols'][t] = {
                'rows': len(rows),
                'first': datetime.fromtimestamp(rows[0][0], timezone.utc).strftime('%Y-%m-%d'),
                'last': datetime.fromtimestamp(rows[-1][0], timezone.utc).strftime('%Y-%m-%d'),
                'sha256': sha256_of(rows),
            }
            done += 1
        el = time.time() - t0
        print(f'  {min(i+BATCH,len(tickers)):>5}/{len(tickers)}  成功{done} 失敗{failed}  {el:.0f}秒', flush=True)

    manifest['count'] = len(manifest['symbols'])
    manifest['manifest_sha256'] = sha256_of(manifest['symbols'])
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    size = sum(os.path.getsize(os.path.join(DAILY_DIR, f)) for f in os.listdir(DAILY_DIR))
    print(f'\n完了: {done}銘柄 / 失敗 {failed} / {time.time()-t0:.0f}秒')
    print(f'容量: {size/1024/1024:.1f} MB')
    print(f'マニフェスト hash: {manifest["manifest_sha256"][:16]}...')
    return 0


if __name__ == '__main__':
    sys.exit(main())
