---
title: 終了コードとエラー
description: "Recotem の終了コードとエラーのリファレンス。recotem train / serve が返す 0〜8 のコードとエラークラス、原因、CI や cron での推奨リトライ方針を解説します。"
---

# 終了コードとエラー

`recotem train`、`recotem serve`、`recotem inspect`、`recotem validate` はいずれも例外を少数の明確な終了コードにマッピングします。stderr をパースする代わりに、CI、cron ラッパー、Kubernetes Job の再起動ロジックでこれらの終了コードを使用してください。

## 終了コード一覧

| コード | 定数 | エラークラス | 意味 |
|--------|------|-------------|------|
| 0 | `_EXIT_SUCCESS` | — | 成功 (または `--fail-on-busy` なしでロックが競合した場合) |
| 1 | `_EXIT_UNKNOWN` | — | 未処理 / 未マッピングの例外 |
| 2 | `_EXIT_RECIPE` | `RecipeError` | レシピスキーマ / 環境変数 / パススキームエラー |
| 3 | `_EXIT_DATASOURCE` | `DataSourceError` | データソース取得失敗 |
| 4 | `_EXIT_TRAINING` | `TrainingError` | 学習パイプライン失敗 |
| 5 | `_EXIT_ARTIFACT` | `ArtifactError` | アーティファクトの完全性 / 形式エラー |
| 6 | `_EXIT_LOCK_CONTESTED` | `LockContestedError` | 別プロセスによるレシピ単位の学習ロック |
| 7 | `_EXIT_HTTP_FETCH` | `HttpFetchError` | HTTP/HTTPS ソース取得失敗 |
| 8 | `_EXIT_CONFIG` | `ConfigError` | 環境 / 設定エラー |

---

## コード別リファレンス

### 0 — 成功

コマンドが正常に完了しました。`recotem train` の場合、ロックが既に保持されていて `--fail-on-busy` が**設定されていない**ケース (実行がスキップされたが、プロセスは正常終了する) も含みます。スキップと実際の学習実行を区別するには、終了コードだけでなく `recipe_lock_contended_skipping` 構造化ログイベントを確認してください。

---

### 1 — 不明なエラー

どのドメインエラークラスにもマッピングされない例外が発生しました。一般的な原因:

- Recotem または依存ライブラリのバグ。
- 予期しない環境上の問題 (ディスクフル、メモリ不足、システムライブラリの欠落)。
- JSON スキーマ生成中の `schema` コマンド失敗。

**推奨対応:** 一度リトライしてください。エラーが継続する場合は `train_error` ログイベントの `internal_error` フィールドを確認し、バグレポートを提出してください。

---

### 2 — RecipeError

レシピ YAML のロードまたは検証ができない場合に `RecipeError` が発生します。一般的な原因:

- YAML 構文エラー (インデント、不正な Unicode など)。
- スキーマ違反 (未知のフィールド、型の誤り、許容範囲外の値)。
- 環境変数展開失敗: レシピで参照している `${RECOTEM_RECIPE_*}` 変数が未設定、または名前が許可リストのプレフィックスに一致しない。
- `recotem train` への `--env-var KEY=VALUE` 引数で、`KEY` が `RECOTEM_RECIPE_` で始まらない。
- `--dev-allow-unsigned` をコンパニオンフラグ `--i-understand-this-loads-arbitrary-code` なしで渡した場合 (終了コード 2 ではなく 8 — 下記の ConfigError を参照)。
- `source.path` または `item_metadata.path` で許可されていないスキームを使用 (チェーン `::` fsspec プロトコル、`memory://` など)。
- URI に埋め込まれた認証情報 (URI 内のユーザー名またはパスワード) が検出された。

**推奨対応:** レシピ YAML または `--env-var` の値を修正してください。これは永続的な設定エラーです。修正なしにリトライしないでください。

---

### 3 — DataSourceError

データソース層で `DataSourceError` が発生します。一般的な原因:

