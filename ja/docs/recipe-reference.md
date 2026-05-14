---
title: レシピリファレンス
---

# レシピリファレンス

レシピは、取得するデータ、学習方法、アーティファクトの書き出し先を定義する YAML ファイルです。1 つのレシピが 1 つのモデルと 1 つの `/predict/{name}` エンドポイントを生成します。

## トップレベルフィールド

| フィールド | 型 | 必須 | 説明 |
|------------|-----|------|------|
| `name` | string | yes | エンドポイント名。パターン: `^[A-Za-z0-9_-]{1,64}$`。`/predict/{name}` になります。 |
| `source` | object | yes | データソース設定。`type` フィールドが識別子 (`csv`、`parquet`、`bigquery`、またはプラグイン)。バリデーションは 2 段階: まずレシピの残りの部分がパースされ、次にソースの dict がプラグインの `Config` クラスに振り分けられます。そのため `source.*` のエラーは他のフィールドのエラーの*後*に表示されます。不明な `source.type` は登録済みの全型名を列挙した `DataSourceError` を発生させます。 |
| `schema` | object | yes | カラムマッピング。 |
| `cleansing` | object | no | データ品質ゲート。 |
| `item_metadata` | object | no | predict レスポンスに結合するメタデータ。 |
| `training` | object | yes | アルゴリズムとチューニングの設定。 |
| `output` | object | yes | アーティファクトのパスとバージョニング。 |

`name` は YAML ロード時に `^[A-Za-z0-9_-]{1,64}$` 正規表現で検証されます。Recipe pydantic モデルは `validate_assignment=True` を使用しているため、`name` のコンストラクション後の変更は再びバリデーターを実行し、不正な値に対して `ValidationError` を発生させます。ヘルパー `recotem.recipe.models.validate_for_filesystem(name)` は、pydantic を使わずにプログラム的に名前を構築する呼び出し元向けにエクスポートされています。

---

## `source`

### `source.type: csv` (`parquet` も同様)

```yaml
source:
  type: csv
  path: gs://bucket/interactions.csv.gz
  delimiter: ","         # default ","
  encoding: utf-8        # default utf-8
  header: 0              # row index of the header row, default 0
  dtype:                 # optional explicit column dtypes
    user_id: str
    item_id: str
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `path` | string | required | ローカルパス、`file://`、`s3://`、`gs://`、`az://`、`abfs(s)://`、`http://`、または `https://` URI。HTTP/HTTPS には `sha256` 整合性ピンが必要です。[パスルール](#パスルール) および [data-sources/csv](./data-sources/csv#パススキーム) を参照してください。 |
| `delimiter` | string | `","` | pandas の `sep=` にそのまま渡されます。複数文字の区切り文字は pandas の Python パーサー (低速) を使用します。単一文字は C パーサーを使用します。CSV のみ。 |
| `encoding` | string | `"utf-8"` | pandas が受け付けるエンコーディング。 |
| `header` | int | `0` | ヘッダーの行番号。 |
| `dtype` | map | `null` | キー = カラム名、値 = pandas dtype 文字列。 |
| `sha256` | string | 任意 (`path` が `http://` または `https://` の場合は必須) | 64 文字の小文字 hex。取得したバイト列に対して検証され、不一致は `DataSourceError` を発生させます。 |

Parquet ファイルには `type: parquet` を使用します。`path` と (任意の) `sha256` のみ受け付けます。`delimiter`、`encoding`、`header`、`dtype` は Parquet ソースの有効なキーではなく、レシピのロードが失敗します。

### `source.type: bigquery`

```yaml
source:
  type: bigquery
  query: |
    SELECT user_pseudo_id AS user_id, item_id, TIMESTAMP_MICROS(event_timestamp) AS ts
    FROM `proj.analytics_123.events_*`
    WHERE _TABLE_SUFFIX BETWEEN @start_date AND @end_date
  query_parameters:
    start_date: "20260401"
    end_date: "20260507"
  project: my-gcp-project   # optional; falls back to ADC project
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `query` | string | required | SQL。信頼されたコード — 環境変数展開されません。動的な値には `@param` を使用してください。 |
| `query_parameters` | map | `{}` | `@name` プレースホルダーにバインドされる BigQuery 名前付きパラメータ。 |
| `project` | string | `null` | GCP プロジェクト ID。ADC のアンビエントプロジェクトにフォールバックします。 |

エクストラのインストール: `pip install "recotem[bigquery]"`。

`query` や `query_parameters` の内部では環境変数展開は**決して**行われません。SQL インジェクションを防ぐために `@param` プレースホルダーを使用してください。

---

## `schema`

```yaml
schema:
  user_column: user_id    # required
  item_column: item_id    # required
  time_column: ts         # required when split.scheme is time_user or time_global
