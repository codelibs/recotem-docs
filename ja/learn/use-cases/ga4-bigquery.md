---
title: GA4 × BigQuery で商品レコメンド
description: "GA4 レコメンドを BigQuery の events エクスポートから構築する手順。SQL とレシピだけで、学習からライブなレコメンド API 配信までを解説します。"
---

# GA4 × BigQuery で商品レコメンド

すでに Google Analytics 4（GA4）を BigQuery にエクスポートしているなら、レコメンダー
に必要なデータはすべて揃っています。「どのユーザーがどの商品を、いつ閲覧・購入したか」
です。このガイドでは、その生の `events_*` エクスポートを、SQL クエリ 1 本・レシピ
ファイル 1 つ・Recotem のコマンド 2 つだけで、ライブな
`/v1/recipes/{name}:recommend` API に変換します。ノートブックも特徴量ストアも、
保守すべきモデルコードもありません。

対象は、GA4 → BigQuery エクスポートを有効化済みの EC サイトやコンテンツサイトを
運営していて、ホスト型 ML プラットフォームを導入せずに商品レコメンドを実現したい
エンジニア・アナリストです。Recotem が初めての場合は、まず
[チュートリアル](/ja/guide/tutorial/)で同じ「学習 → 配信 → レコメンド」の流れを
小さな CSV で体験してください。

## 必要なもの

- **GA4 と BigQuery の連携。** GA4 の管理画面 →「BigQuery のリンク」でエクスポートを
  有効にします。GA4 は `analytics_123456789` のようなデータセットに、日付でシャード
  された `events_YYYYMMDD` テーブルを毎日 1 つずつ書き込みます。
- **読み取り権限を持つサービスアカウント。** プロジェクトに
  `roles/bigquery.jobUser`、分析データセットに `roles/bigquery.dataViewer` が必要です。
  IAM の詳細は [BigQuery ソースリファレンス](/ja/docs/data-sources/bigquery)を参照してください。
- **BigQuery エクストラ付きの Recotem:**

```bash
pip install "recotem[bigquery]"
```

Recotem の認証は Application Default Credentials（ADC）で行われ、認証情報をレシピ内に
書くことはありません。ローカル開発では次のようにします。

```bash
gcloud auth application-default login
```

GCE・GKE・Cloud Run・Vertex AI 上ではメタデータサーバーが認証情報を自動的に提供する
ため、キーファイルは不要です。

## インタラクションを整形する

Recotem は *(ユーザー, アイテム, タイムスタンプ)* のフラットなインタラクション表で
学習します。あなたの仕事は、GA4 のネストされたイベントスキーマをこの 3 列に平坦化する
クエリを 1 本書くことです。列の**エイリアス名は、レシピの `schema` ブロックで参照する
名前と一致させる**必要があります。BigQuery ソースは取得した DataFrame をそのまま学習に
渡し、列名の変換や導出は行いません。

EC サイトで最も強いシグナルは、GA4 標準の eコマースイベント `view_item` と `purchase`
です。どちらも繰り返し（repeated）レコードの `items` を持ち、その `item_id` がまさに
商品 ID なので、`UNNEST(items)` 1 回でユーザー×商品のインタラクションを 1 行ずつ
得られます。

```sql
SELECT
  user_pseudo_id                            AS user_id,
  item.item_id                              AS item_id,
  TIMESTAMP_MICROS(event_timestamp)         AS ts
FROM
  `my-project.analytics_123456789.events_*`,
  UNNEST(items) AS item
WHERE
  _TABLE_SUFFIX BETWEEN
    FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
  AND event_name IN ('view_item', 'purchase')
  AND item.item_id IS NOT NULL
```

このクエリが押さえているポイント:

- **`_TABLE_SUFFIX` でスキャン範囲を絞る。** シャードのサフィックスを直近 90 日の
  ウィンドウに限定することで、BigQuery はエクスポート履歴全体ではなく範囲内のテーブル
  だけを読みます。日付は `CURRENT_DATE()` / `DATE_SUB()` で SQL 内に計算されるため、
  レシピ側でパラメータバインドをしなくても常に最新の状態を保てます。
