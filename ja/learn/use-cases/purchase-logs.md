---
title: 購買ログからレコメンド（ECサイト）
description: 購買ログ レコメンドを Recotem で構築。ECサイトの注文履歴 CSV から、IALS や RP3beta を使って「この商品を買った人はこれも」レコメンド API を作ります。
---

# 購買ログからレコメンド（ECサイト）

オンラインストアを運営しているなら、すでに手元にある最も価値のあるレコメンド
シグナルは **購買履歴** です。完了した注文の一つ一つが「この顧客はこの商品を
欲しかった」という暗黙の投票です。Recotem は、その注文ログ — 誰が何を買ったか
を記録した単純な CSV — を、そのままレコメンド API に変換します。マネージド
SaaS もデータサイエンスチームも用意せずに、「この商品を買った人はこれも…」、
トップページのパーソナライズ枠、購入後のクロスセルを実現できます。

このページは EC 向けのウォークスルーです。まずは公開データセットに対して実際の
コマンドを動かしてみたい場合は、[公式チュートリアル](/ja/guide/tutorial/) を
先に進めてください。ホスティング済みのサンプル購買ログを使い、約 10 分で
モデルの配信まで到達できます。**自社の** エクスポート済み注文データに Recotem
を向け、EC データで効いてくるクレンジングやアルゴリズム選択を理解したくなったら、
このページに戻ってきてください。

## 必要なもの

- **インストール済みの Recotem**（`pip install recotem`）または Docker
  イメージ。加えて署名鍵と API キー。両者の `recotem keygen` は
  [チュートリアル](/ja/guide/tutorial/) で解説しています。
- **購買ログの CSV エクスポート**。1 行あたり少なくとも顧客識別子と商品識別子を
  含むもの。ほとんどの注文テーブルや `SELECT` エクスポートには最初から揃って
  います。
- GPU もクラスタも不要です。商品数が数万件規模のストアでも、ノート PC や小さな
  VM 1 台で学習できます。

::: tip データがすでにデータウェアハウスにある場合
注文データがフラットファイルではなく BigQuery や SQL データベースにある場合、
CSV をエクスポートする必要はまったくありません。
[GA4 × BigQuery](/ja/learn/use-cases/ga4-bigquery) を参照するか、SQL ソースを
注文テーブルに向けてください。以降のレシピはそれ以外は同一です。
:::

## 購買ログを CSV として整える

Recotem の [CSV ソース](/ja/docs/data-sources/csv) は、pandas 経由でテーブル
形式のファイルを読み込みます。購買ログでは、購入された明細 1 件を 1 行とするのが
自然な形です。

```csv
user_id,item_id,timestamp,quantity
c-1001,sku-8843,2026-05-01T09:12:00Z,1
c-1001,sku-2290,2026-05-01T09:12:00Z,2
c-2087,sku-8843,2026-05-02T18:40:00Z,1
c-2087,sku-0142,2026-05-03T11:05:00Z,1
c-3120,sku-2290,2026-05-03T20:15:00Z,3
```

| カラム | 役割 | 備考 |
|--------|------|------|
| `user_id` | 顧客識別子 | CRM の顧客 ID、アカウント ID、または安定した仮名 ID。`schema.user_column` でマッピングします。 |
| `item_id` | 商品識別子 | SKU、商品 ID、またはバリアント ID。`schema.item_column` でマッピングします。 |
| `timestamp` | 購入日時 | 時系列での学習/評価分割にのみ使用します（下記参照）。ランダム分割にする場合は省略可能です。 |
| `quantity` | 購入数量 | 説明用の例に過ぎません。Recotem は **暗黙的フィードバック**（購入が存在したという事実）をモデル化するため、数量は重みとして使われません。ファイルに残しておいても問題なく、単に無視されます。 |

Recotem は（顧客, 商品）のペアをすべて正のシグナルとして扱います。評価点、星、
明示的なスコアは不要です。注文が発生したという事実そのものがシグナルです。