```

| フィールド | 型 | 必須 | 備考 |
|------------|-----|------|------|
| `user_column` | string | yes | 取得した DataFrame のカラム名。 |
| `item_column` | string | yes | 取得した DataFrame のカラム名。 |
| `time_column` | string | 条件付き | `time_user` および `time_global` 分割スキームで必須。 |
| `time_unit` | string | 条件付き | `time_column` が整数 (数値) 値を含む場合に必須。`s`、`ms`、`us`、`ns` のいずれか。数値時刻カラムでこのフィールドを省略すると `TrainingError` (`code: time_unit_required`) が発生し、Unix タイムスタンプのナノ秒解釈を防ぎます。文字列およびdatetimeカラムはこのフィールドの影響を受けません。 |

---

## `cleansing`

```yaml
cleansing:
  drop_null_ids: true        # default true
  dedup: keep_last           # keep_first | keep_last | none
  min_rows: 1000             # exit 4 with min_data_violation if below
  min_users: 10
  min_items: 10
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `drop_null_ids` | bool | `true` | `user_id` または `item_id` が null の行を除去します。 |
| `dedup` | string | `keep_last` | (user, item) ペアの重複をどう処理するか。 |
| `min_rows` | int | `null` (チェックなし) | クレンジング後の最低行数。 |
| `min_users` | int | `null` (チェックなし) | 最低ユニークユーザー数。 |
| `min_items` | int | `null` (チェックなし) | 最低ユニークアイテム数。 |

いずれかの `min_*` 閾値に違反した場合、終了コード 4 と JSON エラー行の `"code": "min_data_violation"` で終了します。

`dedup` の値:

| 値 | 動作 |
|----|------|
| `keep_first` | (user, item) ペアの最初の出現を残します。 |
| `keep_last` | ソース DataFrame の行順で (user, item) ペアの最後の出現を残します。 |
| `none` | 重複除去なし。 |

`keep_first` / `keep_last` はデータソースが返した行順を使用します。`time_column` でソートは**しません**。時刻順での重複除去が必要な場合は、ソースクエリでソートするか (BigQuery `ORDER BY ts`)、学習前に CSV を事前ソートしてください。

---

## `item_metadata`

```yaml
item_metadata:
  type: parquet            # csv | parquet
  path: gs://bucket/items.parquet
  fields: [title, category, image_url]   # non-empty allow-list
  on_field_missing: error  # error | null (default error)
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `type` | string | required | `csv` または `parquet`。 |
| `path` | string | required | [パスルール](#パスルール) を参照してください。 |
| `fields` | list[string] | required | 空不可。列挙されたフィールドのみ predict レスポンスで返されます。 |
| `on_field_missing` | string | `error` | `fields` に指定したエントリがファイルに存在しない場合の動作。`error` はモデルのロードを失敗させます (起動時はレシピが `loaded=false` と `last_load_error` 付きで登録され、ホットスワップ時は旧モデルが引き続き配信され、障害は `/health` および `recotem_artifact_load_failures_total` メトリクスで公開されます)。`null` はカラムを `null` で埋めます。 |
| `sha256` | string | 任意 (`path` が `http://` または `https://` の場合は必須) | 64 文字の小文字 hex。取得したバイト列に対して検証され、不一致は `DataSourceError` を発生させます。 |
| `item_id_column` | string | `"item_id"` | メタデータファイルでアイテム識別子を保持するカラム名。メタデータファイルが異なるカラム名 (例: `product_id`) を使用している場合に上書きします。空でない、空白でない文字列である必要があります。 |

サーバーサイドのフィールド抑制は `RECOTEM_METADATA_FIELD_DENY` (カンマ区切りのカラム名) でも可能で、結合後のカラム除去として適用されます。

---

## `training`

