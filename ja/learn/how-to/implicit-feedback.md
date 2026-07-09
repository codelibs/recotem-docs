---
title: "暗黙的フィードバックで推薦を作る：ステップバイステップ"
description: Recotem による暗黙的フィードバック推薦のチュートリアル。生のイベントログをインタラクション行に変換し、IALS や RP3beta を選び、学習・配信・評価まで行います。
---

# 暗黙的フィードバックで推薦を作る

推薦のデータの多くは **暗黙的（implicit）** です。クリック、再生、閲覧、
カート追加、購入——誰も星5段階で評価などしていません。ユーザーは単に何かを
*行った* だけで、その一つひとつが好みの静かなシグナルです。本記事は暗黙的
フィードバック推薦のチュートリアルです。生のイベントログから Recotem で
`/v1/recipes/{name}:recommend` エンドポイントを立ち上げるまでを追い、
ランキング指標での評価方法まで示します。

先に概念的な背景——なぜ実務では暗黙的シグナルが主流なのか、明示的評価と
どう違うのか——を知りたい場合は
[暗黙的・明示的フィードバック](/ja/learn/concepts/implicit-explicit-feedback)
を読んでください。本ページはその実践編です。

## 学習における「暗黙的フィードバック」の意味

Recotem は暗黙的フィードバックを **インタラクションの有無** としてモデル化
します。データに現れるすべての `(user, item)` ペアは正のシグナルであり、
それ以外はすべて「未観測」であって「嫌い」ではありません。予測すべき評価値は
なく、モデルはユーザーが次に反応しそうなアイテムを *ランキング* することを
学びます。

この性質は、ワークフロー全体に2つの帰結をもたらします。

- 評価値の列は一切不要です。「ユーザー `u1` がアイテム `i9` に触れた」という
  行があれば十分です。
- 繰り返し回数や数量は重みとして **使われません**。Recotem はクレンジングで
  重複する `(user, item)` ペアをまとめるため、同じ商品を5回買っても、ある曲を
  50回再生しても、1回として数えられます。重要なのは「起きたかどうか」です。

## ステップ1 — 生のイベントログをインタラクション行に変換する

生のイベントログは、推薦器が求める形にはめったになっていません。典型的な
ストリームには多数のイベント種別があり、ユーザー・アイテムのペアごとに複数行が
あり、不要な列も含まれます。

```csv
user_id,track_id,event,ts
u-1001,trk-8843,play,2026-05-01T09:12:00Z
u-1001,trk-8843,skip,2026-05-01T09:13:10Z
u-1001,trk-2290,play,2026-05-01T09:20:00Z
u-1001,trk-2290,like,2026-05-01T09:21:00Z
u-2087,trk-8843,play,2026-05-02T18:40:00Z
u-2087,trk-0142,play,2026-05-03T11:05:00Z
u-3120,trk-2290,impression,2026-05-03T20:10:00Z
```

これをインタラクション行にするには、3つの判断が必要です。

1. **どのイベントを正とみなすか？** 真の意図を表す行動を選びます。`play`
   （あるいは `purchase`、`complete`、`add_to_cart`）は強いシグナルですが、
   単なる `impression` は通常そうではありません。意味のある1種類のイベントに
   絞ることで、ノイズをモデルから遠ざけます。
2. **どの列がユーザー・アイテム・時刻に対応するか？** 推薦器に必要なのは
   ユーザー識別子、アイテム識別子、そして——時系列で評価分割したいなら——
   タイムスタンプだけです。残りは捨てます。
3. **重複をどう扱うか？** 同じユーザーが同じ曲を何度も再生します。事前に集計
   しても *よい* ですが、その必要はありません。Recotem の `cleansing.dedup` が
   繰り返しの `(user, item)` ペアをまとめてくれます。

`play` イベントに絞り、重要な3列だけを残すと、インタラクション表は次のように
なります。

```csv
user_id,item_id,ts
u-1001,trk-8843,2026-05-01T09:12:00Z
u-1001,trk-2290,2026-05-01T09:20:00Z
u-2087,trk-8843,2026-05-02T18:40:00Z
u-2087,trk-0142,2026-05-03T11:05:00Z
```

