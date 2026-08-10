# ツール信頼性・スクリプト運用メモ

> [content-pipeline.md](content-pipeline.md) の実務編。TradingView MCP のどのツールが信頼でき、どれが壊れているか、どう回避するか、スクリプトの使い方。
>
> **最終更新**: 2026-07-25 ／ 検証環境: TradingView Desktop (Electron) + CDP:9222、無料プラン、日本株(TSE)日足

---

## 1. ツール信頼性（重要）

### ✅ 信頼できる
- **`quote_get` / `data_get_ohlcv`**（個別・銘柄切替後）：正しい値を返す。**必ず応答の解決シンボル（例 `TSE_DLY:6857`）を確認**してから数値を信用する。
- **CDP経由の生バー読み取り**（`_chartWidget.model().mainSeries().bars()` → `valueAt(i)` = `[time, open, high, low, close, volume]`）：ローカル計算の真値ソース。
- **スクショの価格ライン形状・現値**（SELL/BUYボックス、右端ラベル）：常に正しい。

### ❌ 壊れている / 信用できない
- **`batch_run`**：全銘柄で `JS evaluation error: Uncaught (in promise)`。**しかも失敗しつつ裏でチャートのシンボルを次々切替え、最後の銘柄で放置**する。実行後はチャートが元の場所にない → `chart_get_state` で現在地を確認。個別ループにフォールバックせよ。
- **`data_get_study_values`（指標読み取り）**：銘柄切替に追随せず **stale値** を返す（例：現値43,170の銘柄にEMA≈16,000）。移動平均の数値に使うな。
- **`symbol_info`**：`evaluate is not defined` でエラー。
- **スクショ凡例のEMA/ヘッダー数値**：描画確定前は **stale**。事前ロード済み銘柄でのみ正しかった。

### ⚠️ データの性質
- 日本株は `TSE_DLY:` 接頭辞＝**遅延データ**。日足・終値ベースの分析は問題なし。イントラデイ/リアルタイム用途は不可。

---

## 2. 中核バグと回避策：切替後の "stale" 問題
`chart.setSymbol()` 後、`symbolInfo()` は新シンボルに変わるが `bars()` は一瞬**前の銘柄のバーを保持**する。そのまま「安定」判定すると前銘柄のデータを掴む（実際に `8035` が `6857` のデータになった）。

**回避ゲート**（スクリプトに実装済み）：切替前の終値 `prevClose` を記録し、**新しい終値が `prevClose` から変化し、かつ2回連続で安定するまで待つ**。
```js
const changed = prevClose == null || c !== prevClose;
if (n > 60 && n === last && c === lastClose && changed) { if (++stable >= 2) return d; }
```

---

## 3. 精度の検証方法（根拠の透明性）
指標は「読み取り」ではなく**生の終値からコード計算**している（RSI=Wilder, MACD=EMA12-EMA26/signal EMA9, EMA/SMAは標準式）。出来高は生バーの `v[5]` をそのまま。信頼性は2段で担保：
- **検証A（計算式）**：ローカル計算EMA50 = チャート登録EMA50（28,939 = 28,939）で一致 → 式・実装が正しい。RSI/MACDは同じエンジン・同じ終値を通る。
- **検証B（入力データ）**：`dump_bars.js` で生バーを出力し、チャートのローソク（終値・出来高）と目視照合。

TradingView自身の値と突き合わせたい場合は、**新規タブにRSI/MACDを追加**（本チャートの2枠EMAに触れない）→ 描画確定後に照合、が非破壊的で安全。

---

## 4. スクリプト一覧（`scripts/`）
すべて `src/connection.js`（CDP:9222）経由。チャート指標は追加しない（無料プラン2枠に非依存）。

| スクリプト | 用途 | 実行 |
|---|---|---|
| [analyze_semi_jp.js](../scripts/analyze_semi_jp.js) | 複数銘柄をSMA/EMA/RSI/MACD/出来高/レンジ位置/トレンド分類で一括分析→JSON | `node scripts/analyze_semi_jp.js TSE:8035 TSE:6857 ...` |
| [rrg_compute.js](../scripts/rrg_compute.js) | RRG（RS-Ratio×RS-Momentum, 対 日経225）を計算→JSON | `node scripts/rrg_compute.js > out.json` |
| [dump_bars.js](../scripts/dump_bars.js) | 生の日足OHLCVをN本ダンプ（入力データ検算用） | `node scripts/dump_bars.js TSE:6857 15` |
| [backtest_rsi_macd.js](../scripts/backtest_rsi_macd.js) | RSI×MACD戦略のバックテスト（PF/DD/勝率/buy&hold） | `node scripts/backtest_rsi_macd.js` |
| [scan_demo.js](../scripts/scan_demo.js) | 画面録画用レトロ端末スキャン（動画コンテンツ用） | `node scripts/scan_demo.js` |