- **`user_pseudo_id` が可搬性の高いユーザーキー。** すべてのイベントに存在します。
  gtag でログイン済みの `user_id` を設定していてクロスデバイスの履歴を使いたい場合は、
  先頭の列を `COALESCE(user_id, user_pseudo_id) AS user_id` に置き換えます。
- **両イベントを 1 つの暗黙的フィードバックとして扱う。** 閲覧と購入をどちらも
  ポジティブなインタラクションとみなします。これは IALS のような暗黙的フィードバック型
  レコメンダーが前提とするもので、評価値ではなく*エンゲージメント*をモデル化します。

::: tip スキャン量に注意
Recotem は `recotem validate` の際にクエリを BigQuery のドライラン（**課金なし**）として
検証しますが、`maximum_bytes_billed` は設定しません。大きなエクスポートでは
`_TABLE_SUFFIX` のウィンドウを狭く保ち、暴走したバックフィルが請求額を跳ね上げないよう、
プロジェクト単位の課金バイト上限の設定も検討してください。
:::

eコマース計測を行っていないコンテンツサイトでは、代わりに `page_location` から
アイテムを導出できます。`REGEXP_EXTRACT` のパターンは
[BigQuery ソースリファレンス](/ja/docs/data-sources/bigquery)を参照してください。

## レシピを書く

レシピは唯一の信頼できる情報源です。1 つの YAML ファイルが、データ・学習探索・署名済み
モデルアーティファクトの出力先を定義します。次の内容を `recipes/product_recs.yaml` として
保存します。

```yaml
name: product_recs

source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                            AS user_id,
      item.item_id                              AS item_id,
      TIMESTAMP_MICROS(event_timestamp)         AS ts
    FROM
      `my-project.analytics_123456789.events_*`,
      UNNEST(items) AS item
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name IN ('view_item', 'purchase')
      AND item.item_id IS NOT NULL

schema:
  user_column: user_id
  item_column: item_id
  time_column: ts

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 5000
  min_users: 100
  min_items: 50

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  timeout_seconds: 1800
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42

output:
  path: ./artifacts/product_recs.recotem
  versioning: append_sha
```

主なブロックの役割:

- **`schema`** はクエリのエイリアスを Recotem の役割に対応づけます。`time_column` を
  設定しているので、時系列を考慮した分割が使えます。
- **`cleansing`** は重複した *(ユーザー, アイテム)* ペアを除去し（`keep_last`）、
  データが少なすぎる場合の学習を拒否します。`min_rows` / `min_users` / `min_items` を
  下回ると、役に立たないモデルを作る代わりに `min_data_violation` として明確に終了します。