この絞り込みは、データをエクスポートするツールなら何で行っても構いません
（`SELECT ... WHERE event = 'play'`、pandas スクリプト、dbt モデルなど）。
イベントがすでにウェアハウスにあるなら、CSV エクスポートを省いてクエリに
やらせることもできます——分析イベントを1本の SQL でインタラクション行に
変える例は [GA4 × BigQuery](/ja/learn/use-cases/ga4-bigquery) を参照してください。
EC の注文ログを端から端まで扱う例は
[購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) にあります。

::: tip ID は文字列のままに
トラック ID、SKU、ユーザー ID は識別子であって数値ではありません。ソースに
`dtype: {user_id: str, item_id: str}` を設定し、pandas が `0042` を `42` に
変えないようにしてください。詳細は
[CSV ソースの dtype 指定](/ja/docs/data-sources/csv) を参照。
:::

## ステップ2 — 暗黙的フィードバック向けアルゴリズムを選ぶ

Recotem は [irspack](https://github.com/tohtsky/irspack) 上で学習し、暗黙的
データ向けに調整された一連のアルゴリズムを提供します。1つに絞る必要はなく、
複数を列挙して Optuna の探索に最良スコアのモデルを選ばせられます。暗黙的な
ワークフローでは、次の3つでたいていの場面をカバーできます。

- **IALS**（implicit alternating least squares）— 暗黙的フィードバック専用に
  設計された行列分解モデル。潜在的なユーザー／アイテム因子を学習し、大きく
  疎なインタラクション行列をうまく扱う、強力な汎用ベースラインです。
- **RP3beta** — ユーザー・アイテムの二部グラフ上を歩くグラフ／ランダムウォーク
  モデル。「共起」パターン（「これを再生した人はこれも再生した…」）に強く、
  学習コストも小さめです。
- **TopPop** — 全員に最も人気のアイテムを推薦します。パーソナライズされません
  が、有用な下限値です。凝ったモデルが自分のデータで人気度に勝てないなら、
  それは知る価値があります。

その他の暗黙的対応アルゴリズム——`CosineKNN`、`DenseSLIM`、`TruncatedSVD`、
`BPRFM`——も利用できます。全一覧とチューニングの仕組みは
[レシピリファレンス](/ja/docs/recipe-reference) にあります。これらが協調
フィルタリングのどの系統に属するかは
[暗黙的・明示的フィードバック](/ja/learn/concepts/implicit-explicit-feedback)
で扱っています。

## ステップ3 — レシピを書く

1つのレシピ = 1つのモデル = 1つの `/v1/recipes/{name}:recommend`
エンドポイントです。これを `recipes/track_plays.yaml` として保存します。

```yaml
name: track_plays

source:
  type: csv
  path: ./data/interactions.csv
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id
  time_column: ts

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
  path: ./artifacts/track_plays.recotem
  versioning: append_sha
```

暗黙的データでこの設定にする理由は次のとおりです。

- **`dedup: keep_last`** は繰り返しの `(user, item)` 再生を1つの正にまとめる
  ので、ヘビーリピーターがシグナルを埋め尽くすのを防ぎます。
- **`algorithms: [IALS, RP3beta, TopPop]`** はいずれも暗黙的フィードバック
  モデルです。Optuna がそれぞれを試し、最良を残します。
- **`split.scheme: time_user`** は各ユーザーの最新のインタラクションを評価用に
  取り置き、本番利用（次に触れるものを予測する）を模します。これには
  `schema.time_column` が必要で、そのために `ts` を割り当てています。信頼できる
  時刻がない場合は `scheme: random` を使い、`time_column` を外します。
- **`metric: ndcg`** と `cutoff: 20` は20件のランキングを評価します——暗黙的
  モデルに正しい系統のランキング指標です（誤差を測る評価値が存在しないため）。
  各フィールドの詳細は [レシピリファレンス](/ja/docs/recipe-reference) に
  あります。

::: warning 重複排除は時刻ではなく行順で行われます
`keep_first` / `keep_last` は `ts` 列ではなく、ファイル内で行が現れる順序で
重複をまとめます。「最新のイベントを残す」ことが重要なら、学習前に CSV を
時刻でソートしてください。詳細は
[クレンジングの注記](/ja/docs/recipe-reference) を参照。
:::

## ステップ4 — 学習する

`recotem train` をレシピに向けて実行します。

```bash
recotem train recipes/track_plays.yaml
```

Recotem は CSV を読み込み、クレンジングのゲートを適用し、`metric: ndcg` の
`cutoff: 20` に対して3つのアルゴリズムを Optuna 探索し、署名付きアーティ
ファクトを `./artifacts/` に書き出します。最良アルゴリズムとその検証スコアは
アーティファクトのヘッダーに記録され、モデルを復元せずに読み取れます。

```bash
recotem inspect ./artifacts/track_plays.recotem
```

## ステップ5 — 配信して `:recommend` を呼ぶ

レシピのディレクトリを配信します。

```bash
recotem serve --recipes ./recipes/
```

サーバーはアーティファクトを読み込んで HMAC 検証し、
`/v1/recipes/track_plays:recommend` エンドポイント（および related・batch の
動詞）を登録します。準備完了を確認します。

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

では、特定のユーザーが次に再生しそうなものを
[`:recommend` エンドポイント](/ja/docs/serving-api) で尋ねます。`user_id` は
学習時に登場したものである必要があります。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/track_plays:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u-1001", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "track_plays",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "trk-0142", "score": 0.91},
    {"item_id": "trk-8843", "score": 0.84}
  ]
}
```

::: tip 未知のユーザーは想定内
学習データに存在しなかったユーザーは `404 UNKNOWN_USER` を返します。これは
サーバーエラーではありません——新規ユーザーにはパーソナライズの履歴がないから
です。人気アイテムにフォールバックするか、ユーザーが今見ているものを種にして
`:recommend-related` でアイテム間の結果を返します。詳細は
[Serving API リファレンス](/ja/docs/serving-api) を参照。
:::

## ステップ6 — ランキング指標で評価する

暗黙的フィードバックには評価値がないため、検索エンジンと同じ方法で評価します。
すなわち「ユーザーが実際にインタラクションしたアイテムが、リストの上位に現れた
か？」を問う **ランキング指標** です。Recotem は学習時にこれを自動で行います。
`split` ブロックが各ユーザーの履歴の一部を取り置き、Optuna の各トライアルが
取り置きアイテムをランキングし、各トライアルはレシピの `metric` を `cutoff` で
採点されます。

- **`ndcg`** — 正規化割引累積利得。関連アイテムをリストの上位に置くことを
  報酬とします。
- **`recall`** — 取り置きアイテムのうち上位 `cutoff` に現れた割合。
- **`map`** — 平均適合率の平均（mean average precision）。
- **`hit`** — 少なくとも1つの関連アイテムが cutoff 内に入ったか。

最良トライアルのスコアはアーティファクトに保存され、API から取得できます。
いつでも取得できます。

```bash
curl -s http://localhost:8080/v1/recipes/track_plays \
  -H "X-API-Key: <plaintext>" | jq '{best_algorithm, metric, cutoff, best_score}'
