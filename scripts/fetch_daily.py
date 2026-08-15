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
  python3 scripts/fetch_daily.py --update       # 差分更新（重なりを突き合わせ、書き換えを検出したら取り込まない）
  python3 scripts/fetch_daily.py --verify       # マニフェストとの整合を検査
"""
import argparse, gzip, hashlib, json, math, os, sys, time, warnings
from datetime import datetime, timedelta, timezone

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
OVERLAP_DAYS = 45   # 差分更新でさかのぼって突き合わせる日数（遡及書き換えの検出用）
FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'adjc']


def canonical(payload: dict) -> bytes:
    """ファイルに書き出すのと同一のバイト列。ハッシュはこれを対象にする。

    言語をまたぐハッシュ一致のため、オブジェクトではなく【バイト列】を対象にする。
    Python は 1440.0、JS は 1440 と書き出すため、
    それぞれが自前で直列化したものをハッシュすると同じデータでも不一致になる（実測）。
    また fetched_at のような取得ごとに変わる値は含めない。
    含めると、内容が同じでも再取得のたびにハッシュが変わってしまう。
    """
    # allow_nan=False: NaN/Infinity が混じったら書き出し時に例外にする。
    # 標準外のJSONになり、他言語から読めなくなるため。
    return json.dumps(payload, separators=(',', ':'), sort_keys=True, allow_nan=False).encode()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def bar_path(ticker: str) -> str:
    return os.path.join(DAILY_DIR, f'{ticker}.json.gz')


def load_bars(ticker: str):
    p = bar_path(ticker)
    if not os.path.exists(p):
        return None
    with gzip.open(p, 'rt', encoding='utf-8') as f:
        return json.load(f)


def save_bars(ticker: str, payload: dict) -> str:
    """保存し、そのバイト列の sha256 を返す。"""
    raw = canonical(payload)
    with gzip.open(bar_path(ticker), 'wb') as f:
        f.write(raw)
    return sha256_bytes(raw)


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
        if not math.isfinite(cv):
            continue
        def g(s, d=None):
            try:
                x = float(s.iloc[i])
                # NaN だけでなく ±Infinity もはじく。
                # JSON の標準外の値になり、他言語のパーサが読めなくなる（実測で混入）。
                return None if not math.isfinite(x) else round(x, 4)
            except Exception:
                return d
        rows.append([
            int(ts.timestamp()), g(o), g(h), g(l), round(cv, 4),
            int(v.iloc[i]) if v is not None and v.iloc[i] == v.iloc[i] else 0,
            g(a) if a is not None else None,
        ])
    return rows


def compare_overlap(old_rows, new_rows):
    """重なる期間で【生の価格が書き換わっていないか】を調べる。

    yfinance は分割が起きると過去の価格を遡って書き換える（実測: 5801 の 49,280 → 4,928）。
    差分更新でこれを見逃すと、探索期間の結果が再現できなくなったことに気づけない。
    したがって重なり部分を必ず突き合わせ、変化していたら【書き込まずに報告する】。

    adjc は比較しない。配当が出るたびに正当に再計算されるため、
    比較対象にすると毎回差分として出てしまう。
    """
    o = {r[0]: r for r in old_rows}
    n = {r[0]: r for r in new_rows}
    diffs = []
    for ts in sorted(set(o) & set(n)):
        a, b = o[ts], n[ts]
        for i in range(1, 6):          # o, h, l, c, v のみ（adjc=6 は除く）
            x, y = a[i], b[i]
            if x is None and y is None:
                continue
            if x is None or y is None or abs(float(x) - float(y)) > max(1e-6, abs(float(x)) * 1e-9):
                d = datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d')
                diffs.append((d, FIELDS[i], x, y))
                break
    return diffs


def merge_rows(old_rows, new_rows):
    """既存に新しいバーを足す。重なりは既存を残す（履歴を書き換えない）。"""
    by_ts = {r[0]: r for r in new_rows}
    by_ts.update({r[0]: r for r in old_rows})   # 既存が優先
    return [by_ts[ts] for ts in sorted(by_ts)]


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
            p = bar_path(t)
            if not os.path.exists(p):
                missing += 1; continue
            with gzip.open(p, 'rb') as f:
                raw = f.read()
            if sha256_bytes(raw) == rec['sha256']:
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

    t0 = time.time(); done = failed = skipped = 0
    rewrites = {}
    for i in range(0, len(tickers), BATCH):
        chunk = tickers[i:i + BATCH]

        # 差分更新: 既存の最終日の少し前から取り直し、重なりを突き合わせる。
        # 重なりを取らずに継ぎ足すと、遡及書き換えを検出できないまま混ざる。
        existing = {t: load_bars(t) for t in chunk} if args.update else {}
        if args.update:
            lasts = [d['bars'][-1][0] for d in existing.values() if d and d.get('bars')]
            start = (datetime.fromtimestamp(min(lasts), timezone.utc) - timedelta(days=OVERLAP_DAYS)
                     ).strftime('%Y-%m-%d') if lasts else START
        else:
            start = START

        got = fetch(chunk, start)
        for t in chunk:
            rows = got.get(t) or []
            old = existing.get(t)

            if args.update and old and old.get('bars'):
                diffs = compare_overlap(old['bars'], rows)
                if diffs:
                    # 遡及書き換えを検出。書き込まずに報告する。
                    rewrites[t] = diffs[:5]
                    skipped += 1
                    continue
                rows = merge_rows(old['bars'], rows)

            if not rows:
                failed += 1
                continue
            # fetched_at は含めない（内容が同じなら再取得でもハッシュが変わらないように）
            payload = {'symbol': t, 'code': meta[t]['code'], 'name': meta[t]['name'],
                       'source': 'yfinance', 'fields': FIELDS, 'bars': rows}
            digest = save_bars(t, payload)
            manifest['symbols'][t] = {
                'rows': len(rows),
                'first': datetime.fromtimestamp(rows[0][0], timezone.utc).strftime('%Y-%m-%d'),
                'last': datetime.fromtimestamp(rows[-1][0], timezone.utc).strftime('%Y-%m-%d'),
                'sha256': digest,
            }
            done += 1
        el = time.time() - t0
        print(f'  {min(i+BATCH,len(tickers)):>5}/{len(tickers)}  成功{done} 失敗{failed} '
              f'書換検出{skipped}  {el:.0f}秒', flush=True)

    if rewrites:
        print(f'\n⚠️  過去の価格が書き換わっていた銘柄: {len(rewrites)}件（更新していません）')
        print('   分割の遡及適用と思われます。取り込むと探索期間の結果が再現できなくなります。')
        for t, ds in list(rewrites.items())[:10]:
            d, f, x, y = ds[0]
            print(f'     {t:<9} {d} {f}: {x} → {y}（他 {len(ds)-1}件）')
        path = os.path.join(DATA_DIR, 'rewrites.json')
        with open(path, 'w') as fh:
            json.dump({'detected_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                       'symbols': {t: [list(x) for x in ds] for t, ds in rewrites.items()}}, fh, indent=1)
        print(f'   記録: {path}')

    manifest['count'] = len(manifest['symbols'])
    manifest['manifest_sha256'] = sha256_bytes(canonical(manifest['symbols']))
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    size = sum(os.path.getsize(os.path.join(DAILY_DIR, f)) for f in os.listdir(DAILY_DIR))
    print(f'\n完了: {done}銘柄 / 失敗 {failed} / {time.time()-t0:.0f}秒')
    print(f'容量: {size/1024/1024:.1f} MB')
    print(f'マニフェスト hash: {manifest["manifest_sha256"][:16]}...')
    return 0


if __name__ == '__main__':
    sys.exit(main())