```yaml
training:
  algorithms: [IALS, CosineKNN, TopPop]    # at least one required
  metric: ndcg                              # ndcg | map | recall | hit
  cutoff: 20
  n_trials: 40
  per_algorithm_trials:                     # optional per-algorithm budget
    IALS: 24
    CosineKNN: 12
    TopPop: 4
  per_trial_timeout_seconds: 600
  timeout_seconds: 1800
  parallelism: 1
  storage_path: ""                          # "" = in-memory Optuna; path = SQLite resume
  split:
    scheme: time_user                       # random | time_global | time_user
    heldout_ratio: 0.1
    test_user_ratio: 1.0
    seed: 42
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `algorithms` | list[string] | required | `IALS`、`CosineKNN` (エイリアス `CosinekNN`)、`TopPop`、`RP3beta`、`DenseSLIM`、`TruncatedSVD`、`BPRFM`。irspack のフルクラス名 (例: `IALSRecommender`) も受け付けます。ハイパーパラメータの範囲は irspack の各レコメンダーの `default_suggest_parameter` から取得され、レシピからは変更できません。 |
| `metric` | string | `ndcg` | `ndcg`、`map`、`recall`、`hit` のいずれか。 |
| `cutoff` | int | `20` | 評価時の推薦リスト長 (1 以上)。 |
| `n_trials` | int | `40` | Optuna の総トライアルバジェット (1 以上)。 |
| `per_algorithm_trials` | map | `null` | アルゴリズムごとのトライアル数の上書き。**明示的な `0` はそのアルゴリズムを無効化します** (探索から完全に除外されます)。このマップで*指定されていない* `algorithms` 内のアルゴリズムは、明示的な値を優先した後の残りバジェットを分割します。明示的な値の合計が `n_trials` を超える場合、正の値は比例してスケールダウンされます (各値は `n_trials` スロットが存在する限り ≥ 1 を維持します。そうでなければ最初の `n_trials` 個の非ゼロクラスが各 1 トライアルを受け取り、残りはスキップされます — 総バジェットが `n_trials` を超えることはありません)。**不明なアルゴリズムキーはレシピロード時に ValidationError で拒否されます** — 各キーは `algorithms` に存在する有効なエイリアスまたはクラス名である必要があります。`parallelism > 1` の場合、進行中の並行トライアルにより実際のアルゴリズムごとのトライアル数が設定バジェットを最大 `parallelism - 1` 超える可能性があります。この条件が適用される実行ごとに警告がログ出力されます。 |
| `per_trial_timeout_seconds` | int | `null` | ソフトなトライアルごとの実時間上限。ワーカースレッドでトライアルを実行することで実装されます。超過した場合、Optuna はトライアルを枝刈りしますが、基底スレッドはデーモン化されて自然に終了するまで継続する可能性があります (CPU/メモリは消費されます)。スタディ終了時にまだ実行中のスレッド数は `train_done` 構造化ログイベントの `n_orphaned` としてレポートされます。オペレーターはこのフィールドを監視して、常にタイムアウトに達するトライアルを検出し、`per_trial_timeout_seconds` または `timeout_seconds` を調整できます。 |
| `timeout_seconds` | int | `null` | チューニング全体の実時間上限。 |
| `parallelism` | int | `1` | Optuna の `n_jobs` (Python スレッド、プロセスではありません)。ホットループが GIL バウンドのアルゴリズムは効果が薄く、ネイティブコードの学習器 (IALS、RP3beta) が最も恩恵を受けます。 |
| `storage_path` | string | `""` | 空 = インメモリ (再開なし)。ベアパスは SQLite URL (`sqlite:///<path>`) になります。明示的な `sqlite://`、`postgresql://`、`postgres://`、`mysql://` URL も受け付けます。スタディ名は `recotem_<recipe_name>_<run_id>` で `load_if_exists=True` のため、`train` 実行ごとの新しい `run_id` は常に新しいスタディを開始します (再開するには同じ `run_id` を再利用する必要があります — `recotem train --run-id <stable>` で渡します)。**NFS 上の SQLite は破損します** — SQLite データベースはローカルファイルシステム上に保持してください。**URL に認証情報を埋め込んではいけません** (`postgresql://user:pass@host/db` は `SearchError` で拒否され、SQLAlchemy のトレースバックから userinfo が漏洩するのを防ぎます)。代わりに `PGPASSFILE` / `~/.pgpass` / SQLAlchemy 環境変数で認証情報を提供してください。 |
| `split.scheme` | string | `random` | `random`、`time_global`、または `time_user`。下記のセマンティクスを参照してください。 |
| `split.heldout_ratio` | float | `0.1` | ホールドアウトするインタラクションの割合。(0, 1) の範囲。 |
| `split.test_user_ratio` | float | `1.0` | テスト分割に含まれるユーザーの割合。(0, 1] の範囲。 |
| `split.seed` | int | `42` | 分割のランダムシード (irspack に `random_state` として渡されます)。 |

分割スキームのセマンティクス:

