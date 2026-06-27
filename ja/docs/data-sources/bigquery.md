---
title: BigQuery ソース
---

# BigQuery ソース

## インストール

```bash
pip install "recotem[bigquery]"
```

このエクストラなしで `recotem train` を実行すると、欠けているパッケージに応じて以下のいずれかのメッセージで終了します:

```
DataSourceError: google-cloud-bigquery is required for BigQuerySource. Install it with: pip install recotem[bigquery]
DataSourceError: db-dtypes is required for BigQuerySource. Install it with: pip install recotem[bigquery]
```

## 認証

Recotem は Application Default Credentials (ADC) を使用します。レシピに認証情報を埋め込みません。`google-cloud-bigquery` クライアント自体が標準の ADC チェーン (`GOOGLE_APPLICATION_CREDENTIALS` → `gcloud` ユーザー認証情報 → メタデータサーバー) を走査します — Recotem はこれらの環境変数を直接参照しません。

ADC のセットアップ方法:

```bash
# Local development
gcloud auth application-default login

# Service account key (not recommended for production)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

# GCE / GKE / Cloud Run / Vertex AI
# No action needed. The metadata server provides credentials automatically.
```

`source.project` (レシピフィールド) は BigQuery クライアントの課金プロジェクトとして転送されます。省略した場合、クライアントは ADC のアンビエントプロジェクト (ユーザー認証情報の場合は `gcloud config get project`、またはサービスアカウントのプロジェクト) を使用します。`location` のレシピフィールドはありません — BigQuery はクエリで参照されるデータセットから場所を推定します。

BigQuery データセットに必要な IAM ロール: `roles/bigquery.dataViewer` + プロジェクトへの `roles/bigquery.jobUser`。

Storage Read API (大規模な結果セットに使用) の場合: `roles/bigquery.readSessionUser`。このロールは**任意**です — 取得パスは最初に `create_bqstorage_client=True` を試みます。Storage Read API の失敗は**IAM 形状の失敗** (PermissionDenied / Forbidden / 403) の場合のみ REST へのフォールバックにマッピングされます。クォータエラー、5xx バックエンド失敗、その他の非パーミッションエラーは `DataSourceError` を発生させるため、REST フォールバックによる二重課金が発生しません。`RECOTEM_BQ_REQUIRE_STORAGE_API=1` を設定すると IAM フォールバックパスを完全に無効化できます (`bigquery.readSessions.create` 権限が必要)。

Recotem が使用するサービスアカウントに推奨する最小限のロールセット:

| ロール | スコープ |
|--------|---------|
| `roles/bigquery.jobUser` | プロジェクト |
| `roles/bigquery.dataViewer` | クエリ対象のデータセット |
| `roles/bigquery.readSessionUser` | プロジェクト (Storage Read API 用) |

## レシピ設定

```yaml
source:
  type: bigquery
  query: |
    SELECT ...
  query_parameters:        # optional
    key: value
  project: my-gcp-project  # optional; falls back to ADC ambient project
```

## パラメータバインド

実行間で変動する値には BigQuery 名前付きパラメータ (`@name`) を使用してください。`query` に Python 文字列フォーマットや `${...}` 展開を使用**しないでください** — どちらもサポートされておらず、後者は明示的にブロックされています。

```yaml
source:
  type: bigquery
  query: |
    SELECT user_id, item_id, ts
    FROM `proj.dataset.events`
    WHERE event_date BETWEEN @start_date AND @end_date
      AND event_name = @event_name
  query_parameters:
    start_date: "2026-04-01"
    end_date: "2026-05-07"
    event_name: "purchase"
```

パラメータの型は値の Python 型から推論されます:

| YAML / Python 型 | BigQuery 型 |
|------------------|-------------|
| `bool` (`true` / `false`) | `BOOL` |
| `int` | `INT64` |
| `float` | `FLOAT64` |
| `str` | `STRING` |

`bool` は `int` より先にチェックされます (YAML の `true` が `INT64 1` にならないようにするため)。リスト、dict、`null`、日付、タイムスタンプは**サポートされていません**。パラメータディスパッチャーが実行されるたびに `DataSourceError` が発生します。つまり `recotem validate` (`probe()` 経由) と取得時の両方で発生します。日付は `STRING` としてエンコードし (例: `"2026-04-01"`)、SQL で `PARSE_DATE` でパースするか、SQL で `CURRENT_DATE()` / `DATE_SUB()` を使って日付範囲を計算してください (下記の GA4 の例を参照)。