- CSV または Parquet の形式エラー (不正なファイル、区切り文字の誤り、エンコードの問題)。
- ソースデータに必要なカラムが存在しない。
- レシピで参照しているローカル FS のパスが存在しないか、読み取れない。
- BigQuery のスキーマ不一致 (カラム名または型がレシピの期待するスキーマと一致しない)。
- BigQuery API パーミッションエラー (サービスアカウントがテーブルを読み取れない)。
- **SSRF ガードが拒否したすべての SQL DSN** — プライベート/ループバックホスト、libpq の `?service=` や絶対パスホスト、MySQL の `?unix_socket=`、ホスト情報のないネットワーク DSN。[SQL ソース — エラーと終了コード](./data-sources/sql#エラーと終了コード) を参照。
- **HTTP 以外のパスでの `sha256` 不一致** — ローカルファイル、`s3://`、`gs://`、`az://`。不一致を終了コード 7 として報告するのは `http://` / `https://` の取得パイプラインだけです。

**推奨対応:** `train_error` ログイベントの `error` フィールドを確認してください。CSV/Parquet の形式エラーやカラム不在は永続的な問題です — ソースまたはレシピを修正してください。BigQuery パーミッションエラーは IAM の修正が必要です。終了コード 7 は `http://` / `https://` の取得パイプラインに限定されます。それ以外のトランスポート経由のネットワーク失敗 — 拒否された SQL ホスト、オブジェクトストレージの読み取り — は **3** を報告します。

---

### 4 — TrainingError

学習パイプラインで `TrainingError` が発生します。サブコードは `train_error` ログイベントの `code` フィールドに含まれます。

| サブコード | 意味 |
|------------|------|
| `min_data_violation` | クレンジング後のデータセットが `min_rows`、`min_users`、`min_items` を下回った。`train_error` イベントには `n_rows`、`n_users`、`n_items`、`min_rows`、`min_users`、`min_items` が含まれます。 |
| `time_column_parse_error` | タイムスタンプカラムをパースできなかった。 |
| `split_error` | 学習/検証の分割が失敗したか、使用できない結果になった — ホールドアウトのテスト集合が空、`time_user` / `time_global` スキームなのに `schema.time_column` が未設定、あるいは irspack のスプリッタ内部での失敗。`split.heldout_ratio` を**上げて**ください — ホールドアウトは**ユーザーごと**に `floor(インタラクション数 * heldout_ratio)` なので、比率を下げると必要な1 ユーザーあたりの深さが*増え*ます。ユーザー数を増やしても解決しません。エラーメッセージには、実際のデータで有効になる最小の比率が示されます。深いユーザーは存在するのに検証ユーザーとして抽出されなかった場合は、代わりに `split.test_user_ratio` を上げてください。 |
| `no_completed_trials` | 完了前に全 Optuna トライアルが失敗した。 |
| `zero_score` | 完了した全トライアルのスコアが 0.0 だった。テスト分割が空である場合に多い。 |
| `excessive_per_trial_timeouts` | ほとんどのトライアルがトライアルごとのタイムアウトに達した。レシピの `training.per_trial_timeout_seconds` を増やしてください。 |
| `search_error` | Optuna 探索そのものが失敗した。`training.storage_path` が認証情報 (`user:pass@host`) を埋め込んでいる場合 (代わりに `PGPASSFILE` などの環境変数ベースの認証を使用してください)、および `training.per_trial_timeout_seconds` がアルゴリズムの実行時間に対して短すぎて孤立スレッドの上限に達した場合に発生します。 |
| `final_training_error` | ハイパーパラメータ探索完了後の最終学習 (再フィット) ステップが失敗した。 |
| `signing_key_missing` | アーティファクト書き込み時に署名鍵の設定が欠落している (一部のパスでは ConfigError も発生 — 終了コード 8 を参照)。 |
| `datasource_error` | `DataSourceError` が学習パイプラインを通じて表面化した。 |
| `invalid_metric` | `training.metric` がサポートされているメトリクスのいずれでもない。 |
| `no_active_algorithms` | `training.per_algorithm_trials` によってすべてのアルゴリズムが無効化されている (すべての予算が 0)。 |
| `time_unit_required` | `schema.time_column` が数値を保持しているが `schema.time_unit` が未設定。Unix タイムスタンプがナノ秒として黙って解釈されるのを避けるため `time_unit` (`s`、`ms`、`us`、`ns`) を設定してください。 |
| `unknown_algorithm` | `training.algorithms` の要素がサポートされている irspack のレコメンダークラスに解決できない。エイリアスをサポート対象のアルゴリズム一覧と照合してください。(下記の `unknown_algorithm_in_budget` は、同じ失敗が `training.per_algorithm_trials` 経由で発生したものです。) |
| `unknown_algorithm_in_budget` | `training.per_algorithm_trials` が解決できないアルゴリズムのエイリアスを指定している。 |
| `cutoff_exceeds_item_count` | `training.cutoff` が正解行列のアイテム次元より大きい。 |
| `feature_axis_error` | [`features:`](./recipe-reference#features) のいずれかのサイドのフィーチャーテーブルが、インタラクションデータと ID の重なりを**まったく**持たない。[オペレーション — recotem train が feature_axis_error で終了コード 4 で終了する](./operations#recotem-train-が-feature-axis-error-で終了コード-4-で終了する) を参照。 |
| `feature_cholesky_error` | **最終リフィット**中にフィーチャーリッジの Cholesky 分解またはソルブが失敗した (探索中はトライアルを打ち切るだけ)。高カーディナリティのカラムで `min_frequency` を上げると通常は解決します。 |
| `feature_table_error` | フィーチャーテーブルを取得または使用できなかった — `features.<side>.source` の `type` ディスクリミネータの欠落、取得したテーブルに存在しない `id_column`、宣言されたフィーチャーカラムの不在など。 |
| `training_error` | `TrainingError` 基底クラスが持つ既定のサブコード。より具体的なコードを伴わずに送出された学習ドメインの失敗はすべてこれを報告します — 詳細は `train_error` イベントの `error` フィールドを参照してください。 |

**推奨対応:** 一時的な問題 (ネットワーク周辺のデータロード、不安定な学習) にはリトライ。`min_data_violation` はデータソースが期待より少ない行を返していないか調査してからリトライしてください。`zero_score` や空のテスト分割の問題には、レシピの `split` または `cleansing` 設定を調整してください。

---

### 5 — ArtifactError

アーティファクトコンテナが構造的に不正であるか、HMAC を検証できない場合に `ArtifactError` が発生します。一般的な原因:

- マジックバイト不一致 (ファイルが Recotem アーティファクトでない、または破損している)。
- 不明なバージョンバイト (より新しいバージョンの Recotem で書き出されたアーティファクト)。
- 不明な `kid` (アーティファクトの署名に使用した署名鍵が `RECOTEM_SIGNING_KEYS` にない)。
- HMAC 不一致 (アーティファクトが改ざんされているか、誤った鍵が設定されている)。
- アーティファクトまたはペイロードが設定されたサイズ上限を超えている (`RECOTEM_MAX_ARTIFACT_BYTES` または `RECOTEM_MAX_PAYLOAD_BYTES`)。
- ヘッダー JSON がサイズ上限を超えている。
- シリアライズされたペイロードに許可されていない FQCN が含まれていた (デシリアライズ時の FQCN 許可リスト拒否)。

::: tip recotem inspect
`recotem inspect` は疑わしいアーティファクトに対して安全に実行できます — ペイロードをデシリアライズせずに HMAC ヘッダーを読み取り、検証します (FQCN 許可リストはペイロードに適用されます)。再学習前に終了コード 5 のエラーを診断するために使用してください。
:::

**推奨対応:** `recotem inspect <artifact>` を実行して具体的なエラーメッセージを確認してください。`signature mismatch` または `unknown kid` エラーは鍵ローテーション手順が未完了であることを意味します — 古い kid を `RECOTEM_SIGNING_KEYS` に追加するか、現在の鍵で再学習してください。`magic bytes mismatch` はファイルが破損しています — 再学習してください。

注意: `RECOTEM_SIGNING_KEYS` が存在せず `--dev-allow-unsigned` も渡されていない場合、`recotem inspect` は 5 ではなく 8 (ConfigError) で終了します。

---

### 6 — LockContestedError

`--fail-on-busy` が設定されていて、かつレシピ単位の POSIX ファイルロックが別のプロセスに保持されている場合に `LockContestedError` が発生します。`--fail-on-busy` なし (デフォルト) の場合、ロック競合は構造化イベント `recipe_lock_contended_skipping` とともに終了コード 0 で終了します — 実行は暗黙的にスキップされます。

`LockContestedError` は `TrainingError` の継承階層の外に意図的に置かれています — これはオーケストレーションの状態であり、学習の失敗ではありません。

**推奨対応:** 学習実行が重複しないよう十分な間隔でスケジュールするか、スケジューラー独自の並行性制御を使用してください (Kubernetes `concurrencyPolicy: Forbid`、Argo `synchronization.mutex` など)。同一ホスト上では `--lock-timeout <seconds>` を使用して、即座に失敗する代わりにロックを待機させることもできます。

::: warning flock はホストローカルです
レシピ単位のロックは POSIX `flock` を使用しており、**同一ホスト上**の書き込みのみを調整します。`output.path` がリモート URI (`s3://`、`gs://` など) の場合、ロックファイルはホストローカルであり、別マシンや別 Pod からの並行書き込みを防ぎません。クロスホスト調整にはスケジューラーレベルの並行性制御を使用してください。
:::

---

### 7 — HttpFetchError

SSRF ガード付きの HTTP/HTTPS フェッチャーでネットワークソースを取得できない場合に `HttpFetchError` が発生します。これはそのパイプラインに限定されます。*同じガード* でも別のトランスポート経由で到達した場合は `DataSourceError` (終了コード 3) になります。SSRF ガードが拒否した SQL DSN は終了コード 3、ローカルやオブジェクトストレージのパスでの `sha256` 不一致も終了コード 3 です。**終了コード 7 が「データベースが接続を拒否した」を意味することは決してありません** — これを条件にしたリトライロジックがそれを見ることはありません。

一般的な原因:

- SSRF ガード: 宛先が RFC1918、ループバック、またはリンクローカルアドレスに解決された (クラウドメタデータサービスを保護するためデフォルトでブロック)。信頼された内部ネットワーク向けには `RECOTEM_HTTP_ALLOW_PRIVATE=1` を設定してください。
- 接続またはリードタイムアウト (`RECOTEM_HTTP_TIMEOUT_SECONDS` を超過)。
- HTTP 4xx または 5xx レスポンス。
- リダイレクト上限超過 (取得がリダイレクトされすぎた) またはスキーム変更リダイレクトを検出。
- SHA-256 不一致: ダウンロードしたボディがレシピの `sha256` フィールドと一致しない (`http://`/`https://` ソースに必須)。
- ボディサイズ上限超過 (`RECOTEM_MAX_DOWNLOAD_BYTES`)。

**推奨対応:** 一時的なネットワークエラー (タイムアウト、5xx) はリトライ。永続的なエラー (SSRF ガード拒否、SHA-256 不一致、4xx レスポンス) は調査が必要です。以前の実行が成功した後の SHA-256 不一致はソースのコンテンツが変更されたことを示します — レシピの `sha256` フィールドを更新してください。

---

### 8 — ConfigError

プロセスの起動または処理の続行を妨げる環境または設定エラーで `ConfigError` が発生します。一般的な原因:

- `RECOTEM_SIGNING_KEYS` が未設定 (明示的に `--dev-allow-unsigned` を使用するコマンドを除く全コマンドで必須)。
- `RECOTEM_SIGNING_KEYS` は設定されているが不正 — `kid:hex` エントリの形式誤り、または 64 文字の 16 進数でない値。`train_error` イベントは `code: signing_keys_invalid` を伴う。これは終了コード 5 では**なく** 8 である: 鍵エントリの誤りはアーティファクトの破損ではなく環境設定のタイプミスであるため。
- `RECOTEM_SIGNING_KEYS` なし、かつ `--dev-allow-unsigned` なしで `recotem inspect` を実行。
- `RECOTEM_ENV` が `development` でない場合に `--dev-allow-unsigned` を渡した (ゲートチェック)。
- コンパニオンフラグ `--i-understand-this-loads-arbitrary-code` なしで `--dev-allow-unsigned` を渡した。
- `RECOTEM_MAX_PAYLOAD_BYTES` > `RECOTEM_MAX_ARTIFACT_BYTES` (設定誤りが serve 起動時に発生)。
- バインドポートが既に使用中またはパーミッション拒否 (`EADDRINUSE`、`EACCES`、`EADDRNOTAVAIL`)。
- レシピ単位の学習ロックパスがファイルシステムのパーミッション不足 (`EACCES` / `EPERM`) により作成またはオープンできず、`LockPermissionError` が発生した。これは意図的に終了コード 6 では**ありません** — 下記の `--fail-on-busy` の動作セクションを参照してください。
- 起動を妨げる方法で環境変数の値がクランプ範囲外である。
- `training.storage_path` が、サポートされない、あるいは SQLAlchemy が削除したダイアレクト (`oracle://`、`postgres://`) を指している場合や、ドライバがインストールされていない場合 (裸の `postgresql://` は未インストールの `psycopg2` にフォールバックします)。`train_error` イベントは `code: storage_path_unusable` を伴います。これは `recotem validate` で、また `recotem train` でも**データ取得の前に**事前チェックされるため、不正な study バックエンドがスキャン費用を無駄にすることはなくなりました。
- **書き込めないリモートの `output.path`**。認証情報が解決できない (`code: artifact_write_credentials`)、またはバケット / コンテナーが存在しないか解決された認証情報が拒否された (`code: artifact_write_destination`) 場合。`TrainingError` として発生しますが終了コード 4 ではなくここにマップされます。スケジューラーが「この設定では決して成功しない」と「リトライしてよい」を区別できるようにするためです。
- **既存のディレクトリを指しているローカルの `output.path`** (`code: artifact_write_destination`)。レシピごとのロックは `<output.path>.lock`、つまり書き込み先の*兄弟*パスに取られるため、ロック自体は問題なく作成され、アーティファクトを書けるかどうかについては何も語りません。`_write_atomic` には作成すべき親ディレクトリもありません。その結果、実行は `os.replace` まで到達して `IsADirectoryError` を受け取ります。2.1.0 より前はこれがマップされておらず、終了コード 1 (`internal_error`) として報告されていました。`recotem validate` は書き込み先を意図的に検査しないため、ここでは捕まりません。

::: warning リモート書き込みの失敗が終了コード 8 になるのは恒久的な場合だけです
`s3://`、`gs://`、`az://` では、401 は認証情報の失敗、403 と 404 は書き込み先の失敗として分類され、いずれも終了コード 8 になります。**5xx と 429 は意図的に除外**されており終了コード 1 のままです。一時的なオブジェクトストアのエラーがリトライロジックから見て一時的なままであるようにするためです。

これは学習 1 回分のコストを伴います。この分類はアーティファクト書き込み時 — 探索と学習が終わったあと — に行われます。`recotem validate` は `output.path` の書き込み認証情報を検査しないため、ロールの設定ミスは計算資源を消費する前には捕まりません。
:::

**推奨対応:** 設定を修正せずにリトライしないでください。`RECOTEM_SIGNING_KEYS`、`RECOTEM_ENV`、およびエラーメッセージに記載されている環境変数を確認してください。`artifact_write_credentials` / `artifact_write_destination` の場合は、`output.path` に指定したバケットに対する書き込みロールまたはキーを確認してください。ローカルパスの場合は、`output.path` がディレクトリではなく*ファイル*を指しているかを確認してください。

---

## --fail-on-busy の動作

デフォルトでは、`recotem train` がレシピ単位のロックを取得できない場合、**終了コード 0** で終了し、`recipe_lock_contended_skipping` 構造化ログイベントを出力します。これは cron フレンドリーです。遅い学習実行が後続のスケジュール実行の失敗を積み上げることがありません。

::: warning パーミッション失敗は競合ではありません
終了コード 0 でのスキップは、ロックの**競合** — 別のプロセスが現在ロックを保持している場合 — のみを対象とします。ファイルシステムのパーミッション (`EACCES` / `EPERM`: ボリュームのオーナーシップの誤り、読み取り専用マウント、`RECOTEM_LOCK_DIR` のタイプミスなど) が原因でロックパス自体を作成またはオープンできない場合、`recotem train` は `LockPermissionError` を発生させ、`--fail-on-busy` の有無にかかわらず**常に**終了コード **8** (設定エラー) で終了します。

パーミッション失敗はリトライでは解決しないデプロイのミスであり、終了コード 0 で終了すると cron ジョブや CronJob が成功を報告する一方でモデルが静かに古くなってしまいます。したがって、終了コードをキーにしたスケジューラーのリトライロジックは、**6** を「後でリトライ」、**8** を「停止してデプロイを修正」として扱う必要があります。
:::

`--fail-on-busy` を渡すと終了コード 6 に変わります。

```bash
recotem train --fail-on-busy /etc/recotem/recipes/my_recipe.yaml
```

オーケストレーターが非ゼロを「別の場所でリトライ」と解釈する場合に `--fail-on-busy` を使用してください (例: `restartPolicy: OnFailure` と `backoffLimit > 0` の Kubernetes Job、または終了コード 6 をキーにした Argo Workflow リトライポリシー)。

`--fail-on-busy` を**使用しない**場合は、終了コードではなく `recipe_lock_contended_skipping` ログイベントでアラートを設定してください。

```bash
# ログベースのアラート (Datadog、CloudWatch など)
event:"recipe_lock_contended_skipping"
```

---

## train_error 構造化ログイベント

非ゼロ終了時に `recotem train` は単一の `train_error` JSON ログイベントを出力します。これはログベースのアラートにおける主要なメカニズムです — cron ログからプロセス終了コードを再パースするよりも信頼性が高いです。

主要フィールド:

| フィールド | 型 | 説明 |
|------------|-----|------|
| `event` | `"train_error"` | イベント名 (固定)。 |
| `code` | string | 特定の失敗を識別するサブコード。非ドメイン例外の場合は `internal_error`。 |
| `name` | string | レシピ名。 |
| `run_id` | string | 実行識別子 (デフォルトはランダムな 12 桁の hex、または `--run-id` の値)。 |
| `exit_code` | integer | プロセスの終了コード (2〜8)。 |
| `error` | string | 人間が読めるエラーメッセージ。 |
| `trained_at` | string | 実行開始時刻の ISO 8601 タイムスタンプ。 |
| `kid` | string | エラー発生時点で判明している場合の署名鍵 kid。 |
| `n_rows`, `n_users`, `n_items` | integer | `code=min_data_violation` の場合に含まれるデータ統計。 |
| `min_rows`, `min_users`, `min_items` | integer | `code=min_data_violation` の場合に含まれる設定閾値。 |

例:

```json
{
  "event": "train_error",
  "code": "min_data_violation",
  "name": "news_articles",
  "run_id": "a1b2c3d4e5f6",
  "exit_code": 4,
  "error": "Data precondition failed: n_rows=842 < min_rows=1000",
  "trained_at": "2026-05-14T03:00:01Z",
  "n_rows": 842,
  "min_rows": 1000,
  "n_users": 210,
  "min_users": 0,
  "n_items": 91,
  "min_items": 0
}
```

終了コードの数値だけでなく `code` フィールドでアラートを設定してください。サブコードには、シェル出力を再パースせずにアラートを適切なチームやランブックにルーティングするのに十分な情報が含まれています。
