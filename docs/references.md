# 科学的手法と文献

> 本研究所の検証手続きは、既存の学術的成果に接地させる。「独自の判定基準」を発明しない。
> 各項目に **我々の実装のどこで使うか** を明記する。

- **最終更新**: 2026-08-11
- **関連**: [ai-trading-strategy.md](ai-trading-strategy.md)（研究所憲章） / [tooling-notes.md](tooling-notes.md)（装置）

> ⚠️ 実装前に原典を確認すること。以下は記憶に基づく整理であり、式や定数はコード化する際に原典で検算する。

---

## 1. 多重検定・データスヌーピング（最重要）

我々が最初に実証した問題そのもの。ランダムデータ3,050試行でSharpe 2.15が出た（[selection_bias_demo.js](../scripts/selection_bias_demo.js)）。この領域は先行研究が厚い。

| 文献 | 内容 | 我々の使い所 |
|---|---|---|
| **White (2000), "A Reality Check for Data Snooping", Econometrica** | 多数のモデルを比較したとき、最良モデルの成績が偶然でないかをブートストラップで検定 | #7 ハーネスの中核判定 |
| **Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap", J. Finance** | **テクニカル売買ルールそのもの**にReality Checkを適用した実証研究。数千のルールを検証 | 我々のやろうとしていることの直接の先行研究。**必読** |
| **Hansen (2005), "A Test for Superior Predictive Ability" (SPA test)** | Reality Checkの改良。劣ったモデルの混入による検出力低下を補正 | #7 の検定手法 |
| **Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns", RFS** | 金融の実証研究における多重検定。t値2.0では不十分で、**3.0以上を要求すべき**と主張 | #19 増分情報量の閾値設定 |
| **Bailey & López de Prado (2014), "The Deflated Sharpe Ratio", J. Portfolio Management** | 試行回数・歪度・尖度でSharpeを割り引く。**この問題のために設計された指標** | #7 の主要指標。試行レジストリが入力 |
| **Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and Financial Charlatanism", Notices of the AMS** | バックテスト過学習の一般向け解説。「試行回数を報告しないバックテストは無意味」 | 研究所の行動規範 |

**含意**：単発でSharpe 1.5は有意ですらない（1年の日次データからの年率Sharpeの標準誤差 ≈ 1.0）。試行回数の記録は**任意ではなく必須**。

---

## 2. バックテストの方法論

| 文献 | 内容 | 我々の使い所 |
|---|---|---|
| **López de Prado (2018), "Advances in Financial Machine Learning"** | Purged k-fold CV、Combinatorial Purged CV、サンプル重み、メタラベリング。時系列でのリーク防止 | #7 のOOS分割設計。単純な時系列分割よりPurged CVが適切 |
| **Politis & Romano (1994), stationary bootstrap** | 時系列の依存構造を保ったままブートストラップ | #7 のモンテカルロ／Reality Check の再標本化 |

**含意**：ランダムなk-fold分割は時系列で情報漏洩を起こす。**purge（学習期間と検証期間の間に緩衝を置く）とembargo**が必要。

---

## 3. テクニカル分析・チャートパターンの実証研究

「チャートパターンは機能するのか」は、実は**先行研究がある**。旧issue #9 を再開する場合はここから始める。

| 文献 | 内容 | 我々の使い所 |
|---|---|---|
| **Lo, Mamaysky & Wang (2000), "Foundations of Technical Analysis", J. Finance** | **カーネル回帰でチャートパターン（ヘッドアンドショルダー等）を自動検出**し、統計的に検証。「人間の目が必要」ではないことを示した | 我々の「層1＝視覚判断は数式化できない」という前提が誤りだった直接の証拠。パターン検出は**数値でできる** |
| **Brock, Lakonishok & LeBaron (1992), J. Finance** | 移動平均・レンジブレイクの実証。ただし後にデータスヌーピング批判を受ける | 単純ルールのベースライン。§1のSullivanらによる再検証とセットで読む |

**含意**：チャートパターンの定量化は既に確立された手法がある。**AIの視覚認識を使う必然性は薄い**。層1を仮説に格下げした根拠のひとつ。

---

## 4. ファクター・残差分析

| 文献 | 内容 | 我々の使い所 |
|---|---|---|
| **Fama & French (1993, 2015)** | 市場・サイズ・バリュー等のファクターモデル | #20 のベースモデル。残差を定義するための「既知の説明」 |
| （直交化） | 新シグナルを既存ファクターで回帰し、残差の予測力を見る標準手法 | #19 増分情報量の実装そのもの |

**含意**：「新しい指標」の大半は既存ファクターの言い換え。**直交化してから評価する**のが標準。

---

## 5. 実装時の注意（文献から導かれる規律）

1. **試行回数を報告しないバックテストは提出しない**（Bailey et al.）
2. **t値2.0を有意とみなさない**。多重検定下では3.0以上を目安に（Harvey et al.）
3. **時系列CVはpurge/embargoを入れる**（López de Prado）
4. **ブートストラップは時系列依存を保つ**（Politis & Romano）
5. **単純ルールとの比較を必ず併記する**（Brock et al. とその批判の教訓）

---

## 6. Renaissance Technologies について

一次資料は限られる。以下は公開情報の範囲。

- Simons自身の講演（MIT Sloan等）：数学者・物理学者・天文学者を採用し、金融専門家を避けた。**データの清浄性**とシステム化、研究者間の共有を重視
- Renaissance公式採用ページ：Research Scientist / Research Engineer / Real-Time Trading Programmer / Research Infrastructure Programmer を**別々に募集**

**含意**：「優秀なモデル1個」ではなく、**研究とインフラの総合システム**を重視する構造。我々の役割分担（LLM＝研究者・実装者、統計エンジン＝判定、リスク＝独立）はこれを模したもの。

※ Gregory Zuckerman "The Man Who Solved the Market" (2019) は一般向け書籍として広く読まれているが、手法の技術的詳細は限定的。

---

## 更新履歴
- 2026-08-11: 初版。多重検定・バックテスト方法論・チャートパターン実証・ファクター/残差の4領域と、実装規律5項目。
