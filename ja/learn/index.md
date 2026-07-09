---
title: Recotem を学ぶ
description: Recotem でレコメンドシステムを構築するための実践ガイド。GA4 や購買ログからの構築、AWS Personalize や Python レコメンドライブラリとの比較まで。
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

## 次のステップ

- Recotem が初めてなら [ガイド](/ja/guide/) から。
- フィールドの詳細は [レシピリファレンス](/ja/docs/recipe-reference) を参照。