- `random` — インタラクションをユーザーごとに均一にランダムにホールドアウトします。`time_column` は使用しません。
- `time_user` — 各ユーザーについて、`time_column` でランク付けされたそのユーザーのインタラクションの最新 `heldout_ratio` をホールドアウトします。カットオフはユーザーごとに計算されます。
- `time_global` — データセット全体の `time_column` の `1 - heldout_ratio` 分位数での単一グローバルカットオフ。カットオフ以降のすべてのインタラクションはユーザーに関わらずホールドアウトされます。カットオフ後のインタラクションがないユーザーは学習のみになります。

`time_user` および `time_global` には `schema.time_column` が必要です。これらのスキームで `time_column` が欠落している場合はレシピバリデーションエラーとなり、終了コード 2 で終了します。

探索で完了したトライアルが 0 件の場合、学習は終了コード 4 と `"code": "no_completed_trials"` で終了します。完了したトライアルが全てスコア 0.0 の場合は終了コード 4 と `"code": "zero_score"` で終了します (`per_trial_timeout_seconds` が短すぎるか、バリデーションセットが小さすぎる場合に典型的に発生します)。

---

## `output`

```yaml
output:
  path: ./artifacts/news_articles.recotem
  versioning: append_sha     # always_overwrite | append_sha (default append_sha)
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `path` | string | required | アーティファクトの出力先。[パスルール](#パスルール) を参照してください。 |
| `versioning` | string | `append_sha` | アーティファクトの書き出し方法。 |

`versioning` モード:

| モード | 動作 |
|--------|------|
| `always_overwrite` | `<path>` に直接書き込みます。 |
| `append_sha` | `<path>.<sha8>.recotem` に書き込み、`<path>` のポインタファイルをアトミックに更新します。サーバーはポインタを経由して読み込みます。 |

---

## パスルール

`output.path`、`source.path`、`item_metadata.path` に適用されます。

`source.path` および `item_metadata.path` のパススキームは明示的な許可リストに限定されます: ベアローカルパス (スキームプレフィックスなし)、`file://`、`s3://`、`gs://`、`az://`、`abfs://`、`abfss://`、`http://`、`https://`。fsspec のフルレジストリに依存する代わりにスキームを明示的に列挙することで、レシピの内容を経由して未審査のハンドラーにアクセスされることを防ぎます。チェーンされた fsspec プロトコル (`::` を含むパス) も拒否されます。`http://` および `https://` スキームは、同じ設定ブロックに `sha256` 整合性ピンが必要です。

