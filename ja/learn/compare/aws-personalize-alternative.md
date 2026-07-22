---
title: AWS Personalize の代替（OSS・セルフホスト）
description: AWS Personalize 代替となるセルフホスト型 OSS。ホスティング・データ配置・料金・アルゴリズム・API を比較し、Personalize の概念を Recotem にどう対応させるかを解説します。
---

# AWS Personalize の代替（OSS・セルフホスト）

[Amazon Personalize](https://aws.amazon.com/personalize/) は AWS 上のフルマネージド
なレコメンドサービスです。優れたプロダクトであり、多くのチームにとってマネージド
という形態はまさに適切です。しかし一部のチームは、次のような理由から **AWS
Personalize の代替** を探し始めます。

- **コストと予測可能性。** Personalize は従量課金（データ取り込み、学習、推論
  リクエスト、レコメンダーの時間あたり容量）で課金され、リアルタイムのキャンペーン
  は無トラフィックでも課金されるスループットを予約します。自社インフラを常時
  抱えているチームは、すでに支払っている固定的な計算コストを好むことがあります。
- **ベンダーロックイン。** 学習済みモデルは AWS の中に存在します。ソリューション
  バージョンをエクスポートして別環境で動かすことはできず、レコメンド API も AWS
  固有のため、レコメンダーはプラットフォームに強く結び付きます。
- **データの所在（データレジデンシー）。** Personalize は行動データを AWS
  （S3 と Personalize のデータセット、AWS リージョン内）へ取り込む必要があります。
  組織によっては学習データを自社インフラや特定の国・地域に留める必要があります。
- **セルフホスト。** パイプライン全体を自分たちで動かしたい、というチームもいます
  ——自社のクラウドアカウント、オンプレミス、あるいは閉域環境で。

[Recotem](/ja/docs/) は、この領域をカバーするオープンソース（Apache-2.0）の
セルフホスト型レコメンダーです。1 つの YAML **レシピ** がデータソース・学習・
配信エンドポイントを定義します。`recotem train` で署名付きモデルアーティファクトを
生成し、`recotem serve` で HTTP 経由に公開します。本ページでは両者を公平に比較し、
Personalize の概念をどう移行できるかを示します。

## なぜ代替を検討するのか

上記の理由は、いずれも Personalize が劣ったプロダクトだという意味ではありません
——トレードオフです。マネージドサービスが欲しく、すでに AWS に全面的に乗っている
なら、Personalize は多くの運用作業を肩代わりしてくれます。以降の内容は、コスト
モデル・データレジデンシー・可搬性、あるいはセルフホストしたいという制約を持つ
チームに向けたものです。

## Recotem と AWS Personalize の比較

意思決定を左右しやすい観点で両者を比較します。AWS の料金・機能の詳細は
**2026-07 時点** のものです。必ず最新の
[AWS Personalize 料金ページ](https://aws.amazon.com/personalize/pricing/)
で確認してください。

| 観点 | AWS Personalize | Recotem |
|---|---|---|
| **ホスティング** | フルマネージドの AWS サービス。運用するサーバーは不要。 | セルフホスト。任意のクラウド・オンプレミス・Docker/Kubernetes で自分で動かす。 |
| **データの所在** | 行動データを AWS（S3 + Personalize データセット、AWS リージョン内）へ取り込む。 | データは自社環境に留まる。CSV/Parquet・BigQuery・SQL から読み込み、アーティファクトは自社ストレージに出力。 |
| **料金モデル** | 従量課金。データ取り込み（約 $0.05/GB）、学習、推論（1,000 リクエスト単位）、ユーザー数に応じたレコメンダーの時間課金。リアルタイムのキャンペーンは無トラフィックでも課金される最低スループットを予約。*（2026-07 時点）* | 無料の OSS（Apache-2.0）。すでに動かしている計算資源とストレージの費用のみ。リクエスト単位・時間単位のライセンス料はなし。 |
| **アルゴリズム** | AWS 独自の「レシピ」: User-Personalization / -v2（Transformer/HRNN）、Similar-Items、SIMS、Personalized-Ranking、Popularity-Count など。 | OSS の [irspack](https://github.com/tohtsky/irspack) アルゴリズム: IALS、CosineKNN、RP3beta、DenseSLIM、TruncatedSVD、BPRFM、TopPop。列挙したものを Optuna が自動でハイパーパラメータ探索。 |
| **API** | AWS SDK / `GetRecommendations`・`GetPersonalizedRanking`。AWS SigV4 で認証。 | 自前の FastAPI サービス: `POST /v1/recipes/{name}:recommend`（ほかに `:recommend-related`・`:batch-recommend`）。`X-API-Key` ヘッダで認証。[Serving API](/ja/docs/serving-api) を参照。 |
| **運用負荷** | 低い。学習基盤・配信・スケーリング・再学習のオーケストレーションを AWS が担う。 | 自分で持つ。学習ホストと配信ホストを運用し、署名鍵を管理し、サービスをスケールさせる——その代わりに完全な制御と可搬性を得る。 |

最後の行がトレードオフの核心です。Personalize はコストとロックインの代わりに運用の
容易さを得ます。Recotem は運用の主体性の代わりに、制御・可搬性・すでに支払っている
固定コストを得ます。

## Personalize の概念を Recotem にどう対応させるか

Personalize を知っていれば、頭の中のモデルはそのまま移せます。Recotem は複数の
Personalize リソースを、1 つのレシピファイルと 1 つのアーティファクトにまとめます。

| AWS Personalize | Recotem での対応 |
|---|---|
| Interactions データセット + データ取り込みジョブ | レシピの `source` ブロック（S3/GCS 上の CSV/Parquet、BigQuery、SQL クエリ） |
| スキーマ（Avro） | レシピの `schema` ブロック（`user_column`・`item_column`・`time_column`） |
| レシピ + ソリューション（アルゴリズム + パラメータ） | `training.algorithms` のリスト + 最良モデルを選ぶ Optuna 探索 |
| ソリューションバージョン（学習済みモデル） | `recotem train` が出力する署名付き `.recotem` アーティファクト |
| キャンペーン（デプロイ済みソリューションバージョン） | `recotem serve` のエンドポイント `POST /v1/recipes/{name}:recommend` |
| Similar-Items / SIMS | `POST /v1/recipes/{name}:recommend-related` |
| バッチ推論ジョブ | `POST /v1/recipes/{name}:batch-recommend` |

大きな違いは次の点です。Personalize ではソリューションごとに 1 つのレシピを選びます
が、Recotem では複数のアルゴリズムを列挙し、組み込みの Optuna 探索がそれぞれを学習・
評価して、指定した指標（`ndcg`・`map`・`recall`・`hit`）で最良のものを残します。
したがって 1 つの Recotem レシピが、Personalize のデータセット・ソリューション・
キャンペーンの役割を一度に果たします。

## 移行のスケッチ

`USER_ID`・`ITEM_ID`・`TIMESTAMP` からなる Interactions データセットで学習した
Personalize の `User-Personalization` ソリューションがあるとします。対応する Recotem
レシピの形は次のとおりです。行動データはすでに手元にあるので、`source` をその置き場所
（S3 の CSV エクスポート、データウェアハウス、データベースなど）に向けるだけです。

```yaml
name: user_personalization

source:
  type: csv
  path: s3://my-bucket/interactions.csv.gz
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id     # ← Personalize の USER_ID
  item_column: item_id     # ← Personalize の ITEM_ID
  time_column: ts          # ← Personalize の TIMESTAMP

cleansing:
  dedup: keep_last
  min_rows: 5000

training:
  algorithms: [IALS, RP3beta, TopPop]   # 暗黙的フィードバックの CF + 人気度フォールバック
  metric: ndcg
  cutoff: 20
  n_trials: 40
  split:
    scheme: time_user
    heldout_ratio: 0.1

output:
  path: s3://my-bucket/artifacts/user_personalization.recotem
```

「ソリューションバージョンの作成」と「キャンペーンの作成」を置き換えるのは、次の
2 つのコマンドです。

```bash
recotem train recipe.yaml          # → アーティファクトに署名（「ソリューションバージョン」）
recotem serve --recipes ./recipes/ # → 配信する（「キャンペーン」）
```

最後にクライアントの呼び出しを差し替えます。`GetRecommendations` を呼んでいた箇所を、
セルフホストのエンドポイントに置き換えます。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/user_personalization:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

レスポンスは `item_id` / `score` を持つオブジェクトの順序付きリストで、任意で
アイテムメタデータを付加できます——Personalize から受け取っていた結果と同じ形です。
「この商品を買った人はこれも」のようなアイテム間レコメンド（Personalize の
Similar-Items / SIMS のユースケース）には、`seed_items` を渡して
`:recommend-related` を呼び出します。

::: tip ID はそのまま使える
Recotem はソースデータの生の `user_id` / `item_id` 文字列でレコメンドをキーにするため、
Personalize のデータセット周りで必要になりがちな別途の ID マッピングを保守する必要は
ありません。
:::

## AWS Personalize の方が向いている場合

公平な比較のためには、マネージドサービスが勝る場面も述べる必要があります。次のような
場合は Recotem より AWS Personalize を選ぶとよいでしょう。

- **運用の主体をまったく持ちたくない場合。** Personalize は学習・配信・スケーリング・
  再学習を代行します。Recotem は自分で運用するサービスなので、運用の余力がないなら
  マネージドの価値は費用に見合います。
- **AWS と深く統合している場合。** S3・EventBridge・IAM とのネイティブな連携や、
  容量計画なしの弾力的なスケーリングを重視する場合。
- **リアルタイム／ストリーミング更新が必要な場合。** Personalize はライブイベントを
  取り込み、レコメンドを継続的に更新できます。Recotem は「学習してホットスワップ」する
  モデルで、スケジュールで再学習し、サーバーが新しいアーティファクトをアトミックに
  再読み込みします。オンライン学習システムではありません。
- **Recotem にないマネージド機能が必要な場合。** Next-Best-Action、ユーザー
  セグメンテーション、コンテキスト考慮のレコメンド、コールドスタート向けの item
  exploration、自動の増分再学習など。

Recotem が最も活きるのは、その逆の制約です。すでにクエリできる行動データがあり、
モデルとデータを自社インフラに留めたく、リクエスト単位で支払うよりも、小さく明確な
サービスを運用したい——それが当てはまるなら、セルフホストの OSS レコメンダーは有力な
選択肢です。

## 次のステップ

- [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) — データがすでにウェアハウスにある場合の実践例。
- [Serving API リファレンス](/ja/docs/serving-api) — セルフホスト・レコメンド API の全エンドポイント・認証ヘッダ・レスポンス形式。
- [アーキテクチャ概要](/ja/docs/) — `train` と `serve` が署名付きアーティファクトだけで通信する仕組み。
- [OSS レコメンドエンジン比較](/ja/learn/compare/open-source) — Gorse・RecBole・Merlin との比較。
- [レコメンドエンジンは自作・SaaS・OSS どれを選ぶ？](/ja/learn/compare/build-vs-buy) — このページが扱う「購入 vs セルフホスト」を含む、より広い意思決定の全体像。
- すべてのガイドは [Learn ハブ](/ja/learn/) から。
