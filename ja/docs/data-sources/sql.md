---
title: SQL ソース
---

# SQL ソース

`sql` ソースは [SQLAlchemy 2](https://www.sqlalchemy.org/) 経由でリレーショナルデータベースから直接 Recotem の学習を実行できるようにします。対応するダイアレクトは PostgreSQL、MySQL/MariaDB、SQLite です。それ以外のダイアレクトはサポートされておらず、学習時に `DataSourceError` が発生します。

クラウドを使わないウォークスルーは recotem リポジトリの `examples/sql-sqlite/` を参照してください。

## インストール

```bash
pip install "recotem[postgres]"   # PostgreSQL (psycopg 経由)
pip install "recotem[mysql]"      # MySQL / MariaDB (PyMySQL 経由)
pip install "recotem[sqlite]"     # SQLite (stdlib — 追加ドライバ不要)
```

これらのエクストラなしで `recotem train` を実行すると、以下のメッセージで終了します:

```
DataSourceError: sqlalchemy is required for SQLSource. Install one of: recotem[postgres], recotem[mysql], recotem[sqlite].
```

## DSN の注入 (環境変数経由)

DSN がレシピに書き込まれることはありません。レシピには環境変数名のみを記述し、Recotem は学習時にその変数から DSN を読み取ります。

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://user:pass@host:5432/db?sslmode=require"
uv run recotem train recipes/my_recipe.yaml
```

変数名は `^RECOTEM_RECIPE_[A-Z0-9_]+$` に一致する必要があります。それ以外のプレフィックスはレシピロード時に拒否されます (`RecipeError`、終了コード 2)。

## レシピ設定

```yaml
source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, product_id, purchased_at
    FROM orders
    WHERE purchased_at >= :since
      AND status = 'paid'
  query_parameters:
    since: ${RECOTEM_RECIPE_SINCE}
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300
```

| フィールド | 必須 | デフォルト | 備考 |
|------------|------|-----------|------|
| `dsn_env` | yes | — | DSN を保持する環境変数の名前。`^RECOTEM_RECIPE_[A-Z0-9_]+$` に一致する必要があります。DSN 自体がレシピに書き込まれることはありません。 |
| `query` | yes | — | 生の SQL。変数名に関わらず `${...}` 展開は**決して**行われません (SQL インジェクションの防止)。 |
| `query_parameters` | no | `{}` | SQLAlchemy の `text().bindparams(...)` 経由でバインドされます。`${RECOTEM_RECIPE_*}` 展開の対象です。 |
| `connect_timeout_seconds` | no | `10` | 有効範囲 `[1, 60]`。範囲外は `ValidationError`。PG/MySQL では `connect_timeout`、SQLite では `timeout` として渡されます。 |
| `statement_timeout_seconds` | no | `300` | 有効範囲 `[1, 1800]`。ダイアレクト別の詳細は [ステートメントタイムアウト](#ステートメントタイムアウト) を参照してください。 |

## DSN の例

| ダイアレクト | DSN |
|--------------|-----|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db?sslmode=require` |
| MySQL / MariaDB | `mysql+pymysql://user:pass@host:3306/db?ssl=true` |
| SQLite (ファイル) | `sqlite:///absolute/path/to/file.db` |
| SQLite (読み取り専用) | `sqlite:///file:absolute/path/to/file.db?mode=ro&uri=true` |

## パラメータバインド

実行間で変動する値には SQLAlchemy の名前付きバインドパラメータ (`:name`) を使用してください。`query` に Python の文字列フォーマットや `${...}` 展開を使用**しないでください** — 後者は SQL インジェクションを防ぐために明示的にブロックされています。

```yaml
source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, item_id, ts
    FROM events
    WHERE ts >= :since
      AND event_type = :event_type
  query_parameters:
    since: ${RECOTEM_RECIPE_SINCE}
    event_type: purchase
```

`${RECOTEM_RECIPE_*}` 展開は `query_parameters` の値に対してのみ行われます。`query` と `dsn_env` は変数名に関わらず展開から無条件に除外されます。

パラメータ値は SQLAlchemy の `text().bindparams(...)` でバインドされます。対応する型は `str`、`int`、`float`、`bool` です。

## 読み取り専用の強制

DB ユーザーには対象テーブルに対する `SELECT` 権限のみを付与してください。Recotem は多層防御として、クエリ実行前にセッションレベルの読み取り専用コマンドも発行します:

| ダイアレクト | ステートメント |
|--------------|--------------|
| PostgreSQL | `SET TRANSACTION READ ONLY` |
| MySQL | `SET SESSION TRANSACTION READ ONLY` |
| MariaDB | `SET SESSION TRANSACTION READ ONLY` + `SET SESSION max_statement_time = <seconds>` |
| SQLite | `PRAGMA query_only = ON` |

このコマンドが失敗した場合 (権限不足、または SQLite で pragma が設定できない場合)、学習は `DataSourceError` で中断します。**暗黙的にスキップされることはありません**。最終的な信頼境界は依然として GRANT モデルにあります — セッションフラグのみに依存しないでください。

## ステートメントタイムアウト

| ダイアレクト | 実装 |
|--------------|------|
| PostgreSQL | `SET LOCAL statement_timeout = <ms>` |
| MySQL | `SET SESSION MAX_EXECUTION_TIME = <ms>` |
| MariaDB | `SET SESSION max_statement_time = <seconds>` (MySQL と単位・変数名が異なる) |
| SQLite | 強制されない。`sql_statement_timeout_unsupported_on_sqlite` 構造化警告を出力。 |

PostgreSQL、MySQL、MariaDB ではタイムアウト設定が失敗すると学習が `DataSourceError` で中断します。SQLite にはサーバーサイドのタイムアウトプリミティブがないため、このダイアレクトでは文書化された安全制御が機能しないことをオペレーターに知らせるために警告が出力されます。

## TLS 推奨事項

本番環境では TLS を強く推奨します。PostgreSQL では `sslmode=require` (またはより厳しい `verify-ca` / `verify-full`) を必ず設定してください。MySQL/MariaDB では `ssl=true` (または `ssl_ca=...` で CA バンドルを指定) を設定してください。Recotem は TLS を強制しませんが、DSN が平文に見える場合に init 時に `sql_dsn_tls_not_configured` 構造化警告を出力します:

- PostgreSQL: `sslmode` が未設定、または `disable` / `allow` / `prefer` に設定されている。
- MySQL/MariaDB: `ssl*` クエリパラメータが全くない。

デプロイメントレベル (サービスメッシュ、サイドカー) で TLS を実装しているオペレーターは、明示的な DSN フラグを追加することで警告を抑止できます。

## SSRF ガード

デフォルトでは、プライベート / ループバック / リンクローカル IP に解決される DSN ホストは拒否されます。ガードは libpq / PyMySQL ドライバが解釈するすべてのルーティング形式を検査します — URL の netloc だけではありません:

- `url.host` (netloc、例: `postgresql://u:p@host/db`)。
- `?host=name` (PostgreSQL の libpq、MySQL/MariaDB の PyMySQL) — 設定された場合、SQLAlchemy の `make_url` は `url.host` を空にしますが、ドライバは TCP 接続をクエリ値にルーティングします。
- `?hostaddr=ip` (libpq) — 実際の TCP ターゲット IP。`host` と `hostaddr` の両方が設定された場合、libpq は `hostaddr` を接続に使用し、`host` は SNI / TLS 証明書検証にのみ使用します。

3 つのルーティング形式は SSRF チェックでターゲット TCP に解決できず、すべてローカルへのピボットに相当するため、初めから拒否されます:

- `?service=` (PostgreSQL) — libpq が `pg_service.conf` でパラメータを参照する。
- `?unix_socket=` (MySQL/MariaDB) — ローカル Unix ドメインソケットに接続する。
- `?host=/abs/path` (PostgreSQL) — libpq は絶対パス値を Unix ソケットディレクトリとして扱う。

ホスト情報をまったく含まないネットワークダイアレクトの DSN (例: `postgresql:///db`) も拒否されます。libpq / PyMySQL がローカルソケット / `127.0.0.1` にデフォルトしてしまうためです。

::: warning クラスタ内宛先へのオプトイン
`RECOTEM_SQL_ALLOW_PRIVATE=1` (`true` / `yes` / `on` も受け付けます) を設定することで上記の制限をオプトインできます。Docker Compose / Kubernetes のサービス名宛先、Unix ソケット接続、libpq サービスファイル向けの設定です。この環境変数は各 probe/fetch の前の **DNS リバインディング再チェックも無効化** します — オプトインはホストをエンドツーエンドで信頼することを意味します。
:::

### DNS リバインディング TOCTOU

SSRF チェックは init 時にすべての候補ルーティングホストにわたって **解決された公開 IP の完全な集合** (IPv4 + IPv6) をピン留めします。各 probe/fetch の前に、有効な TCP ターゲット (libpq: `hostaddr` > クエリ `host` > netloc、PyMySQL: クエリ `host` > netloc) を `socket.getaddrinfo` で再解決し、ピン留めされた集合と重なるアドレスがなければ実行を中断します。

これはベストエフォートの防御です — SQL ドライバは接続時に独自の解決を行うため、DNS を制御する十分に高速な攻撃者は、Recotem のチェックとドライバの解決の間にリバインドできます。プラットフォームレベルの制御 (プライベートネットワークアクセス、VPC ピアリング、ファイアウォール) を最終的な信頼境界として使用してください。

## 環境変数

| 変数 | デフォルト | 備考 |
|------|-----------|------|
| `RECOTEM_RECIPE_*` | — | `dsn_env` で名前を指定した環境変数。 |
| `RECOTEM_MAX_SQL_ROWS` | `50_000_000` | クエリが返す行数のハードキャップ。クランプ範囲 `[1_000, 500_000_000]`。 |
| `RECOTEM_SQL_ALLOW_PRIVATE` | (未設定) | 真の値 (`1`、`true`、`yes`、`on`) でプライベート / ループバック DSN ホストにオプトイン。 |

## エラーと終了コード

| エラー | 終了コード | メッセージパターン |
|--------|-----------|------------------|
| DSN 環境変数が未設定または空 | 3 | `DataSourceError: env var RECOTEM_RECIPE_DB_DSN is not set or is empty; set it to the database DSN (e.g. postgresql://user:pass@host/db)` |
| 未対応のダイアレクト | 3 | `DataSourceError: unsupported SQL dialect 'oracle'; officially supported: ['mysql', 'postgres', 'sqlite'].` |
| ダイアレクトのドライバ不在 | 3 | `DataSourceError: psycopg driver is required for dialect 'postgresql'. Install it with: pip install 'recotem[postgres]'` |
| 行数上限超過 | 3 | `DataSourceError: query result exceeds RECOTEM_MAX_SQL_ROWS=50000000 rows; tighten the query or raise the cap` |
| プライベート / ループバックホストの拒否 | 3 | `DataSourceError: refusing to connect to private/loopback host '10.0.0.5'; set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in (intended for in-cluster or compose service-name destinations)` |
| libpq サービスファイル経由のルーティング拒否 | 3 | `DataSourceError: DSN routes via libpq service file (?service=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| MySQL Unix ソケット経由のルーティング拒否 | 3 | `DataSourceError: DSN routes via Unix socket (?unix_socket=...); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| 絶対パスホストの拒否 | 3 | `DataSourceError: DSN host is an absolute path (libpq Unix-socket form); this bypasses the network SSRF guard. Set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| ホスト情報のないネットワーク DSN 拒否 | 3 | `DataSourceError: DSN for dialect 'postgresql' does not specify a host; the driver would default to the local socket / 127.0.0.1 which is rejected by the SSRF guard. Specify a host explicitly or set RECOTEM_SQL_ALLOW_PRIVATE=1 to opt in.` |
| sqlalchemy 未インストール | 3 | `DataSourceError: sqlalchemy is required for SQLSource. Install one of: recotem[postgres], recotem[mysql], recotem[sqlite].` |
| クエリ後のカラム不在 | 2 | `RecipeError: column 'item_id' not found in query result` |

すべての SQL 例外は `DataSourceError` にラップされて終了コード 3 になります。完全なエラータイプは stderr の JSON 行に含まれます。DSN の userinfo は `recotem.log_redaction` によってログ出力から取り除かれます。

## 備考

- `recotem validate recipes/my_recipe.yaml` は学習開始前に `SELECT 1` を発行してデータベースをプローブします。これにより DSN、ドライバのインストール状況、ホストへの接続性が検証されます。
- クエリ結果はストリーミング時のメモリ使用量を抑えるためにチャンク単位で読み込まれます。チャンクサイズは `min(100_000, RECOTEM_MAX_SQL_ROWS)` であり、最初のチャンクがフルにロードされる前に行数上限が強制されます。

::: warning 行数上限はメモリ上限ではありません
`RECOTEM_MAX_SQL_ROWS` は総**行数**を上限とするのみで、生成される DataFrame の常駐メモリは制限しません。チャンクはリストに蓄積されて最後に連結されるため、ピーク RAM はおおよそ `total_rows × bytes_per_row` です。デフォルトの上限 (5,000 万行) ではワイドな結果クエリで 2.5〜5 GiB の常駐メモリを想定してください。上限クランプ (5 億行) では同じクエリが 25 GiB 以上の RAM を必要とする可能性があります。行数の上限だけでなくメモリの上限が必要な場合は、上限値を厳しくするかクエリのカラムを減らしてください。`stream_results=True` によるサーバーサイドストリーミングは**ワイヤレベル**のカーソルのみを制御します。コンシューマーサイドの上限には行数上限を使用してください。
:::

- `source.query` および `source.dsn_env` は変数名に関わらず `${...}` 展開から無条件に除外されます。展開対象は `query_parameters` の値のみです。
- `flock` はホストローカルです。ホストをまたぐ場合はスケジューラレベルのミューテックスを使用してください (Kubernetes CronJob では `concurrencyPolicy: Forbid`)。
