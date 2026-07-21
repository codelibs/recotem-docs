---
title: Recotem を学ぶ
description: Recotem でレコメンドシステムを構築するための実践ガイド。GA4 や購買ログからの構築、AWS Personalize や Python レコメンドライブラリとの比較まで。
---

# Recotem を学ぶ

Recotem で実際のレコメンドシステムを構築するための、タスク志向のガイド集です。
各ガイドは単独で完結し、実行可能なレシピに基づいています。手元のデータや、
検討中の意思決定に合ったものを選んでください。

## 基礎知識

レコメンドシステムが初めてなら、まず基礎から。

- [レコメンドエンジンとは](/ja/learn/basics/what-is-a-recommendation-engine) —
  仕組み、主要なアルゴリズムの種類、導入の始め方。
- [協調フィルタリングとは](/ja/learn/basics/collaborative-filtering) —
  ユーザーベース / アイテムベース、行列分解、暗黙的フィードバック。

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
- [EC サイトのレコメンド導入](/ja/learn/use-cases/ecommerce) —
  設置場所・必要データ・効果測定の実践ガイド。

## 比較

代替手段と比べたときの Recotem の位置づけ。

- [自作・SaaS・OSS どれを選ぶ？](/ja/learn/compare/build-vs-buy) —
  レコメンドエンジンの導入形態を公平に比較。
- [AWS Personalize の代替](/ja/learn/compare/aws-personalize-alternative) —
  セルフホスト可能な OSS の選択肢。
- [Recotem vs LightFM vs implicit](/ja/learn/compare/python-libraries) —
  フレームワークとライブラリの違い。
- [OSS レコメンドエンジン比較](/ja/learn/compare/open-source) —
  Gorse、RecBole、Merlin、そして Recotem。

## 次のステップ

- Recotem が初めてなら [ガイド](/ja/guide/) から。
- フィールドの詳細は [レシピリファレンス](/ja/docs/recipe-reference) を参照。
