---
title: SQL データベースからレコメンド
description: "SQL レコメンドを Recotem で実現。PostgreSQL・MySQL・SQLite の orders テーブルから直接学習し、Postgres レコメンドモデルを HTTP API として配信します。"
---

# SQL データベースからレコメンド

インタラクションデータがすでにリレーショナルデータベースにあるなら、レコメンド構築のためにエクスポート用パイプラインを用意する必要はありません。Recotem の `sql` ソースは [SQLAlchemy 2](https://www.sqlalchemy.org/) を通じて **PostgreSQL・MySQL/MariaDB・SQLite** に直接接続し、あなたが指定した `SELECT` を実行してモデルを学習し、`/v1/recipes/{name}:recommend` の HTTP エンドポイントとして配信します。

このガイドでは `SQL レコメンド` のセットアップを一通り解説します。DSN でデータベースを指し示し、`orders` クエリをユーザー×アイテムのインタラクションに整形し、レシピを書き、ライブなレコメンドを配信するまでです。同じレシピは接続文字列を変えるだけで MySQL や SQLite でも動きます。

## 必要なもの

- インタラクションを記録したテーブルを持つデータベース（PostgreSQL・MySQL/MariaDB・SQLite）。たとえば「どのユーザーがどのアイテムに触れたか」を記録する `orders`・`purchases`・`events` などのテーブルです。
- 対象テーブルに対して `SELECT` 権限を持つ**読み取り専用**のデータベースユーザー。
- 対応するドライバ extra を指定してインストールした Recotem:

```bash
pip install "recotem[postgres]"   # PostgreSQL（psycopg 経由）
pip install "recotem[mysql]"      # MySQL / MariaDB（PyMySQL 経由）
pip install "recotem[sqlite]"     # SQLite（標準ライブラリ — 追加ドライバ不要）
```

これらの extra が無いと、`recotem train` はどの extra を入れるべきかを示す `DataSourceError` で終了します。

## Recotem をデータベースに向ける

接続文字列（DSN）は**レシピには決して書き込みません**。レシピは環境変数の名前を指定するだけで、Recotem は学習時にその変数から DSN を読み取ります。変数名は `^RECOTEM_RECIPE_[A-Z0-9_]+$` に一致する必要があり、他のプレフィックスはレシピ読み込み時に拒否されます。

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://reco_ro:pass@db.internal:5432/shop?sslmode=require"
```

ダイアレクトに合わせて DSN の形式を選びます:

| ダイアレクト | DSN |
|---|---|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db?sslmode=require` |
| MySQL / MariaDB | `mysql+pymysql://user:pass@host:3306/db?ssl_ca=/path/to/ca.pem` |
| SQLite（ファイル） | `sqlite:///absolute/path/to/file.db` |
| SQLite（読み取り専用） | `sqlite:///file:absolute/path/to/file.db?mode=ro&uri=true` |

::: tip 本番では TLS を使う
PostgreSQL では `sslmode=require`（さらに厳格には `verify-ca`・`verify-full`）を、MySQL/MariaDB では `ssl_ca=/path/to/ca.pem`（または `ssl_verify_cert=true`）を設定してください。`?ssl=true` は使用**できない**綴りです — PyMySQL の `ssl` パラメータはマッピングか `ssl.SSLContext` を取り文字列を受け付けないため、空でないスカラー値は接続前にドライバー内部で失敗します。Recotem は TLS を強制しませんが、DSN が平文に見える場合は `sql_dsn_tls_not_configured` の警告を出します。
:::

### 設計として読み取り専用

データベースユーザーには `SELECT` のみの権限を付与してください。これが本来の信頼境界です。多層防御として、Recotem はクエリ実行前にセッションレベルの読み取り専用コマンドも発行します（PostgreSQL では `SET TRANSACTION READ ONLY`、MySQL/MariaDB では `SET SESSION TRANSACTION READ ONLY`、SQLite では `PRAGMA query_only = ON`）。このコマンドが失敗した場合、処理を続行せず `DataSourceError` で学習を中断します。決して黙ってスキップされることはありません。

### プライベートホスト / SSRF ガード

デフォルトでは、プライベート・ループバック・リンクローカルな IP に解決される DSN ホストは**拒否**されます。ガードはドライバが解釈するあらゆる経路指定形式（netloc、`?host=`、`?hostaddr=`、`?service=`、`?unix_socket=`、およびホスト情報を一切持たないネットワーク DSN）を検査します。これにより、悪意あるレシピが内部サービスやクラウドのメタデータエンドポイントへ横移動するのを防ぎます。

データベースが Docker Compose や Kubernetes のサービス名、あるいは Unix ソケット経由で到達する場合は、明示的にオプトインします:

```bash
export RECOTEM_SQL_ALLOW_PRIVATE=1
```

::: warning
`RECOTEM_SQL_ALLOW_PRIVATE=1` はプライベート/ループバックの宛先を許可すると同時に、DNS リバインディングの再チェックも無効化します。エンドツーエンドで信頼できるホストにのみ設定してください。ガードの全挙動は [SQL ソースリファレンス](/ja/docs/data-sources/sql) を参照してください。
:::

## インタラクションのクエリを整形する

`sql` ソースは (ユーザー, アイテム) のインタラクションごとに 1 行を必要とします。最低限、ユーザー列とアイテム列を選択します:

```sql
SELECT user_id, item_id
FROM orders
WHERE status = 'paid'
```

注文のタイムスタンプを加えると、各ユーザーの直近の行動を検証用にホールドアウトする、時系列を考慮した現実的な分割が可能になります。これは「次に買うもの」を推薦するのに最も近いオフラインの近似です。実行ごとに変わる値には SQLAlchemy の名前付きバインドパラメータ（`:name`）を使ってください。値を自分で SQL 文字列に埋め込んではいけません。`query` 内の `${...}` 展開は SQL インジェクションを封じるために明示的に禁止されているため、バインドパラメータが正しい手段です。

```sql
SELECT user_id, item_id, ordered_at
FROM orders
WHERE status = 'paid'
  AND ordered_at >= :since
```

バインドパラメータ `:since` は `query_parameters` から供給され、その値は書いたとおりに使われます。`query_parameters` は `query` と同じ no-expand リストに載っているため、そこに書いた `${RECOTEM_RECIPE_*}` は展開されずリテラル文字列としてバインドされます。つまりクエリは意図した日付ではなく文字列 `${RECOTEM_RECIPE_SINCE}` で絞り込むことになり、カラムの型によっては明確なエラーにならないまま通ってしまいます — [パラメータバインド](/ja/docs/data-sources/sql#パラメータバインド) を参照してください。日付はそのまま書いてください。期間を定期的に動かしたい場合は、SQL 側で計算する (`ordered_at >= CURRENT_DATE - INTERVAL '90 days'`) か、テンプレートからレシピを生成してください。

## レシピを書く

レシピは 1 つの YAML ファイルです。`name` + `source` + `schema` + `training` + `output` で構成します。上記の orders クエリに対応した、実行可能な完全なレシピを示します。

```yaml
name: order_recs

source:
  type: sql
  dsn_env: RECOTEM_RECIPE_DB_DSN
  query: |
    SELECT user_id, item_id, ordered_at
    FROM orders
    WHERE status = 'paid'
      AND ordered_at >= :since
  query_parameters:
    since: "2026-04-01"
  connect_timeout_seconds: 10
  statement_timeout_seconds: 300

schema:
  user_column: user_id
  item_column: item_id
  time_column: ordered_at

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
  path: ./artifacts/order_recs.recotem
  versioning: append_sha
```

上記の選択について補足します:

- `schema.time_column: ordered_at` は、分割が `scheme: time_user` を使うため必須です。`ordered_at` は本物のタイムスタンプ列なので `time_unit` は不要です（時刻列が数値の Unix タイムスタンプの場合は `time_unit: s` を追加します）。
- `algorithms` には暗黙的フィードバック向けの学習器を 3 つ挙げています。Recotem は Optuna 探索でそれらを横断し、`ndcg@20` で最良のものを残します。`TopPop` は安価な人気度の候補ですが、これが**何ではないか**に注意してください。品質のゲートではなく、探索の 1 候補にすぎません。recotem 内部の分割で最高スコアだった場合、それがそのまま出荷されます。そして**人気度に勝つことは意味のある基準ではありません** — [モデルは本当に良いのか](/ja/learn/basics/collaborative-filtering#モデルは本当に良いのか) を参照してください。他に `CosineKNN`・`DenseSLIM`・`TruncatedSVD` も選べます。`BPRFM` は Recotem と併せて `lightfm` のインストールが必要で、related 系の動詞に応答できないため、挙げる前に [インストール](/ja/guide/installation#オプションエクストラ) を確認してください。
- `cleansing.min_rows` / `min_users` / `min_items` はデータの事前条件です。クエリの返す行数が少なすぎる場合、弱いモデルを作る前に学習を早期失敗させます。

各フィールドは [レシピリファレンス](/ja/docs/recipe-reference) に、SQL 固有の詳細（タイムアウト、行数上限、エラーコード）は [SQL ソースリファレンス](/ja/docs/data-sources/sql) にすべて記載されています。

## 学習して配信する

まず、アーティファクトを改ざん検知可能にする署名鍵と、サーバー用の API キーを生成します:

```bash
recotem keygen --type signing
recotem keygen --type api

export RECOTEM_SIGNING_KEYS="dev:<hex64>"
export RECOTEM_API_KEYS="key1:sha256:<hex64>"
```

長い実行の前に接続を検証します。`recotem validate` は DSN に対して `SELECT 1` を発行し、ドライバ・認証情報・ホストがすべて動作することを確認します:

```bash
export RECOTEM_RECIPE_DB_DSN="postgresql+psycopg://reco_ro:pass@db.internal:5432/shop?sslmode=require"

recotem validate recipes/order_recs.yaml
recotem train recipes/order_recs.yaml
```

学習は署名済みアーティファクトを `./artifacts/order_recs.recotem` に書き出します。`recotem serve` をレシピのディレクトリに向けると、各レシピが生成したアーティファクトを読み込みます:

```bash
recotem serve --recipes ./recipes/ --port 8080
```

## レコメンドを取得する

生成した API キーを付けて、レシピの `:recommend` エンドポイントを呼び出します。`user_id` は学習時に登場したものである必要があります:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/order_recs:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "order_recs",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

アイテムは `score` の降順で並びます。新規顧客に対する `404 UNKNOWN_USER` は想定内なので、アプリ側で人気度ベースのレコメンドにフォールバックして処理してください。リクエスト/レスポンスの完全な仕様、関連アイテムやバッチのverb、エラーコードは [Serving API リファレンス](/ja/docs/serving-api) にあります。

## 定期的な再学習をスケジュールする

`orders` テーブルは増え続けるため、モデルはスケジュールに沿って再学習すべきです。`recotem train` は明確な終了コード契約を持つ通常のプロセスなので、どのスケジューラでも動きます。シークレットを安全に読み込み、非ゼロの終了コードに反応する cron や systemd タイマーの設定は [cron / systemd デプロイ](/ja/docs/deployment/cron-systemd) を参照してください。

::: tip 複数ホストにまたがる場合
Recotem のレシピ単位のロックはホストローカル（`flock`）です。スケジュールされた学習ジョブが複数のマシンで実行され得る場合は、スケジューラレベルのミューテックス（Kubernetes では CronJob の `concurrencyPolicy: Forbid`）を追加し、2 つの実行が同じアーティファクトを同時に書かないようにしてください。
:::

## 次のステップ

- [SQL ソースリファレンス](/ja/docs/data-sources/sql) — タイムアウト、`RECOTEM_MAX_SQL_ROWS`、SSRF ガード、全エラーコード。
- [レシピリファレンス](/ja/docs/recipe-reference) — 全フィールド・型・デフォルト値。
- [Serving API リファレンス](/ja/docs/serving-api) — エンドポイント、認証、レスポンス形式。
- [cron / systemd デプロイ](/ja/docs/deployment/cron-systemd) — 再学習のスケジュール。
- 業務データベースよりデータウェアハウス派なら [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) を、全ガイドは [Learn ハブ](/ja/learn/) をご覧ください。
