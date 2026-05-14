---
title: レシピの基本
description: Recotem のレシピファイルの各セクションを、注釈付きの例で解説します。
---

# レシピの基本

レシピは 1 つの推薦システムに対応する設定ファイルです。データがどこにあるか、ユーザー ID とアイテム ID はどの列か、どの学習設定を使うか、学習済みモデルをどこに保存するかを Recotem に伝えます。1 つのレシピが 1 つのモデルと 1 つの `/predict/{name}` HTTP エンドポイントを生み出します。

レシピは一度書いたら、スケジュールに従って、データが更新されるたびに、または別の設定を試したいときにいつでも `recotem train` を実行できます。すべてのフィールドには適切なデフォルト値があり、自分のデータに固有の設定だけを記述すれば十分です。

## トップレベルの構造

レシピには 7 つのセクションがあります。

```yaml
name: my_model          # 必須: エンドポイント名
source: ...             # 必須: インタラクションデータの取得元
schema: ...             # 必須: ユーザー ID とアイテム ID の列名
cleansing: ...          # 任意: データ品質のチェック
item_metadata: ...      # 任意: 予測レスポンスに含めるアイテムの追加情報
training: ...           # 必須: 試行するアルゴリズムとトライアル数
output: ...             # 必須: 学習済みモデルファイルの書き出し先
```

---

## `name` — エンドポイント名

`name` の値が URL パスになります: `name: purchase_log` → `/predict/purchase_log`

```yaml
name: purchase_log
```

使用できる文字は英字、数字、ハイフン、アンダースコアのみで、最大 64 文字です。

---

## `source` — データの取得元

このセクションは、インタラクションデータ (どのユーザーがどのアイテムとやり取りしたかのログ。購買、クリック、閲覧、評価など) の場所を Recotem に伝えます。`type` フィールドでデータ形式を指定します。

### CSV または Parquet ファイル

```yaml
source:
  type: csv
  path: ./data/interactions.csv
  dtype:
    user_id: str
    item_id: str
```

`path` にはローカルファイルパス、クラウドストレージ URI (`s3://`、`gs://`、`az://`)、または `https://` URL を指定できます。URL を使う場合は `sha256` 整合性ピンが**必須**です。Recotem はダウンロード後にチェックサムを検証するため、ファイルが密かに破損したり差し替えられたりしても学習に使われることはありません。

```yaml
source:
  type: csv
  path: https://example.com/data/interactions.csv
  sha256: 945fc769205a5976d38c5783500ae473afbb04608043b703951a699993c8f8be
```

Parquet ファイルの場合は `type: csv` を `type: parquet` に変更します。`path` と `sha256` の使い方は同じです。

### BigQuery

```yaml
source:
  type: bigquery
  query: |
    SELECT user_id, item_id, event_timestamp AS ts
    FROM `my-project.dataset.events`
    WHERE DATE(event_timestamp) >= @start_date
  query_parameters:
    start_date: "2026-01-01"
  project: my-gcp-project
```

`pip install "recotem[bigquery]"` が必要です。変化させたい値はクエリ内で `@param` の名前付きプレースホルダーを使用してください。Recotem は SQL 内での環境変数の展開を意図的に行わないため、インジェクション攻撃からクエリを守れます。

---

## `schema` — 列のマッピング

このセクションは、データのどの列名がユーザー、アイテム、(任意で) タイムスタンプを表すかを Recotem に伝えます。これらの名前はソースファイルの列ヘッダーと一致している必要があります。

```yaml
schema:
  user_column: user_id    # 必須
  item_column: item_id    # 必須
  time_column: ts         # training.split.scheme が time_user または time_global の場合のみ必須
```

データでユーザーが `customer_id`、アイテムが `product_sku` と呼ばれている場合は、`user_column: customer_id` と `item_column: product_sku` と記述します。

---

## `cleansing` — データ品質のガードレール

実際のインタラクションログには、重複行、null の ID、品質の低いモデルを静かに生み出してしまうほど少ないデータが含まれていることがよくあります。`cleansing` セクションでは、学習前に問題を検出するチェックを定義できます。

```yaml
cleansing:
  drop_null_ids: true    # user_id または item_id が null の行を除去
  dedup: keep_last       # ユーザーとアイテムの重複ペアは最新の行を残す
  min_rows: 1000         # クレンジング後に 1000 行未満なら学習を中断
  min_users: 50
  min_items: 50
```