YAML のクォートは重要です: `lookback_days: 30` は `INT64`、`lookback_days: "30"` は `STRING`。SQL のパラメータ型と不一致の場合、ドライランが `Query parameter '@lookback_days' has type STRING which differs from declared type INT64` のようなメッセージで失敗します。

## GA4 events_* パターン

GA4 は `events_YYYYMMDD` という名前の日付シャードテーブルを使って BigQuery にエクスポートします。`_TABLE_SUFFIX` を使うと、フルテーブルスキャンなしで日付範囲でフィルタリングできます。

### `item_id` はどこから来るのか

Recotem はクエリが返した DataFrame を読み込み、`schema` で指定したカラムが**そのままの名前で**存在することを前提とします — 正規表現・式・導出カラムを指定するレシピフィールドは**ありません**（`schema` で指定できるのは `user_column`、`item_column`、`time_column`、`time_unit` のみ）。さらに BigQuery ソースは、それらのカラムが結果に含まれているかどうかを**事前検証しません**。したがって抽出や整形はすべて `REGEXP_EXTRACT` などの BigQuery 関数を使って **SQL クエリの中**で行う必要があり、`SELECT` のエイリアスは `schema` で参照する名前と一致させる必要があります。

### 推奨: `page_location` から `item_id` を導出する

`page_location`（ページ URL）は、どの GA4 エクスポートでも `page_view` イベントごとに記録され、**追加のタグ設定や GTM 設定は不要**です。そのため、生のアクセスログだけから「この記事を見た人はこの記事も見ています」型のレコメンダーを構築するのに最も汎用性の高いシグナルになります。最もシンプルで汎用的な選択は、URL の**パス**をアイテムとして使うことです:

```yaml
source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                                                    AS user_id,
      REGEXP_EXTRACT(
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
        r'^https?://[^/]+([^?#]*)'                       -- path only; drop host, query, fragment
      )                                                                 AS item_id,
      TIMESTAMP_MICROS(event_timestamp)                                 AS ts
    FROM
      `my-project.analytics_123456789.events_*`
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name = 'page_view'
```

```yaml
schema:
  user_column: user_id
  item_column: item_id
  time_column: ts
cleansing:
  drop_null_ids: true   # REGEXP_EXTRACT はマッチしないと NULL を返す — その行を除去する
```

