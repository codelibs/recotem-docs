---
title: レシピリファレンス
description: "Recotem のレシピ YAML 全フィールドのリファレンス。データソース、スキーマ、クレンジング、学習、出力の設定項目と型・デフォルト・バリデーションを網羅します。"
---

# レシピリファレンス

レシピは、取得するデータ、学習方法、アーティファクトの書き出し先を定義する YAML ファイルです。1 つのレシピが 1 つのモデルと `/v1/recipes/{name}:recommend` (および関連) エンドポイント群を生成します。

## トップレベルフィールド

| フィールド | 型 | 必須 | 説明 |
|------------|-----|------|------|
| `name` | string | yes | エンドポイント名。パターン: `^[A-Za-z0-9_-]{1,64}$`。`/v1/recipes/{name}:recommend` などのエンドポイントパスで使用されます。 |
| `source` | object | yes | データソース設定。`type` フィールドが識別子 (`csv`、`parquet`、`bigquery`、`sql`、またはプラグイン)。バリデーションは 2 段階: まずレシピの残りの部分がパースされ、次にソースの dict がプラグインの `Config` クラスに振り分けられます。そのため `source.*` のエラーは他のフィールドのエラーの*後*に表示されます。不明な `source.type` は登録済みの全型名を列挙した `DataSourceError` を発生させます。 |
| `schema` | object | yes | カラムマッピング。 |
| `cleansing` | object | no | データ品質ゲート。 |
| `item_metadata` | object | no | 推薦レスポンスに結合するメタデータ。 |
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

### `source.type: sql`

```yaml
source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, item_id, ts
    FROM events
    WHERE ts >= :since
  query_parameters:
    since: "2026-04-01"
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `dsn_env` | string | required | DSN を保持する環境変数の名前。`^RECOTEM_RECIPE_[A-Z0-9_]+$` に一致する必要があります。DSN 自体はレシピに書き込まれません。環境変数展開の対象外 — このフィールドは変数の*名前*を保持するものであり、値ではありません。 |
| `query` | string | required | 生の SQL。信頼されたコード — 環境変数展開されません。動的な値には `:name` を使用してください。 |
| `query_parameters` | map | `{}` | SQLAlchemy の `text().bindparams(...)` 経由でバインドされる名前付きパラメータ。値は書いたとおりに使われます — 環境変数展開されません。型は `str`、`int`、`float`、`bool`。 |
| `connect_timeout_seconds` | int | `10` | 有効範囲 `[1, 60]`。 |
| `statement_timeout_seconds` | int | `300` | 有効範囲 `[1, 1800]`。ダイアレクトごとの実装は [SQL ソース](./data-sources/sql#ステートメントタイムアウト) を参照してください。 |

エクストラを 1 つインストール: `pip install "recotem[postgres]"`、`recotem[mysql]`、または `recotem[sqlite]`。詳細リファレンス: [SQL ソース](./data-sources/sql)。

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
| `none` | 重複除去なし — すべての行が残ります。ただしどちらにせよインタラクション行列は**バイナリ**のままです。重複する `(user, item)` ペアはモデル構築時に 1 つの `1` にまとめられ、これは探索でも最終リフィットでも同じです。したがって `none` が変えるのはスキャンされる行数と `data_stats.n_rows` の値であって、モデルが何で学習されるかではありません。繰り返しのインタラクションに重みを持たせたい場合は、ソースクエリ側で集計し、`user_column` / `item_column` として使わない列に入れてください。recotem には信頼度重み付けの設定はありません。 |

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
| `fields` | list[string] | required | 空不可。列挙されたフィールドのみ推薦レスポンスで返されます。 |
| `on_field_missing` | string | `error` | `fields` に指定したエントリがファイルに存在しない場合の動作。`error` はモデルのロードを失敗させます (起動時はレシピが `loaded=false` と `last_load_error` 付きで登録され、ホットスワップ時は旧モデルが引き続き配信され、障害は `/v1/health` および `recotem_artifact_load_failures_total` メトリクスで公開されます)。`null` はカラムを `null` で埋めます。 |
| `sha256` | string | 任意 (`path` が `http://` または `https://` の場合は必須) | 64 文字の小文字 hex。取得したバイト列に対して検証され、不一致は `DataSourceError` を発生させます。 |
| `item_id_column` | string | `"item_id"` | メタデータファイルでアイテム識別子を保持するカラム名。メタデータファイルが異なるカラム名 (例: `product_id`) を使用している場合に上書きします。空でない、空白でない文字列である必要があります。 |