- **`training.algorithms`** は IALS（暗黙的フィードバックの行列分解）、RP3beta
  （ランダムウォーク型のグラフモデル）、TopPop（人気度ベースライン）にわたる Optuna
  探索を実行します。Recotem は各アルゴリズムをチューニングし、`ndcg@20` が最も高い
  モデルを採用します。TopPop は下限を保証する仕組みではなく候補の 1 つです。
  最高スコアならそれが出荷されますし、**人気度を上回ったことはモデルが良い証拠には
  なりません** — [モデルは本当に良いのか](/ja/learn/basics/collaborative-filtering#モデルは本当に良いのか) を参照してください。
- **`split.scheme: time_user`** は各ユーザーの直近 10% のインタラクションを評価用に
  ホールドアウトします。これは「過去から未来を予測する」という本番での使われ方を
  そのまま再現しています。

各フィールドの詳細は[レシピリファレンス](/ja/docs/recipe-reference)にあります。

### 任意: 商品メタデータでレスポンスを充実させる

素の API は `item_id` と `score` を返します。各レコメンドにタイトル・カテゴリ・画像 URL
を添えたい場合は、商品 ID をキーにした商品ファイル（CSV または Parquet）を指す
`item_metadata` ブロックを追加します。

```yaml
item_metadata:
  type: parquet
  path: gs://my-bucket/catalog/products.parquet
  fields: [title, category, image_url]
  item_id_column: item_id
```

レスポンスに結合されるのは `fields` に列挙した項目だけなので、サーバーから出ていく情報を
正確に制御できます。

## 学習と配信

Recotem はすべてのアーティファクトを HMAC 鍵で署名し、配信側がそれを信頼できるように
します。まず一度だけ鍵を生成します。

```bash
recotem keygen --type signing --kid dev
recotem keygen --type api     --kid dev
```

各コマンドが出力した値をエクスポートします。

```bash
export RECOTEM_SIGNING_KEYS="dev:<signing の hex>"
export RECOTEM_API_KEYS="dev:sha256:<api の hash hex>"
export RECOTEM_API_PLAINTEXT="<api の plaintext>"   # 後述の curl で使用
```

先に検証します。これはクエリのパースと ADC の動作を確認する**無料**の BigQuery
ドライランで、クエリの実行も学習も行いません。

```bash
recotem validate recipes/product_recs.yaml
```

続いて学習と配信を行います。

```bash
mkdir -p artifacts
recotem train recipes/product_recs.yaml
recotem serve --recipes ./recipes/ --port 8080
```

`recotem train` はクエリを実行し、インタラクションを取得し（可能なら Storage Read API
経由）、Optuna 探索を実行して、署名済みアーティファクトを `./artifacts/` に書き込みます。
`recotem serve` はそのディレクトリを監視し、新しいアーティファクトを HMAC 検証して
エンドポイントを登録します。モデルが読み込まれたことを確認します。

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

## レコメンド API を呼び出す

レシピの `name`（`product_recs`）がエンドポイントになります。学習時に登場した
`user_pseudo_id` の値を渡して、あるユーザーへのレコメンドを取得します。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/product_recs:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1799394.3271658067", "limit": 5}'
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "product_recs",
  "model_version": "sha256:a3f2c1...e91d",
  "items": [
    {"item_id": "SKU-4821", "score": 0.913, "title": "メリノウール ビーニー", "category": "accessories"},
    {"item_id": "SKU-1180", "score": 0.847, "title": "サーマル ベースレイヤー", "category": "apparel"},
    {"item_id": "SKU-9032", "score": 0.802, "title": "断熱ボトル 750ml", "category": "gear"}
  ]
}
```

`title` と `category` は `item_metadata` を設定した場合のみ付きます。設定しない場合、
各アイテムは `item_id` と `score` のみです。アイテムは `score` の降順で並びます。

::: tip 新規ユーザーへの対応
学習データに存在しなかった `user_pseudo_id` は `404 UNKNOWN_USER` を返します。これは
初回訪問者では想定内の挙動です。アプリ側で捕捉して、売れ筋や「関連アイテム」呼び出しに
フォールバックしてください。[Serving API リファレンス](/ja/docs/serving-api)にあるとおり、
`UNKNOWN_USER` はサーバーエラーではなく、クライアント側で扱うべき想定内の結果です。
:::

ユーザーを必要としないアイテム間レコメンド（商品ページの「あわせて見られている商品」
など）には、シード商品 ID を渡して `:recommend-related` を呼び出します。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/product_recs:recommend-related \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["SKU-4821"], "limit": 5}'
```

各動詞（オフラインでレコメンドを事前計算するバッチエンドポイントを含む）の
リクエスト・レスポンス仕様は、[Serving API リファレンス](/ja/docs/serving-api)に
すべて記載されています。

## 鮮度を保つ

クエリが `CURRENT_DATE()` で自身のローリングウィンドウを計算するため、最新イベントを
取り込むにはスケジュール（毎晩の cron ジョブや Kubernetes CronJob）で `recotem train` を
再実行するだけで済みます。実行のたびに新しい `append_sha` アーティファクトが書かれて
ポインタファイルが更新され、稼働中のサーバーは次の監視インターバルでそれをアトミックに
ホットスワップします。再起動もリクエストの取りこぼしもありません。

## 次のステップ

- [BigQuery ソースリファレンス](/ja/docs/data-sources/bigquery) — パラメータバインド、
  Storage Read API、コンテンツサイト向けの `page_location` からのアイテム抽出。
- [購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) — GA4 の代わりに EC の
  注文 CSV から同じモデルを作ります。
- [アプリにレコメンド API を追加](/ja/learn/use-cases/recommendation-api) — 配信層の
  認証・デプロイ・バージョニング。
- [AWS Personalize の代替](/ja/learn/compare/aws-personalize-alternative) — この
  セルフホスト方式をマネージドサービスと比較します。
- [Recotem を学ぶ](/ja/learn/) — すべてのユースケース・比較ガイド。