これはパラメータバインドなしでローリング 30 日間のウィンドウをカバーし（日付は SQL で計算）、個々のパスを 1 つのアイテムとして扱います。`drop_null_ids` のデフォルトは `true` です。[レシピリファレンス → cleansing](../recipe-reference#cleansing) を参照してください。

URL に**安定した識別子**（商品 / 記事 / コンテンツ ID）が含まれている場合は、その ID だけを抽出することで、スラッグに依存しないより厳密なアイテム空間を得られます。URL 中の無関係な数字（例: `/2026/04/12/` の日付パスにある `2026`）を拾わないよう、区切り文字でマッチさせます:

```sql
-- .../articles/12345-some-title       -> "12345"  (パスセグメント後の数値 ID)
REGEXP_EXTRACT(page_location, r'/articles/(\d+)')

-- .../some-title-(A12B)/              -> "A12B"   (括弧内の 4 文字英数字 ID。
--                                                  全角の （ ） にもマッチ)
REGEXP_EXTRACT(page_location, r'[（(]([0-9A-Z]{4})[）)]')
```

パターンは自分の URL スキームに合わせて調整してください。RE2（BigQuery の正規表現エンジン）は `\d`、文字クラス、全角括弧などの UTF-8 リテラルをサポートします。

### 代替: カスタムイベントパラメータ

専用の識別子をカスタムイベントパラメータとして既に送信している場合（サイト側の GA4 / GTM 設定が必要）は、`event_params` から読み取ります。パラメータの送信方法に合わせて型アクセサ（`value.int_value` / `value.string_value`）を置き換えてください:

```yaml
source:
  type: bigquery
  project: my-project
  query: |
    SELECT
      user_pseudo_id                                                   AS user_id,
      (SELECT value.int_value
         FROM UNNEST(event_params)
        WHERE key = 'article_id')                                      AS item_id,
      TIMESTAMP_MICROS(event_timestamp)                                AS ts
    FROM
      `my-project.analytics_123456789.events_*`
    WHERE
      _TABLE_SUFFIX BETWEEN
        FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name = 'select_content'
      AND (SELECT value.int_value
             FROM UNNEST(event_params)
            WHERE key = 'article_id') IS NOT NULL
```

出力カラムは上記の `page_location` の例と同じように `schema` でマッピングします。

## サービングとレコメンド

`recotem train` が署名済みアーティファクトを書き出したら、`recotem serve` をレシピのディレクトリに向けて起動し、レシピの `:recommend` エンドポイントを呼び出します。レシピ `name` はレシピ YAML ファイル名のステム（拡張子を除いた部分）です:

```bash
curl -X POST http://localhost:8080/v1/recipes/{name}:recommend \
     -H "X-API-Key: <plaintext-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"user_id": "<a user value seen during training>", "limit": 10}'
```

- `user_id` は `schema.user_column` でマッピングした値です（GA4 では一般に `user_pseudo_id`）。学習時に出現しなかったユーザーは `404 UNKNOWN_USER` を返します。
- ユーザーなしでアイテム間レコメンドを得るには、既知の `item_id` のリストを `seed_items` に指定して `:recommend-related` を呼び出します。
- `RECOTEM_API_KEYS` を設定しない場合、サーバーはループバック（`127.0.0.1`）にバインドし、認証なしのリクエストを受け付けます。

リクエスト / レスポンスの完全な形式は [Serving API](../serving-api) リファレンスを、API キーの設定は [運用](../operations) ガイドを参照してください。

## エラーと終了コード

| エラー | 終了コード | メッセージパターン |
|--------|-----------|------------------|
| ADC 認証情報が見つからない | 3 | `DataSourceError: Could not obtain credentials. Run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS.` |
| データセットへのアクセス拒否 | 3 | `DataSourceError: Access Denied: Dataset my-project:analytics_123456789` |
| クエリ構文エラー | 3 | `DataSourceError: Syntax error: ...` |
| `schema` のカラムがクエリ結果に存在しない | 1 | 未処理エラー（`code: internal_error`）。BigQuery ソースはカラムを検証しないため、`schema` と一致しない `SELECT` エイリアスは `RecipeError` ではなく後段のクレンジング処理で表面化します。 |
| エクストラ未インストール | 3 | `DataSourceError: google-cloud-bigquery is required for BigQuerySource`（または `db-dtypes is required for BigQuerySource`） |

すべての BigQuery 例外は `DataSourceError` にラップされて終了コード 3 になります。BigQuery の完全なエラーメッセージは stderr の JSON 行に含まれます。

## Storage Read API のフォールバックポリシー

Recotem は大規模な結果セットの効率化のために、まず BigQuery Storage Read API (`create_bqstorage_client=True`) を試みます。標準 REST API へのフォールバックは**選択的**であり、無条件ではありません:

- **IAM 形状の失敗** (PermissionDenied / Forbidden / HTTP 403): Storage Read API は暗黙的にスキップされ、REST パスが使用されます。`roles/bigquery.readSessionUser` が付与されていない一般的なケースをカバーします。
- **その他のすべての失敗** (クォータ超過、5xx バックエンドエラー、ネットワークタイムアウトなど): REST フォールバックを試みることなく即座に `DataSourceError` が発生します。これにより、クォータ超過の Storage Read API 呼び出しが REST でリトライされることによる二重課金を防ぎます。

Storage Read API の使用を強制し IAM フォールバックパスを完全に無効化するには:

```bash
export RECOTEM_BQ_REQUIRE_STORAGE_API=1
```

この変数が真の値 (`1`、`true`、`yes`、`on`) の場合、Storage Read API の失敗は REST へのフォールバックの代わりに `DataSourceError` を発生させます。サービスアカウントが `bigquery.readSessions.create` を保持することが期待され、強制的に検証したい場合にこの設定を使用してください。

## 備考

- `recotem validate recipes/my_recipe.yaml` は学習開始前に ADC 認証をプローブし、クエリを BigQuery のドライランジョブ (`use_query_cache=False`) として送信します。ドライランジョブは課金されず、クエリを実行しません。ドライランは `query_parameters` の型も検証します — 不正な型は取得時ではなくここで表面化します。
- ドライランは `total_bytes_processed` の推定値をユーザーに公開**しません**。Recotem は `maximum_bytes_billed` も設定しないため、暴走クエリはプロジェクトの BigQuery クォータによってのみ制限されます。コストの暴走が懸念される場合は GCP プロジェクトレベルで `--maximum-bytes-billed` に相当するガードレールを追加してください。
- クエリ結果は利用可能な場合に Storage Read API 経由でストリーミングされます。非常に大きな結果セット (> 1,000 万行) は Recotem に渡す前にデータウェアハウスで事前集約してください。
- `GOOGLE_*` および `GCP_*` 環境変数はレシピの `${...}` 展開からブラックリストされています (大文字小文字を区別しない)。クラウド認証情報はレシピファイルではなく ADC から提供する必要があります。`source.query` と `source.query_parameters` は変数名に関わらず `${...}` 展開から無条件に除外されます。