サーバーサイドのフィールド抑制は `RECOTEM_METADATA_FIELD_DENY` (カンマ区切りのカラム名) でも可能です。指定されたカラムはメタデータインデックスのロード時に除外されるため、どの推薦エンドポイントのレスポンスにも含まれません。

---

## `features`

```yaml
features:
  item:
    source:                                    # datasource discriminated union — same registry as `source`
      type: bigquery
      query: SELECT item_id, genres, release_year, country FROM items
    id_column: item_id
    columns:
      - {name: genres,       encoding: multi_label, delimiter: "|"}
      - {name: release_year, encoding: numerical}
      - {name: country,      encoding: categorical, min_frequency: 5}
  user:
    source: {type: csv, path: ./users.csv}
    id_column: user_id
    columns:
      - {name: age_band, encoding: categorical}
```

このブロックが存在するだけでフィーチャーアウェア iALS の学習が有効になります。別途フラグを立てる必要はありません。アイテム側とユーザー側のフィーチャーが宣言され、エンコードされ、Optuna 探索と最終リフィットの両方で `IALSRecommender` に渡され、さらに永続化されます。これにより `:recommend` / `:recommend-related` は未知のユーザーや未知のシードアイテムを属性だけからスコアリングできます。サービング側の契約については [サービング API — フィーチャーアウェアなコールドスタート](./serving-api#フィーチャーアウェアなコールドスタート) を参照してください。

| フィールド | 型 | 必須 | 備考 |
|-------|------|----------|-------|
| `features.item` | object | 条件付き | アイテム側のフィーチャーテーブル。`features.item` / `features.user` の少なくとも一方が必要です。 |
| `features.user` | object | 条件付き | ユーザー側のフィーチャーテーブル。 |

各サイド (`FeatureSideConfig`) のフィールド:

| フィールド | 型 | 必須 | 備考 |
|-------|------|----------|-------|
| `source` | object | yes | トップレベルの `source` と同じデータソースの判別可能ユニオン (`csv`、`parquet`、`bigquery`、`sql`、または任意のプラグイン)。データソースレジストリをそのまま再利用します。`FetchContext` はインタラクション固有のフィールドを持たないため、登録済みのどのソースでもフィーチャーテーブルとして利用できます。 |
| `id_column` | string | yes | 取得したテーブルでエンティティ ID を保持するカラム (`features.item` ならアイテム ID、`features.user` ならユーザー ID)。空でない、空白でない文字列である必要があります。同じサイドの `columns` に**含めてはいけません** — ID カラムはインデックスとして消費されるため、フィーチャーを兼ねることはできません。 |
| `columns` | list | yes、空不可 | エンコードするソースカラムごとに 1 エントリ。カラム名はサイド内で一意である必要があります。 |

ボキャブラリを構築する前に、NULL および重複した ID の行は除外されます。`id_column` が NULL または空の行は除外され、`feature_table_null_ids_dropped` (`side`、`drop_count`) としてログに記録されます。`id_column` が既出の ID と重複する行も除外され (**最初**の出現が残ります。`keep="first"`)、`feature_table_duplicate_ids_dropped` (`side`、`drop_count`) としてログに記録されます。どちらのログ行も件数のみを持ち、該当する ID やカラム値は決して出力しません。これらはユーザーの PII として扱われます。

`columns` の各エントリ (`FeatureColumn`):

| フィールド | 型 | 必須 | デフォルト | 備考 |
|-------|------|----------|---------|-------|
| `name` | string | yes | — | 取得したフィーチャーテーブルのカラム名。 |
| `encoding` | string | yes | — | `categorical`、`numerical`、`multi_label` のいずれか。 |
| `delimiter` | string | 条件付き | `"\|"` | `encoding: multi_label` の場合のみ有効。それ以外のエンコーディングでは拒否されます。空文字列は不可。 |
| `min_frequency` | int | no | `1` | `>= 1` である必要があります — `min_frequency: 0` はスキーマ検証時に拒否されます。上限はありません。`categorical` / `multi_label` (ボキャブラリベースのエンコーディング) でのみ有効で、`numerical` では拒否されます。取得したフィーチャーテーブル内での出現回数が N 未満の値はボキャブラリから除外されます。`categorical` では行数のカウント (1 行につき 1 値)、`multi_label` ではトークンの**出現回数**のカウントです — `a\|a` を持つ 1 行はしきい値に対して 2 を寄与します。 |

### ID は文字列で照合され、一致ゼロは致命的

`id_column` の値はインタラクションデータの `schema.item_column` / `schema.user_column` と**文字列として**照合されます。両側とも比較前に `str()` で正規化されます。したがって `1` は `"1"` に一致しますが、`1.0` は `"1"` に一致**しません**。

フィーチャーテーブルに存在しないインタラクション ID はエラーではありません。そのエンティティは暗黙のバイアスカラムのみにエンコードされ、そのエンティティに限り通常の iALS に劣化します。部分的なカバレッジは想定内で正当です — ボキャブラリが取得したテーブル全体から構築されるのは、まさにインタラクションデータに存在しないエンティティをコールドスタートスコアリングで表現可能に保つためです。

::: danger 一致ゼロは学習を中断します
一致が**ゼロ**の場合は話が別で、`TrainingError` (`feature_axis_error`、終了コード 4) で学習を中断します。1 件の ID も一致しなければ、すべてのエンティティがバイアスのみにエンコードされます。それでも実行は成功してしまい、実体は通常の iALS でありながらヘッダーが `features` を宣言するアーティファクトに署名することになります — サイレントな劣化です。エラーメッセージは両側から ID をサンプリングするため、不一致が目で見て分かります。
:::

原因はほぼ次の 2 つに集約されます。

- **ID の dtype 不一致**: 整数の ID カラムに 1 つでも空セルがあると pandas は `float64` と推論するため、`1` が `1.0` として読み込まれます。データを整形するのではなくソース側で型を固定してください — `csv` ソースなら `dtype: {item_id: str}` (`dtype` は csv 専用です。`bigquery` / `sql` ではクエリ側でキャストしてください)。Recotem は型を自動的に強制変換しません。`1.0` と読めるカラムは、ID が文字どおり `"1.0"` であるカラムと区別できないため、変換すれば正当な ID を黙って書き換えてしまう危険があります。
- **存在はするが誤ったカラムを指す `id_column`**: フェッチ時の存在チェックは通過し、エンコード時に初めて失敗します。

カバレッジはサイドごと・フェーズごとに `feature_axis_coverage` (`side`、`matched`、`total`) としてログに記録されます。[オペレーション — recotem train が feature_axis_error で終了コード 4 で終了する](./operations#recotem-train-が-feature-axis-error-で終了コード-4-で終了する) を参照してください。

### エンコーディングと欠損・未知値の挙動

| エンコーディング | 挙動 | 行そのものが欠損 | 値が欠損・未知 |
|---|---|---|---|
| `categorical` | 学習時ボキャブラリに対する one-hot。 | 全ゼロのセグメント。 | 全ゼロのセグメント。 |
| `numerical` | 学習時の平均/標準偏差で標準化。 | `0` (すなわち平均)。 | `0` (すなわち平均)。 |
| `multi_label` | `delimiter` で分割し multi-hot。 | 全ゼロのセグメント。 | 既知のトークンは保持され、未知のトークンは破棄されます。 |

`multi_label` の違いは重要です。`Action` が既知のとき `genres: "Action|Zzz"` は `Action=1` となり `Zzz` は破棄されます — 全ゼロのセグメントにはなりません。「行が欠損」と「値が未知」が一致するのは `categorical` の場合だけです。

::: warning 数値に見える属性カラムはソース側で文字列として宣言してください
上記の `id_column` に当てはまる `str()` 照合の注意点は、`categorical` / `multi_label` の**値**カラムにもそのまま当てはまります。ボキャブラリは各値の文字列表現から学習され、サービング時のリクエスト値も同じ方法で照合されます。空セルによって整数カラムが `float64` と推論されると、そのボキャブラリは `"1990.0"` から学習され (`multi_label` カラムのトークンも同様)、JSON の整数 `1990` (`"1990"` として照合) を送るサービング時のリクエストはどのキーにも一致しません。カラム全体が `float64` 推論に転ぶには空セル 1 つで十分です。

ID 軸とは異なり、これは学習時には**拒否されません** — カラムの値は行ごとに異なるため学習は自己完結的に整合するからです。したがって ID カラムと同様にソース側で型を固定してください (`csv` なら `dtype: {year: str}`、`bigquery` / `sql` なら `CAST(... AS STRING)`、`parquet` ならファイルのスキーマを修正)。ただしこの不一致はサイレントではありません。サービング時にはミスするたびに `recotem_v1_feature_unknown_value_total` (recipe / side / column でラベル付け。[オペレーション — フィーチャーアウェア iALS のサイジング](./operations#フィーチャーアウェア-ials-のサイジング) を参照) が増加するため、一致するはずのカラムでこの値が急増したらソースの dtype を確認する合図です。**ID 軸**はより厳格な学習時の対応物です。そちらでは同じ `"1.0"` と `"1"` の不一致がカバレッジを 0% にし、サービング時にサイレントに劣化するのではなく [一致ゼロの拒否](#id-は文字列で照合され、一致ゼロは致命的) (`feature_axis_error`、終了コード 4) で学習を中断します。
:::

サービング時、`:recommend` / `:recommend-related` に渡されるコールドスタートのフィーチャー値 (`user_features`、および `item_features` の各シードマッピング) には長さ上限があります。**8192 文字**を超える文字列値は `422` で拒否されます (エラーは該当カラム名を示し、値そのものは決して出力しません)。これはリクエストあたりの `multi_label` トークナイズ処理を制限するためです — 8192 文字は実際のトークンリストには十分寛容でありながら、メガバイト規模の増幅を阻止します。同じ上限はバッチ動詞にも適用されますが、そちらでの違反は `422` でバッチ全体を失敗させるのではなく、`200` のバッチレスポンス内の要素ごとの `VALIDATION_ERROR` として現れます。文字列以外のスカラー値は影響を受けません。

`numerical` カラムが学習データ内で定数、あるいは単に**ほぼ**定数である場合、そのセグメントはゼロとして出力され、警告 (`feature_zero_variance_column`) がログに記録されます。トリガーは厳密な `std == 0.0` チェックではなく、カラム自身のスケールに対する相対的な下限 `std <= 1e-8 × max(abs(mean), 1.0)` です。値が浮動小数点の丸め誤差程度しか違わないカラム (std ~1e-15) は厳密チェックなら通過してしまい、その後サービング時の標準化でゼロに近い分母による除算が発生し、通常のリクエスト値を天文学的に大きな標準化値に変えてしまいます — その結果、クライアントには見えず制御もできない理由でコールドスタートソルバーの数値ガードに引っかかります。そうしたカラムは代わりに欠損値とまったく同じように劣化します。[サービング API — フィーチャーアウェアなコールドスタート](./serving-api#フィーチャーアウェアなコールドスタート) を参照してください。

すべて 1 の暗黙的な**バイアスカラム**がサイドごとに追加されます (irspack 自身は切片を追加しません)。これはすべての `categorical` カラムの one-hot ブロックと意図的に共線です — drop-first エンコーディングも検討されましたが、未知・欠損の値 (全ゼロのセグメント) と、除外された参照レベルとを区別できなくなるため採用しませんでした。結果として生じるランク落ちは、チューニングされる範囲でリッジ (下記の `lambda_*_feature`) が吸収します。ひとつの帰結として、学習が `Feature ridge Cholesky decomposition failed` で失敗したとき、メッセージが意図的にカラムの削除を提案しないのは、Recotem 自身のバイアスカラムのほうが構造的な原因として可能性が高く、かつそれはレシピから取り除けないからです。対処法 (`min_frequency`) については [オペレーション — フィーチャーアウェア iALS のサイジング](./operations#フィーチャーアウェア-ials-のサイジング) を参照してください。

### `min_frequency` が次元上限に対する唯一のレバー

エンコーダのボキャブラリは**取得したフィーチャーテーブル全体**から構築され、インタラクションデータに存在するアイテム/ユーザーには限定されません — これによりコールドスタートのカバレッジを最大化します。その結果、エンコード後の次元は**インタラクション件数ではなくカタログサイズ**に比例します。インタラクションが 1k アイテムしかカバーしていない 100 万アイテムのカタログでも、残り 99 万 9 千アイテム分のエンコード次元 (と学習コスト) をそのまま支払います。高カーディナリティのカラムで `min_frequency` を上げることが `RECOTEM_MAX_FEATURE_DIM` (デフォルト 5000。[オペレーション — フィーチャーアウェア iALS のサイジング](./operations#フィーチャーアウェア-ials-のサイジング) を参照) に対する唯一のレバーです。ボキャブラリをインタラクションでカバーされた行に限定する方法はレシピレベルには存在しません。

::: warning min_frequency を上げすぎると、致命的ではないものの目立つ形で失敗します
`min_frequency` に上限はなく、カタログとの整合性を検査する仕組みもないため、3 行のフィーチャーテーブルに対する `min_frequency: 50` も問題なく検証を通り、すべてのトークンを刈り取ります。そのカラムは `width=0` にエンコードされて何も寄与せず (すべての行が暗黙のバイアスカラムにフォールバックします)、それでいて `feature_encoder_state_built` の INFO イベントはそのカラムを有効であるかのように列挙し続けます。学習は `feature_empty_vocabulary_column` **警告** (カラム名、その `encoding` と `min_frequency`、distinct/出現回数を含みます。トークンの値は決して含みません) をログに記録して続行します。全 NULL のカラムも別経路で同じ「何も寄与しない」状態に到達し、同様に警告します。`min_frequency` を大きく引き上げたあとは学習ログを確認してください。
:::

### `lambda_item_feature` / `lambda_user_feature` — 「ユーザーがチューニングできない」の唯一の例外

`training.algorithms` のハイパーパラメータ範囲は通常 irspack の各レコメンダーの `default_suggest_parameter` に由来し、レシピから**ユーザーがチューニングすることはできません**。フィーチャーリッジの係数はその最初の例外です。`lambda_item_feature` と `lambda_user_feature` は **Recotem 独自の**探索範囲 `suggest_float(..., 1.0, 1e6, log=True)` であり、`features.item` / `features.user` ブロックを持つサイドに対してのみ、かつトライアルのクラスが `IALSRecommender` の場合にのみ適用されます。これらはレシピのフィールドとしては存在せず、明示的に設定することはできず、チューニングされるだけです。

この範囲が irspack のものではなく Recotem 独自である理由は 2 つあります。irspack はこれらのパラメータのデフォルト範囲を提供しておらず (`default_suggest_parameter` は決してこれらを提案しません)、コンストラクタのデフォルト値 `0.0` は対応するフィーチャー行列が空でない限り**ハードエラー**になります (`ValueError: Feature weight regularization must be positive.`)。したがって features ブロックが存在する時点で、チューニングしないという選択肢はありません。

範囲の出典: irspack v0.5.2 の唯一のフィーチャーアウェアな例 (`examples/mind/mind_small_feature_aware_ials.py`) と一致しており、そこでは `lambda_item_feature` が `1.0`–`1e6` でチューニングされています。

下限 `1.0` は上流への追従ではなく**条件数**のための下限です。irspack はリッジを `gram = Fᵀ F; gram.diagonal() += lambda_feature` として構成し、**float32** で Cholesky 分解します。Recotem のエンコーダは常にすべての `categorical` one-hot ブロックと意図的に共線であるすべて 1 のバイアスカラムを追加するため (上記参照)、`Fᵀ F` は構造上*厳密に*特異であり、そのヌル方向における唯一の固有値が `lambda_feature` です。したがって Gram 行列の条件数はおよそ `(最大固有値) / lambda` であり、float32 の Cholesky はこれが `1/eps` (約 8×10⁶) に近づくと信頼できなくなります。`1.0` より 1 桁下げるごとにその予算を 1 桁消費するため、下限はこれ以上下がりません。

それでもリッジが解けない場合、irspack は `Feature ridge Cholesky decomposition failed` または `Feature ridge solve failed` を送出します。**探索中はこれは学習の失敗ではありません** — Recotem はそのトライアルを打ち切って続行します。致命的になるのは**最終リフィット**でこれに遭遇した場合のみで、サブコード `feature_cholesky_error` で終了コード 4 となり、完了済みの探索は破棄されアーティファクトは書き込まれません。`min_frequency` による対処法は [オペレーション — フィーチャーアウェア iALS のサイジング](./operations#フィーチャーアウェア-ials-のサイジング) を参照してください。

### バリデーション

レシピのロードは次を `RecipeError` (終了コード 2) で拒否します。

- `categorical` / `numerical` / `multi_label` 以外の `encoding`。
- `encoding` が `multi_label` でないカラムに設定された `delimiter`。
- `numerical` カラムに設定された (デフォルト以外の) `min_frequency`。
- 同一サイドの `columns` リスト内での重複したカラム名。
- 同一サイドの `columns[].name` にも現れる `id_column` — ID カラムはインデックスとして消費されるため、同名のフィーチャーカラムはエンコード時に欠損します。学習時ではなくロード時に検出されます。
- `features:` が存在するのに `training.algorithms` にフィーチャー対応アルゴリズム (現時点では `IALS`) が含まれていない場合。`algorithms` に `IALS` を追加するか、`features` ブロックを削除してください。
- `features.item.source` / `features.user.source` がトップレベルの `source` と同じ [パススキーム許可リストとネットワークパスに対する sha256 必須のルール](#パスルール) に違反する場合。

`recotem validate` は `source` と同じ方法で `features.item.source` / `features.user.source` の接続性をプローブします。報告される各行には `[features.item.source]` / `[features.user.source]` のラベルが付くため、どのソースが失敗したかが分かります。

### アーティファクトヘッダーが記録する内容

`features:` を持つレシピは、アーティファクトヘッダーに `features` オブジェクトを追加します。ペイロードをデシリアライズせずに `recotem inspect` で読み取れます。

```json
"features": {
  "version": 1,
  "active": true,
  "item": {"n_features": 38, "columns": ["genres", "release_year", "country"]},
  "user": {"n_features": 4,  "columns": ["age_band"]}
}
```

| フィールド | 意味 |
|-------|-------|
| `version` | エンコーダ状態のフォーマットバージョン。サービングは実装していないバージョンのアーティファクトを拒否します — [セキュリティ — フィーチャーアウェア iALS](./security#フィーチャーアウェア-ials) を参照してください。 |
| `active` | 探索の**勝者**が実際にエンコーダ状態を利用できるかどうか。 |
| `item` / `user` | サイドごとのエンコード次元とカラム名。レシピが宣言したサイドについてのみ存在します。 |

::: tip ヒント — `active: false` はエラーではありません
`features:` が要求するのは列挙されたアルゴリズムの*いずれか 1 つ*がフィーチャー対応であることだけなので、`algorithms: [IALS, TopPop]` が正当に TopPop に勝たれることがあります — これは有効な通常のアーティファクトで、単にフィーチャーベースのコールドスタートを提供できないだけです (そうしたリクエストは `400 FEATURES_NOT_SUPPORTED` を受け取ります)。このフラグは、`recotem inspect`、ダッシュボード、アラートがペイロードをデシリアライズせずにこのケースをフィーチャーアウェアなモデルと区別できるように存在します。エンコーダ状態はペイロードに永続化されたままで、ディスクリプタもそれを記述し続けるため、ロード時に両者を突き合わせられます。

決定的に `active: true` を得るには、`training.algorithms` をフィーチャー対応アルゴリズム (現時点では `IALS`) に限定してください。
:::

サービングは、`features` ヘッダーとペイロード内のエンコーダ状態が食い違うアーティファクトを拒否します — 宣言されていない状態、欠けているサイド、`n_features` / `columns` の不一致、認識できないディスクリプタキー、勝者と矛盾する `active` フラグのいずれかです。これは不正に構築された、あるいは部分的に改竄されたアーティファクトに対する多層防御のチェックであり、失敗は `feature_state` の reason ラベルでカウントされます ([オペレーション](./operations) を参照)。

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
| `algorithms` | list[string] | required | `IALS`、`CosineKNN` (エイリアス `CosinekNN`)、`TopPop`、`RP3beta`、`DenseSLIM`、`TruncatedSVD`、および `BPRFM` (**`bprfm` エクストラが必要** — これがないと `validate` も `train` もデータ取得前に終了コード 4 と `irspack does not know recommender class 'BPRFMRecommender'` で失敗します。[インストール](/2.1/ja/guide/installation#オプションエクストラ) を参照)。**BPRFM のレシピは `:recommend-related` と `:batch-recommend-related` に応答できません** — サポート対象で唯一 `get_score_cold_user` を持たないため、この 2 つの動詞は `501 RELATED_NOT_SUPPORTED` を返します ([サービング API](/2.1/ja/docs/serving-api#post-v1-recipes-name-recommend-related) を参照)。irspack のフルクラス名 (例: `IALSRecommender`) も受け付けます。ハイパーパラメータの範囲は irspack の各レコメンダーの `default_suggest_parameter` から取得され、レシピからは変更できません。 |
| `metric` | string | `ndcg` | `ndcg`、`map`、`recall`、`hit` のいずれか。 |
| `cutoff` | int | `20` | 評価時の推薦リスト長 (1 以上)。 |
| `n_trials` | int | `40` | Optuna の総トライアルバジェット (1 以上)。 |
| `per_algorithm_trials` | map | `null` | アルゴリズムごとのトライアル数の上書き。**明示的な `0` はそのアルゴリズムを無効化します** (探索から完全に除外されます)。このマップで*指定されていない* `algorithms` 内のアルゴリズムは、明示的な値を優先した後の残りバジェットを分割します。明示的な値の合計が `n_trials` を超える場合、正の値は比例してスケールダウンされます (各値は `n_trials` スロットが存在する限り ≥ 1 を維持します。そうでなければ最初の `n_trials` 個の非ゼロクラスが各 1 トライアルを受け取り、残りはスキップされます — 総バジェットが `n_trials` を超えることはありません)。**不明なアルゴリズムキーはレシピロード時に ValidationError で拒否されます** — 各キーは `algorithms` に存在する有効なエイリアスまたはクラス名である必要があります。`parallelism > 1` の場合、進行中の並行トライアルにより実際のアルゴリズムごとのトライアル数が設定バジェットを最大 `parallelism - 1` 超える可能性があります。この条件が適用される実行ごとに警告がログ出力されます。 |
| `per_trial_timeout_seconds` | int | `null` | ソフトなトライアルごとの実時間上限。ワーカースレッドでトライアルを実行することで実装されます。超過した場合、Optuna はトライアルを枝刈りしますが、基底スレッドはデーモン化されて自然に終了するまで継続する可能性があります (CPU/メモリは消費されます)。スタディ終了時にまだ実行中のスレッド数は `train_done` 構造化ログイベントの `n_orphaned` としてレポートされます。オペレーターはこのフィールドを監視して、常にタイムアウトに達するトライアルを検出し、`per_trial_timeout_seconds` または `timeout_seconds` を調整できます。 |
| `timeout_seconds` | int | `null` | チューニング全体の実時間上限。 |
| `parallelism` | int | `1` | Optuna の `n_jobs` (Python スレッド、プロセスではありません)。**効果はアルゴリズム次第で、IALS では確実に悪化します。** irspack のネイティブ学習器は内部で既に並列化されており (IALS のトライアルは単体で約 8 コアを使います)、Optuna のスレッドがその上に積み重なってマシンをオーバーサブスクライブします。16 コアのホスト、10 万行のフィクスチャ、`n_trials: 20` での実測では `parallelism: 1` が平均 **10.15 秒**、`parallelism: 4` が平均 **14.99 秒** — 1.48 倍*遅く*なりました。他のアルゴリズムは逆で、トライアルが短く余裕があります。同じフィクスチャでの `parallelism: 1` と `8` の中央値は `CosineKNN` 3.66 秒 → 1.99 秒 (**1.84 倍**)、`RP3beta` 4.07 秒 → 2.15 秒 (**1.89 倍**)、`DenseSLIM` 4.81 秒 → 3.38 秒 (1.42 倍)、`TruncatedSVD` 5.29 秒 → 4.03 秒 (1.31 倍)。`TopPop` はトライアルが元々自明なため変化しません。同時実行数に応じてピーク RSS も上がるため、速度はメモリと引き換えです。**`algorithms` に `IALS` が含まれる場合は `1` のままにしてください** (ほとんどのレシピの既定の形です)。IALS を含まない探索で実行時間が重要な場合にのみ、再現性の低下を受け入れた上で上げてください。 |
| `storage_path` | string | `""` | 空 = インメモリ (再開なし)。ベアパスは SQLite URL (`sqlite:///<path>`) になります。明示的な `sqlite://`、`postgresql+psycopg://`、`mysql+pymysql://`、`mariadb+pymysql://` URL も受け付けます。**ここでも `+driver` サフィックスは必須です** — この URL は Optuna の `RDBStorage` にそのまま渡され、`RDBStorage` 自体はドライバの事前チェックを行いません。そのため裸の `postgresql://` も `postgres://` も動作しません。2.1.0 以降はどちらも Optuna に到達しません。`recotem validate` と `recotem train` (データ取得の前) の事前チェックが、ダイアレクト名・使うべき綴り・インストールすべきエクストラを示したうえで `code: storage_path_unusable` とともに終了コード **8** で終了します。**ドライバのエクストラのインストールも必要です** (`recotem[postgres]` / `recotem[mysql]`)。`sqlalchemy` は Optuna 経由で推移的に入るため URL はどちらでもパースされ、エクストラ不足と綴り間違いは*異なる*事前チェックのメッセージになり、それぞれ固有の対処方法を示します — [オペレーション](./operations#同時学習と永続的な探索ストレージ) を参照。スタディ名は `recotem_<recipe_name>_<run_id>` で `load_if_exists=True` のため、`train` 実行ごとの新しい `run_id` は常に新しいスタディを開始します (再開するには同じ `run_id` を再利用する必要があります — `recotem train --run-id <stable>` で渡します)。**NFS 上の SQLite は破損します** — SQLite データベースはローカルファイルシステム上に保持してください。**URL に認証情報を埋め込んではいけません** (`postgresql://user:pass@host/db` は `SearchError` で拒否され、SQLAlchemy のトレースバックから userinfo が漏洩するのを防ぎます)。代わりに `PGPASSFILE` / `~/.pgpass` / SQLAlchemy 環境変数で認証情報を提供してください。 |
| `split.scheme` | string | `random` | `random`、`time_global`、または `time_user`。下記のセマンティクスを参照してください。 |
| `split.heldout_ratio` | float | `0.1` | ホールドアウトするインタラクションの割合。(0, 1) の範囲。 |
| `split.test_user_ratio` | float | `1.0` | テスト分割に含まれるユーザーの割合。(0, 1] の範囲。 |
| `split.seed` | int | `42` | 分割のランダムシード (irspack に `random_state` として渡されます)。 |

分割スキームのセマンティクス:

- `random` — インタラクションをユーザーごとに均一にランダムにホールドアウトします。`time_column` は使用しません。`schema.time_column` が設定されていても、`random` スキームはそれを無視します。
- `time_user` — 各ユーザーについて、`time_column` でランク付けされたそのユーザーのインタラクションの最新 `heldout_ratio` をホールドアウトします。カットオフはユーザーごとに計算されます。
- `time_global` — データセット全体の `time_column` の `1 - heldout_ratio` 分位数での単一グローバルカットオフ。カットオフ以降のすべてのインタラクションはユーザーに関わらずホールドアウトされます。カットオフ後のインタラクションがないユーザーは学習のみになります。

`time_user` および `time_global` には `schema.time_column` が必要です。これらのスキームで `time_column` が欠落している場合はレシピバリデーションエラーとなり、終了コード 2 で終了します。

::: warning 2.1 での動作変更
以前のリリースではすべてのスキームで `schema.time_column` がスプリッターに渡されていたため、`split.scheme: random` と `schema.time_column` を組み合わせたレシピは、ランダムなホールドアウトではなく `time_user` (ユーザーごとの新しい順) のホールドアウトを暗黙的に受け取っていました。現在は上記のとおり、`random` は `time_column` を無視します。

レシピが両方を設定している場合、次回の `recotem train` は異なる分割を生成し、その結果 `best_score` / `best_params` の値も変わります。既存のアーティファクトは再学習するまで影響を受けません。以前の動作を維持するには、`split.scheme: time_user` を明示的に設定してください。
:::

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

> **展開後サイズの上限は強制されません。** `RECOTEM_MAX_DOWNLOAD_BYTES` が上限とするのは生の I/O バイト数のみです。圧縮された CSV および columnar Parquet ソースは解凍後に生サイズの数倍に膨らむ可能性があり、生成される DataFrame はサイズ制限されません。影響を抑えるには `recotem train` を cgroup または Kubernetes Pod (メモリ制限付き) 内で実行してください。[security — Decompressed-size cap not enforced](./security#解凍後サイズ上限の未適用-medium-5) を参照してください。

`output.path` は以下のスキームに限定されます: ベアローカルパス (プレフィックスなし)、`file://`、`s3://`、`gs://`、`az://`、`abfs://`、`abfss://`。その他のスキームは拒否されます: `http://`、`https://`、`ftp://`、`ftps://` はこれらのプロトコルでアーティファクトの書き込みがサポートされていないため。`memory://` はプロセスローカルであり学習実行後に存続しないため。

埋め込まれた認証情報 (`s3://AKIA...:secret@bucket/`) はすべてのパスフィールドでレシピロード時に拒否されます。

ローカルパスは絶対パスに解決されます。`RECOTEM_ARTIFACT_ROOT` が設定されている場合、`output.path` は `realpath` 解決後にその配下のパスに解決される必要があります (シンボリックリンクによるエスケープは拒否されます)。

---

## 環境変数展開

構文: `${RECOTEM_RECIPE_VAR}`。プレフィックス `RECOTEM_RECIPE_*` に一致する変数のみ展開されます。マッチングは大文字小文字を区別しません (大文字に変換された名前がプレフィックスとブラックリストに対してチェックされます)。`recotem train --env-var KEY=VALUE` (繰り返し指定可能) を使用して、シェル環境にエクスポートせずに追加の値を注入できます。`KEY` は `RECOTEM_RECIPE_` で始まり、ブラックリストチェックをパスする必要があります。例: `recotem train recipe.yaml --env-var RECOTEM_RECIPE_DATE=20260501`。

ブラックリスト (プレフィックスに関わらず展開されない): 正確な名前 `RECOTEM_SIGNING_KEYS` および `RECOTEM_API_KEYS`。`AWS_`、`GCP_`、`GOOGLE_`、`AZURE_`、`ALIYUN_`、`ALICLOUD_`、`OCI_`、`IBM_`、`DO_`、`HCLOUD_`、`DIGITALOCEAN_` で始まる名前 (AWS、GCP、Azure、Alibaba Cloud、Oracle Cloud、IBM Cloud、DigitalOcean、Hetzner Cloud のクラウド認証情報プレフィックス)。`SECRET`、`PASSWORD`、`PASSWD`、`TOKEN`、`KEY`、`AUTH`、`BEARER`、`CRED`、`PRIVATE` という部分文字列を含む名前 (全て大文字小文字を区別しない比較)。

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