> **展開後サイズの上限は強制されません。** `RECOTEM_MAX_DOWNLOAD_BYTES` が上限とするのは生の I/O バイト数のみです。圧縮された CSV および columnar Parquet ソースは解凍後に生サイズの数倍に膨らむ可能性があり、生成される DataFrame はサイズ制限されません。影響を抑えるには `recotem train` を cgroup または Kubernetes Pod (メモリ制限付き) 内で実行してください。[security — Decompressed-size cap not enforced](./security#decompressed-size-cap-not-enforced-medium-5) を参照してください。

`output.path` は以下のスキームに限定されます: ベアローカルパス (プレフィックスなし)、`file://`、`s3://`、`gs://`、`az://`、`abfs://`、`abfss://`。その他のスキームは拒否されます: `http://`、`https://`、`ftp://`、`ftps://` はこれらのプロトコルでアーティファクトの書き込みがサポートされていないため。`memory://` はプロセスローカルであり学習実行後に存続しないため。

埋め込まれた認証情報 (`s3://AKIA...:secret@bucket/`) はすべてのパスフィールドでレシピロード時に拒否されます。

ローカルパスは絶対パスに解決されます。`RECOTEM_ARTIFACT_ROOT` が設定されている場合、`output.path` は `realpath` 解決後にその配下のパスに解決される必要があります (シンボリックリンクによるエスケープは拒否されます)。

---

## 環境変数展開

構文: `${RECOTEM_RECIPE_VAR}`。プレフィックス `RECOTEM_RECIPE_*` に一致する変数のみ展開されます。マッチングは大文字小文字を区別しません (大文字に変換された名前がプレフィックスとブラックリストに対してチェックされます)。`recotem train --env-var KEY=VALUE` (繰り返し指定可能) を使用して、シェル環境にエクスポートせずに追加の値を注入できます。`KEY` は `RECOTEM_RECIPE_` で始まり、ブラックリストチェックをパスする必要があります。例: `recotem train recipe.yaml --env-var RECOTEM_RECIPE_DATE=20260501`。

ブラックリスト (プレフィックスに関わらず展開されない): 正確な名前 `RECOTEM_SIGNING_KEYS` および `RECOTEM_API_KEYS`。`AWS_`、`GCP_`、`GOOGLE_`、`AZURE_` で始まる名前。`SECRET`、`PASSWORD`、`PASSWD`、`TOKEN`、`KEY`、`AUTH`、`BEARER`、`CRED`、`PRIVATE` という部分文字列を含む名前 (全て大文字小文字を区別しない比較)。

`*KEY*` の部分文字列マッチは意図的に広く取られています — 大文字に変換した名前に部分文字列 `KEY` (アンダースコアの境界なし) が含まれる変数は拒否されます。これには `RECOTEM_RECIPE_PARTITION_KEY`、`RECOTEM_RECIPE_APIKEY`、`RECOTEM_RECIPE_KEYBOARD` が含まれます。`KEY` を含まない名前を使用してください (例: `RECOTEM_RECIPE_PARTITION_COLUMN`)。

展開は `query` または `query_parameters` という名前のキーの内部では、ネストの深さに関わらず (つまり `source` 配下だけでなく) **決して**行われません。`source.path`、`output.path`、`item_metadata.path` を含む他のすべての文字列は展開されます。

::: warning プレフィックスとブラックリストの相互作用
`RECOTEM_RECIPE_` プレフィックスチェックは変数名全体に適用されます。ブラックリストの部分文字列ルールは (`RECOTEM_RECIPE_` の後の) *テール*部分にのみ適用されます。例えば `RECOTEM_RECIPE_GCP_PROJECT` はプレフィックスチェックをパスします。`GCP_*` ブラックリストプレフィックスルールはブロックしません。そのルールは大文字に変換した形式が `GCP_` で始まる名前にのみ一致するためです (例: `GCP_SOMETHING`)。変数 `RECOTEM_RECIPE_GCP_PROJECT` は `RECOTEM_RECIPE_` で始まり、`GCP_` では始まりません。`examples/ga4-bigquery/` レシピはこのパターンを正当に使用しています。ただし、名前に `KEY`、`TOKEN`、`SECRET`、または他のブラックリストの部分文字列 (大文字小文字を区別しない) が含まれている場合は**ブロックされます**。
:::

展開は 1 パスで YAML ロード時に 1 回実行されます。エスケープ構文はありません (YAML 内のリテラル `${...}` は変数名がプレフィックスチェックに失敗しない限り保存できません。失敗するとエラーになります)。デフォルト値構文はサポートされていません (`${VAR:-default}` はサポートされておらず、リテラル名 `VAR:-default` を展開しようとします)。展開された値はさらなる `${...}` 参照の再スキャンは行いません。

欠落、不正な形式、またはブラックリストに載っている変数は `RecipeError` (終了コード 2) を発生させます。エラーメッセージには変数名が含まれますが、その値は含まれません。

### レシピディレクトリのロード

`recotem serve --recipes <dir>` および `load_recipes_directory()` は `<dir>` の直下の `*.yaml` ファイルのみを列挙します (再帰なし)。サブディレクトリは無視されます。各レシピファイルは `realpath` 解決後にディレクトリ内に留まる必要があります — 外部を指すシンボリックリンクは拒否されます。

`name` フィールドの重複処理は呼び出し元によって異なります:

- **`recotem train` / `load_recipes_directory()` (厳格)**: 2 つのファイル間で `name` が重複すると即座に `RecipeError` が発生し、ロード全体が中断されます。
- **`recotem serve` / `load_recipes_directory_lenient()` (寛容)**: 最初にロードされたファイルが優先され、同じ `name` を持つ後続のファイルはスキップされ、`recipe_duplicate_name_skipped` 警告が構造化ログに出力されます。配信プロセスは残ったレシピで継続します。

---

## 完全な例

```yaml
name: news_articles

source:
  type: bigquery
  query: |
    SELECT user_pseudo_id AS user_id,
           (SELECT value.int_value FROM UNNEST(event_params) WHERE key='article_id') AS item_id,
           TIMESTAMP_MICROS(event_timestamp) AS ts
    FROM   `proj.analytics_123.events_*`
    WHERE  _TABLE_SUFFIX BETWEEN @start_date AND @end_date
      AND  event_name = 'select_content'
  query_parameters:
    start_date: "20260401"
    end_date: "20260507"
  project: my-gcp-project

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

item_metadata:
  type: parquet
  path: gs://my-bucket/items.parquet
  fields: [title, category]
  on_field_missing: error

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

output:
  path: gs://my-bucket/artifacts/news_articles.recotem
  versioning: append_sha
```