- 引数なしのデフォルト銘柄はスクリプト冒頭の `SYMBOLS`/`UNIVERSE` で定義。
- いずれも終了時にチャートを復帰（`analyze_semi_jp.js` は `TSE:6857` 日足へ）。
- 汎用化タスク：`UNIVERSE`/`BENCH` を引数化して他テーマ（防衛・ゲーム等）へ横展開可能。

---

## 4.5 リプレイモード（検証済み 2026-08-11 / Issue #3）

**結論：使える。** AI視覚判断バックテストの土台として成立する。

| 機能 | 状態 |
|---|---|
| `replay_start`（日付指定で直接ジャンプ） | ✅ |
| `replay_step`（1本送り、約5秒/回） | ✅ |
| `replay_stop`（リアルタイム復帰） | ✅ |
| **OHLCVデータの切り詰め** | ✅ **完全に機能**（例: 2026-08-10 → 2026-03-12 に切断） |
| スクショの未来隠蔽 | ✅ チャート領域は切断済み・"Replay"透かし付き |
| 指標（RSI/出来高/EMA）の描画 | ✅ 正常。値も整合 |

**決定的な意味**：データ側でも未来が隠れるため、**AI視覚判断と数式ルールを完全に同一条件で比較できる**（対照群が成立する）。

### ⚠️ リーク経路（必ず対策すること）
1. **サイドバーに現在値とニュースが出る** — `region:"full"` のスクショには右サイドバーの**実際の現在値**（例: リプレイ23,650に対し実際は34,260）と最近のニュース見出しが写る。
   → **必ず `region:"chart"` を使う。`region:"full"` は実験で使用禁止。**
2. **チャート内に銘柄名とX軸の年が出る** — `Advantest Corp. · 1D · TSE` / `2023…2026`。アシスタントは銘柄を知っているため匿名化が必要。
   → スクショ後に該当領域をマスク/クロップする処理を挟む。

### 💡 設計上の要点：ステップ送りは使わない
`replay_step` は約5秒/回。20日先を見るのに20回ステップすると100秒/サンプル＝500サンプルで14時間となり非現実的。
**`replay_start(date)` で任意の日付へ直接ジャンプできる**ため、
```
リプレイの役割 = スクショ時に未来を隠すことだけ
結果の測定    = ローカルキャッシュの完全な履歴から読む（リプレイ不要）
```
これで 1サンプル ≈ 10〜20秒（ジャンプ→スクショ→AI判断）に収まる。

### その他の実務メモ
- リプレイ開始時は **Replay Trading パネルが下半分を占有**し、チャートが約362pxに潰れる。`ui_click(text:"Replay Trading")` で閉じるボタンは見つかるが効果は未確認。チャート高さを確保する手順の確立が必要。
- リプレイ開始直後は表示範囲がリセットされることがある。`chart_set_visible_range` で明示指定するのが確実（`chart_get_visible_range` は `evaluate is not defined` で壊れている）。

---

## 5. CDP接続と再起動
- MCPはTradingView DesktopにCDP `localhost:9222` で接続。
- **通常の再起動でデバッグポートが閉じる** → `CDP connection failed`。復旧：
  ```
  scripts/launch_tv_debug_mac.sh
  ```
  `CDP ready at http://localhost:9222` を待って再試行。
- 診断：`lsof -nP -iTCP:9222 -sTCP:LISTEN`（何も出なければポート閉）。
- 注意：TradingViewが**自動アップデートで自己再起動**するとポートは引き継がれない → 再度スクリプト実行。
- MCP登録は asdf の実node絶対パスを使う（`~/.asdf/installs/nodejs/<ver>/bin/node`、shim不可）。

---

## 更新履歴
- 2026-07-25: 初版。ツール信頼性・stale回避・精度検証・スクリプト一覧・CDP運用を記録。
