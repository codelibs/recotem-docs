---
title: Recotem を学ぶ
description: Recotem でレコメンドシステムを構築するための実践ガイド。GA4 や購買ログからの構築、AWS Personalize や Python レコメンドライブラリとの比較まで。
faq:
  - q: "Recotem とは何ですか？"
    a: "Recotem は、レシピ駆動のオープンソース・レコメンドシステム（Python）です。1つの YAML レシピにデータ・学習探索・出力を記述し、recotem train が署名付きモデルアーティファクトを生成、recotem serve がそれを /v1/recipes/{name}:recommend の HTTP API として公開します。レコメンダーライブラリ irspack を基盤としています。"
  - q: "Recotem は無料・オープンソースですか？"
    a: "はい。Recotem は Apache 2.0 ライセンスで公開され、すべて自前のインフラ上で動作します。リクエスト課金やマネージドサービスの月額料金はありません。"
  - q: "Recotem はどんなレコメンドアルゴリズムに対応していますか？"
    a: "IALS、RP3beta、CosineKNN、DenseSLIM、TruncatedSVD、BPRFM、および人気度ベースラインの TopPop に対応します。レシピに試したいアルゴリズムを列挙すると、Optuna のハイパーパラメータ探索が最良スコアのモデルを選びます。"
  - q: "Recotem にデータベースやメッセージブローカーは必要ですか？"
    a: "いいえ。学習と配信は署名付きアーティファクトファイルのみでやり取りするため、データベース・メッセージキュー・管理UIは不要です。recotem serve は新しいアーティファクトが現れると自動でホットスワップします。"
  - q: "モデルの学習には何のデータが必要ですか？"
    a: "相互作用の行 — (ユーザー, アイテム) のイベント1件につき1行、任意でタイムスタンプ — です。Recotem はクリック・再生・購買などの暗黙的フィードバックをモデル化し、星評価は不要です。データは CSV・Parquet・BigQuery・SQL データベースから取り込めます。"
  - q: "Recotem は AWS Personalize の代替になりますか？"
    a: "はい。Recotem は AWS Personalize のようなマネージドのレコメンドサービスに対する、セルフホスト可能なオープンソースの代替です。データもモデルも手元に保持でき、リクエスト課金もありません。"
---

# Recotem を学ぶ

Recotem で実際のレコメンドシステムを構築するための、タスク志向のガイド集です。
各ガイドは単独で完結し、実行可能なレシピに基づいています。手元のデータや、
検討中の意思決定に合ったものを選んでください。

## コンセプト

レコメンドシステムの背景にある考え方を理解します。

- [レコメンドシステムとは](/ja/learn/concepts/recommendation-system) —
  全体像と、レコメンダーが使われる場面。
- [協調フィルタリングとは](/ja/learn/concepts/collaborative-filtering) —
  「あなたに似た人」を支える定番手法。
- [暗黙的・明示的フィードバック](/ja/learn/concepts/implicit-explicit-feedback) —
  クリックや購買 vs 星評価。
- [推薦の評価指標: nDCG, MAP, Recall@K](/ja/learn/concepts/evaluation-metrics) —
  ランキング品質の測り方。

## ハウツー

ステップバイステップのチュートリアル。

- [Python でレコメンドを作る方法](/ja/learn/how-to/build-in-python) —
  インタラクションから API まで。
- [レコメンドの評価方法](/ja/learn/how-to/evaluate) —
  オフライン評価を正しく行う。
- [暗黙的フィードバックで推薦を作る](/ja/learn/how-to/implicit-feedback) —
  イベントログからランキングまで。

## ユースケース

手元にあるデータから、動くレコメンダーを構築します。

- [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) —
  Google Analytics 4 のイベントをレコメンド API に変換します。
- [購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) —
  EC の購買履歴から「この商品を買った人はこれも」を作ります。
- [SQL データベースからレコメンド](/ja/learn/use-cases/sql-database) —
  PostgreSQL / MySQL / SQLite から直接学習します。
- [アプリにレコメンド API を追加](/ja/learn/use-cases/recommendation-api) —
  自前のインフラで HTTP レコメンドを配信します。

## 比較

代替手段と比べたときの Recotem の位置づけ。

- [AWS Personalize の代替](/ja/learn/compare/aws-personalize-alternative) —
  セルフホスト可能な OSS の選択肢。
- [Recotem vs LightFM vs implicit](/ja/learn/compare/python-libraries) —
  フレームワークとライブラリの違い。
- [OSS レコメンドエンジン比較](/ja/learn/compare/open-source) —
  Gorse、RecBole、Merlin、そして Recotem。

## よくある質問

### Recotem とは何ですか？

Recotem は、レシピ駆動のオープンソース・レコメンドシステム（Python）です。1つの
YAML レシピにデータ・学習探索・出力を記述し、`recotem train` が署名付きモデル
アーティファクトを生成、`recotem serve` がそれを `/v1/recipes/{name}:recommend`
の HTTP API として公開します。レコメンダーライブラリ
[irspack](https://github.com/tohtsky/irspack) を基盤としています。

### Recotem は無料・オープンソースですか？

はい。Recotem は Apache 2.0 ライセンスで公開され、すべて自前のインフラ上で動作
します。リクエスト課金やマネージドサービスの月額料金はありません。

### Recotem はどんなレコメンドアルゴリズムに対応していますか？

IALS、RP3beta、CosineKNN、DenseSLIM、TruncatedSVD、BPRFM、および人気度ベース
ラインの TopPop に対応します。レシピに試したいアルゴリズムを列挙すると、
[Optuna](/ja/docs/recipe-reference#training) のハイパーパラメータ探索が最良スコアの
モデルを選びます。

### Recotem にデータベースやメッセージブローカーは必要ですか？

いいえ。学習と配信は署名付きアーティファクトファイルのみでやり取りするため、
データベース・メッセージキュー・管理UIは不要です。`recotem serve` は新しい
アーティファクトが現れると自動でホットスワップします。

### モデルの学習には何のデータが必要ですか？

相互作用の行 — (ユーザー, アイテム) のイベント1件につき1行、任意でタイム
スタンプ — です。Recotem はクリック・再生・購買などの
[暗黙的フィードバック](/ja/learn/concepts/implicit-explicit-feedback) をモデル化し、
星評価は不要です。データは CSV・Parquet・BigQuery・SQL データベースから
取り込めます。

### Recotem は AWS Personalize の代替になりますか？

はい。Recotem は AWS Personalize のようなマネージドのレコメンドサービスに対する、
セルフホスト可能なオープンソースの代替です。データもモデルも手元に保持でき、
リクエスト課金もありません。詳しくは
[AWS Personalize の代替](/ja/learn/compare/aws-personalize-alternative)
を参照してください。

## 次のステップ

- Recotem が初めてなら [ガイド](/ja/guide/) から。
- フィールドの詳細は [レシピリファレンス](/ja/docs/recipe-reference) を参照。