いずれかの `min_*` 閾値を下回ると、品質の低いモデルを生成する代わりに、明確なエラーメッセージとともに学習が終了します。これはスケジュールされた再学習で特に重要です。データパイプラインのバグで異常に小さいデータセットが届いた場合、静かに壊れた推薦モデルではなく、障害アラートを受け取るべきです。

---

## `item_metadata` — 予測に含めるアイテムの詳細

`/predict` のレスポンスにアイテムの詳細情報 (タイトル、カテゴリ、画像 URL など) を含めたい場合は、このセクションでメタデータファイルを指定します。`fields` に列挙した列のみが結合されてレスポンスに含まれます。

```yaml
item_metadata:
  type: parquet
  path: s3://my-bucket/items.parquet
  fields: [title, category, image_url]
  on_field_missing: error   # 列挙したフィールドが欠損していればモデル読み込み時にエラー
```

このセクションは任意です。指定しない場合、`/predict` は `item_id` と `score` のみを返します。

---

## `training` — アルゴリズム探索

このセクションでは、どの推薦アルゴリズムを試すか、最適な設定をどこまで探索するかを指定します。Recotem は [Optuna](https://optuna.org/) (ハイパーパラメータ最適化ライブラリ) を使用して、選択したアルゴリズムに対してトライアルを実行し、ホールドアウト検証セットで最もスコアの高いものを選択します。

```yaml
training:
  algorithms: [IALS, CosineKNN, TopPop]
  metric: ndcg
  cutoff: 20
  n_trials: 40
  timeout_seconds: 1800
  split:
    scheme: time_user
    heldout_ratio: 0.1
    seed: 42
```

**選択できるアルゴリズム:**

| 名前 | 内容 |
|---|---|
| `IALS` | 暗黙的フィードバックの行列分解 — 汎用的に強力な選択肢 |
| `CosineKNN` | コサイン距離を使ったアイテムベースの類似度 — 解釈しやすく高速 |
| `TopPop` | 人気ベースライン — 常に最も人気のあるアイテムを推薦 |
| `RP3beta` | グラフベースのランダムウォークアルゴリズム |
| `DenseSLIM` | SLIM アイテム間モデルの Dense バリアント |
| `TruncatedSVD` | 特異値分解による次元削減 |
| `BPRFM` | 因子分解マシンによるベイズ個人化ランキング |

最初から勝者を選ぶ必要はありません。複数の候補を列挙して、トライアル予算 (`n_trials`) の範囲内で Optuna に探索させましょう。`TopPop` を含めると数トライアルしかかからず、より複雑なアルゴリズムが小さなデータセットで苦戦した場合でも動くベースラインが得られます。

**メトリクス** (`ndcg`、`map`、`recall`、`hit`) は「最良」の定義を決めます。NDCG (正規化割引累積利得) がデフォルトで、ランクリストの上位に最も関連性の高いアイテムが来るほど高く評価されます。

**分割スキーム** は検証セットの構築方法を制御します。

- `random` — ホールドアウトするインタラクションをユーザーごとにランダムに選択します。タイムスタンプ列がない場合に使用します。
- `time_user` — ユーザーごとに最新のインタラクションをホールドアウトします。実世界の評価により近い方法です。
- `time_global` — 単一のグローバルな時間カットオフで学習データと検証データを分割します。

---

## `output` — モデルの保存先

```yaml
output:
  path: ./artifacts/my_model.recotem
  versioning: append_sha
```

パスにはローカルパスまたはクラウドストレージ URI (`s3://`、`gs://`、`az://`) を指定できます。`versioning: append_sha` (デフォルト) では、各学習実行でユニークなサフィックスを付けた新しいファイルを書き出し、`path` にあるポインタファイルをアトミックに更新します。配信プロセスはポインタを通じて読み込むため、古いモデルから新しいモデルへの切り替えは常にアトミックです。リクエストが途中の状態を見ることはありません。

---

## 実行前のチェック

フル学習を始める前に任意のレシピに対して `recotem validate` を実行してください。ファイル全体をダウンロードせずにスキーマを検証し、データソースの疎通確認 (URL ベースの CSV の場合は HTTP HEAD リクエストなど) を行います。

```bash
recotem validate my_recipe.yaml
```

フィールドごとの完全なリファレンス (すべてのデフォルト値、制約、エッジケース) については [レシピリファレンス](/docs/recipe-reference)を参照してください。