```

```json
{
  "best_algorithm": "IALSRecommender",
  "metric": "ndcg",
  "cutoff": 20,
  "best_score": 0.1723
}
```

レシピを調整しながら、実行ごとに `best_score` を比較します。`n_trials` を
増やす、アルゴリズムを足し引きする、分割方式を切り替える——そして取り置き
スコアが動くかを見ます。探索に `TopPop` が入っているので、常に人気度の
ベースラインが比較対象として存在します。パーソナライズされたモデルがそれに
勝てなければ、ランキング指標がはっきりと教えてくれます。

::: warning オフラインのスコア ≠ ビジネス指標
`ndcg` が高いのは良い兆候であって、保証ではありません。時系列分割は先読みの
リークを減らしますが、唯一の正解はオンライン A/B テストです。オフライン指標は
候補を安価に *絞り込む* ために使い、勝者は本番で検証してください。
:::

## 次のステップ

- [暗黙的・明示的フィードバック](/ja/learn/concepts/implicit-explicit-feedback)
  — このワークフローの背景にある概念。なぜ暗黙的シグナルが主流で、アルゴリズムと
  指標の選択をどう変えるか。
- [購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) — 同じパターンを
  EC の注文データに端から端まで適用した例。
- [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) — 分析
  イベントを1本の SQL でインタラクションに変換し、CSV エクスポート不要にします。
- [CSV / Parquet ソース](/ja/docs/data-sources/csv) — データソースの全フィールド、
  パススキーム、エンコーディングオプション。
- [レシピリファレンス](/ja/docs/recipe-reference) — クレンジング、分割、
  アルゴリズム、指標のフィールド単位の完全なドキュメント。
- [Learn ハブ](/ja/learn/) に戻る。