::: tip 文字列 ID と数値 ID
SKU や顧客 ID は識別子であって数値ではありません。ソースに
`dtype: {user_id: str, item_id: str}` を指定して、pandas が `0042` を暗黙的に
`42` へ変換しないようにしてください。
[CSV ソースの dtype に関する注意](/ja/docs/data-sources/csv#dtype-の上書き)
を参照してください。
:::

## 学習前にデータをクレンジングする

EC のログは乱雑です。リピート購入、返品が再挿入された行、ID が null のゲスト
購入などが混在します。`cleansing` ブロックは、モデルにデータを渡す前に品質を
ゲートします。各フィールドは
[レシピリファレンス](/ja/docs/recipe-reference#cleansing) にすべて記載されて
います。

- **`dedup: keep_last`** は重複した（顧客, 商品）ペアをまとめ、同じ SKU を
  5 回買った顧客を 1 回として数えます。暗黙的フィードバックでは通常これが
  望ましい挙動です。そうしないと、大量のリピート購入がシグナルを支配して
  しまいます。上流ですでに重複排除している場合のみ `none` を使ってください。
- **`drop_null_ids: true`**（デフォルト）は、顧客 ID または商品 ID が欠損した
  ゲスト購入の行を除去します。
- **`min_rows` / `min_users` / `min_items`** は前提条件です。クレンジング後の
  行数・ユーザー数・商品数がしきい値を下回ると、貧弱なモデルを生成する代わりに
  `min_data_violation` エラーで学習が終了します。自社のカタログにとって健全な
  学習セットを反映する値を設定してください。

::: warning 重複排除は時刻でソートしない
`keep_first` / `keep_last` は `timestamp` カラムではなく、ファイル内の行順を
使います。「最新の購入を残す」ことが重要なら、学習前に CSV を timestamp で
ソートしてください。[dedup に関する注意](/ja/docs/recipe-reference#cleansing)
を参照してください。
:::

## レシピを書く

1 つのレシピ = 1 つのモデル = 1 つの `/v1/recipes/{name}:recommend`
エンドポイントです。次の内容を `recipes/purchase_history.yaml` として保存します。

```yaml
name: purchase_history

source:
  type: csv
  path: ./data/purchase_log.csv
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id
  time_column: timestamp

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 5000
  min_users: 200
  min_items: 100

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42

output:
  path: ./artifacts/purchase_history.recotem
  versioning: append_sha
```

購買データでこの構成を選ぶ理由:

- **`algorithms: [IALS, RP3beta, TopPop]`** はすべて暗黙的フィードバックの
  モデルです。**IALS**（implicit alternating least squares）は購買データに
  対する強力な行列分解のベースラインです。**RP3beta** はグラフ / ランダム
  ウォーク系のモデルで、「一緒に買われる」共起パターンで優れた結果を出すことが
  よくあります。**TopPop** は人気度によるベースラインで、探索が常に妥当な
  フォールバックを持てるようにします。Optuna が各アルゴリズムを試し、最良の
  スコアのものを残します。アルゴリズムの一覧は
  [レシピリファレンス](/ja/docs/recipe-reference#training) にあります。
- **`split.scheme: time_user`** は各顧客の最新の購入を評価用に取り置きます。
  これは本番での使われ方（*次の* 注文を予測する）を反映しています。この分割
  には `schema.time_column` が必要なため、上のレシピで `timestamp` を
  マッピングしています。
- **`metric: ndcg`** と `cutoff: 20` は 20 件のレコメンドリストを評価します。
  ストアフロントの枠やレコメンドページに妥当なサイズです。

::: tip 数値（Unix エポック）の timestamp
`timestamp` カラムが ISO 文字列ではなく整数の Unix 時刻の場合は、`schema` の
下に `time_unit`（`s` / `ms` / `us` / `ns`）を追加して、Recotem が正しく解釈
できるようにしてください。`2026-05-01T09:12:00Z` のような ISO 8601 文字列には
`time_unit` は不要です。
:::

## 学習して配信する

レシピからモデルを学習します。

```bash
recotem train recipes/purchase_history.yaml
```

Recotem は CSV を読み込み、クレンジングし、3 つのアルゴリズムにわたる Optuna
探索を実行して、署名済みアーティファクトを `./artifacts/` に書き出します。
続いて、レシピのディレクトリを配信します。

```bash
recotem serve --recipes ./recipes/
```

サーバーはアーティファクトを読み込んで HMAC 検証を行い、
`/v1/recipes/purchase_history:recommend` エンドポイント（および related /
batch 系の動詞）を登録します。準備完了を確認します。

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

## 特定の顧客へのレコメンドを取得する

特定の顧客が次に何を買いそうかを、
[`:recommend` エンドポイント](/ja/docs/serving-api#post-v1-recipes-name-recommend)
でモデルに尋ねます。`user_id` は学習時に登場したものである必要があります。
`exclude_items` は、顧客がすでに所有している商品を隠すのに便利です。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_history:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "c-1001", "limit": 10, "exclude_items": ["sku-8843"]}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_history",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "sku-0142", "score": 0.91},
    {"item_id": "sku-2290", "score": 0.84}
  ]
}
```

::: tip 新規顧客は 404 を返す
学習データに存在しなかった初回の顧客は `404 UNKNOWN_USER` を返します。これは
サーバーエラーではなく想定された挙動です。アプリケーション側で人気商品に
フォールバックする（あるいは閲覧中の商品をシードにした `:recommend-related`
呼び出しにする）とよいでしょう。
[Serving API の注意](/ja/docs/serving-api#post-v1-recipes-name-recommend)
を参照してください。
:::

## 「この商品を買った人はこれも」— 関連商品

EC の定番ウィジェット「この商品を買った人はこれも…」には、既知の顧客はまったく
必要ありません。これは **アイテム間（item-to-item）** のクエリです。現在の
ページの商品を与えると、関連する商品を返します。1 つ以上のシード SKU を指定して
[`:recommend-related`](/ja/docs/serving-api#post-v1-recipes-name-recommend-related)
を使います。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_history:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["sku-8843"], "limit": 5}' | jq .
```

レスポンスは `:recommend` と同じ形で、共起購入の親和度でランク付けされます。
顧客の履歴ではなく閲覧中の商品を入力とするため、匿名ユーザーや初回訪問者にも
機能します — まさに `:recommend` が `UNKNOWN_USER` を返すケースです。

## 商品名やカテゴリを付与する（任意）

デフォルトでは API は `item_id` と `score` を返します。人間が読めるフィールド
— 商品名、カテゴリ、画像 URL — を返すには、カタログファイルを指す
[`item_metadata`](/ja/docs/recipe-reference#item-metadata) ブロックを追加します。

```yaml
item_metadata:
  type: csv
  path: ./data/products.csv
  item_id_column: sku      # products.csv 内で SKU を保持するカラム
  fields: [title, category, image_url]
  on_field_missing: error
```

指定した `fields` のみがレコメンドレスポンスに結合されるため、各アイテムは
`{"item_id": "sku-0142", "score": 0.91, "title": "…", "category": "…"}` の形で
返ります。カタログのキー列が `item_id` 以外の名前（ここでは `sku`）の場合は
`item_id_column` を使ってください。

## 次のステップ

- [CSV / Parquet ソース](/ja/docs/data-sources/csv) — データソースの全
  フィールド、パススキーム、エンコーディングオプション。
- [レシピリファレンス](/ja/docs/recipe-reference) — クレンジング、分割、
  チューニングのフィールドレベルの完全なドキュメント。
- [Serving API](/ja/docs/serving-api) — モデルを大規模に問い合わせるための
  全エンドポイント、認証、バッチ動詞。
- [チュートリアル](/ja/guide/tutorial/) — 同じ流れをホスティング済みのサンプル
  データセットで一気通貫に。
- [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) —
  エクスポートした CSV の代わりに分析イベントから直接構築します。
- [Learn ハブ](/ja/learn/) に戻る。
