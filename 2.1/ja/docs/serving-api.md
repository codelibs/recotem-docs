---
title: "Serving API"
description: "recotem サービング API の完全リファレンス — 全エンドポイント、認証、リクエスト / レスポンスの形状、エラーコード、ミドルウェア。"
---

# Serving API

`recotem serve` は FastAPI アプリケーションを HTTP 上で公開します。全エンドポイントは `/v1` 名前空間に属します。カスタム動詞は [AIP-136](https://google.aip.dev/136) の colon-verb 規約に従います — 例: `/v1/recipes/{name}:recommend`。

## 認証

`GET /v1/health` を除く全エンドポイントは、プレーンテキストの API キーを持つ `X-API-Key` リクエストヘッダを必要とします。

キーは `RECOTEM_API_KEYS` にカンマ区切りの `<kid>:sha256:<hex64>` エントリのリストとして設定します。サーバーは送信されたプレーンテキストを、エントリに格納された scrypt 派生ハッシュと照合します (scrypt パラメータ: N=2, r=8, p=1, salt=`recotem.api-key.v1`)。キーの長さは 32〜256 文字でなければなりません。

有効な API キーを生成するには以下のコマンドを使用します:

```bash
recotem keygen --type api
```

このコマンドは 43 文字の base64url 文字列を生成します。これがプレーンテキストのキーとして使用できます。対応する `sha256:<hex64>` ダイジェストも出力されるため、`RECOTEM_API_KEYS` に設定してください。

`RECOTEM_API_KEYS` が空で、かつ `--insecure-no-auth` が指定されていない場合:

- `RECOTEM_HOST` の設定に関わらず、サーバーはバインドホストを `127.0.0.1` に強制します。
- 全リクエストはキーなしで受け付けられます (クライアントはログ上 `kid=anonymous` としてタグ付けされます)。

::: warning
`X-API-Key` ヘッダの前後の空白はキーの一部として扱われるため、一致しません。送信前にクライアント側でトリムしてください。
:::

## 共通ヘッダ

| ヘッダ | 方向 | 説明 |
|---|---|---|
| `X-API-Key` | リクエスト | 認証トークン (プレーンテキスト)。`GET /v1/health` を除く全エンドポイントで必須。 |
| `X-Request-ID` | リクエスト / レスポンス | クライアントが指定するリクエスト識別子。`^[A-Za-z0-9_-]{1,128}$` に一致する必要があります。一致しない値または省略された値の場合、サーバーは新たに 12 桁の 16 進数識別子を生成します。実際に使用された値はレスポンスにエコーされます。 |
| `X-Recotem-Model-Version` | レスポンス | リクエストを処理したレシピのモデルバージョンハッシュ (`sha256:<64-hex>`)。全ての推薦レスポンスに付与されます。レスポンスボディの `model_version` フィールドと同じ値です。 |
| `X-Recotem-Items-Degraded` | レスポンス | 単一推薦エンドポイントのみ。メタデータの結合がフォールバックになった、またはドロップされたアイテムの総数が設定されます。レスポンスが完全にクリーンな場合は付与されません。バッチエンドポイントでは送信されません。 |

## レシピ名の形式

パスパラメータとして使用するレシピ名は `^[A-Za-z0-9_-]{1,64}$` に一致する必要があります。一致しない名前のパスはルーターによって拒否されます — URL のパース方法によって、レスポンスは `404 Not Found` または `422 Unprocessable Entity` のどちらかになります。

## エンドポイント

### 推薦

#### POST /v1/recipes/{name}:recommend

単一ユーザーに対する上位 K 件の推薦を取得します。

**認証:** 必須 (`X-API-Key`)。

**パスパラメータ:** `name` — `^[A-Za-z0-9_-]{1,64}$` に一致するレシピ名。

**リクエストボディ** (`extra` フィールドは禁止):

| フィールド | 型 | 制約 | デフォルト | 説明 |
|---|---|---|---|---|
| `user_id` | string | 必須、1〜256 文字 | — | 学習データに存在するユーザー識別子。 |
| `limit` | integer | 1〜1000 | `10` | 返すアイテムの最大数。 |
| `exclude_items` | string[] \| null | 任意、最大 1000 件 | null | 結果から除外するアイテム ID。 |

```json
{
  "user_id": "u1",
  "limit": 10,
  "exclude_items": ["item-99"]
}
```

**レスポンスボディ (200 OK):**

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91, "title": "Example Item", "category": "books"},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

アイテムは `score` の降順に並んでいます。`score` フィールドは常に有限数です (NaN および Inf は内部で拒否されます)。各アイテムには常に `item_id` と `score` が含まれます。追加フィールドはレシピの `item_metadata` ブロックで設定されたアイテムメタデータから結合されます。`RecommendItem` はフィールドの追加を許容するため、メタデータ由来のフィールドが `item_id` と `score` とともに表示されます。

**ステータスコード:**

| コード | 条件 | エラーコード |
|---|---|---|
| 200 | 成功 | — |
| 401 | `X-API-Key` が欠落 | `MISSING_API_KEY` |
| 401 | キーがどのエントリとも一致しない | `INVALID_API_KEY` |
| 404 | `user_id` が学習時に存在しなかった | `UNKNOWN_USER` |
| 422 | リクエストボディのスキーマバリデーション失敗 | `VALIDATION_ERROR` |
| 503 | レシピがロードされていない | `RECIPE_UNAVAILABLE` |

::: tip UNKNOWN_USER はサーバーエラーではありません
未知のユーザーに対する 404 は、学習時に存在しなかった新規ユーザーでは想定通りの動作です。アプリケーション層でこれを処理してください — 例えば人気ベースの推薦にフォールバックするなど。
:::

**curl の例:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

---

#### POST /v1/recipes/{name}:recommend-related

1 件以上のシードアイテムに関連するアイテムを取得します。

**認証:** 必須 (`X-API-Key`)。

**リクエストボディ:**

| フィールド | 型 | 制約 | デフォルト | 説明 |
|---|---|---|---|---|
| `seed_items` | string[] | 必須、1〜100 件 | — | シードとして使用するアイテム ID。 |
| `limit` | integer | 1〜1000 | `10` | 返すアイテムの最大数。 |
| `exclude_items` | string[] \| null | 任意 | null | 結果から除外するアイテム ID。 |

```json
{
  "seed_items": ["item-42", "item-17"],
  "limit": 10
}
```

**レスポンスボディ (200 OK):** `:recommend` と同じ形状。

**ステータスコード:**

| コード | 条件 | エラーコード |
|---|---|---|
| 200 | 成功 | — |
| 401 | 認証失敗 | `MISSING_API_KEY` / `INVALID_API_KEY` |
| 404 | シードアイテムが全てモデルに未知 | `UNKNOWN_SEED_ITEMS` |
| 404 | シードは既知だがランキング後に候補が残らない | `NO_CANDIDATES` |
| 422 | スキーマバリデーション失敗 | `VALIDATION_ERROR` |
| 503 | レシピがロードされていない | `RECIPE_UNAVAILABLE` |

**curl の例:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["item-42"], "limit": 5}' | jq .
```

---

#### POST /v1/recipes/{name}:batch-recommend

単一リクエストで複数ユーザーの推薦を取得します。Algolia スタイルのバッチエンベロープを使用します。

**認証:** 必須 (`X-API-Key`)。

**リクエストボディ:**

| フィールド | 型 | 制約 | デフォルト | 説明 |
|---|---|---|---|---|
| `requests` | RecommendRequest[] | 1〜256 件 | — | ユーザーごとの推薦リクエスト。各要素は `:recommend` ボディと同じ形状。 |
| `include_metadata` | boolean | — | `false` | `false` の場合、バルクパフォーマンスのためメタデータ結合フィールドが `items` から省略されます。単一ユーザーエンドポイントと同じアイテム形状を得るには `true` に設定してください。 |

```json
{
  "requests": [
    {"user_id": "u1", "limit": 5},
    {"user_id": "u2", "limit": 5, "exclude_items": ["item-99"]}
  ],
  "include_metadata": false
}
```

**レスポンスボディ (200 OK):**

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "results": [
    {
      "index": 0,
      "status": "ok",
      "items": [{"item_id": "item-42", "score": 0.91}]
    },
    {
      "index": 1,
      "status": "error",
      "error": {"code": "UNKNOWN_USER", "message": "user not seen during training"}
    }
  ]
}
```

`results` は `index` フィールドによって `requests` の元の順序を保持します。失敗した要素は `status: "error"` と `error` オブジェクトを持ちます。同じバッチ内の他の要素は引き続き処理されます。

**バッチ固有のルール:**

- `requests` 配列は 1〜256 件でなければなりません。この範囲外の配列はリクエスト全体に対して `422` を返します。
- 全 `requests[].limit` の合計は **5000** を超えてはなりません。合計がこの上限を超える要素は要素単位の `VALIDATION_ERROR` 結果を受け取ります。以降の要素は引き続き処理されます。
- スキーマエラーを持つ個別の要素はバッチ全体を失敗させません。その要素は要素単位の `VALIDATION_ERROR` 結果を受け取り、HTTP レスポンス全体は `200` のままです。
- `X-Recotem-Items-Degraded` はバッチレスポンスでは送信されません。
- `503` が返されるのはレシピ自体が利用不可 (未ロード) の場合のみです。`UNKNOWN_USER` などの要素単位のエラーは HTTP ステータスコードに影響しません。

**curl の例:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:batch-recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"user_id": "u1", "limit": 5},
      {"user_id": "u2", "limit": 5}
    ],
    "include_metadata": false
  }' | jq .
```

---

#### POST /v1/recipes/{name}:batch-recommend-related

単一リクエストで複数シードのアイテム関連推薦を取得します。

**認証:** 必須 (`X-API-Key`)。

**リクエストボディ:** `:batch-recommend` と同じエンベロープで、各要素は `:recommend-related` ボディの形状に従います。

```json
{
  "requests": [
    {"seed_items": ["item-42"], "limit": 5},
    {"seed_items": ["item-17", "item-8"], "limit": 10}
  ],
  "include_metadata": false
}
```

**レスポンスボディ (200 OK):** `:batch-recommend` と同じエンベロープ。

**バッチルール:** 上記の `:batch-recommend` と同一。

**curl の例:**

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:batch-recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"seed_items": ["item-42"], "limit": 5}
    ]
  }' | jq .
```

---

### レシピディスカバリ

#### GET /v1/recipes

現在ロードされている全レシピを一覧表示します。

**認証:** 必須 (`X-API-Key`)。

起動時にアーティファクトまたは YAML のロードに失敗したレシピのスタブエントリは除外されます — それらは `GET /v1/health/details` に表示されます。

**レスポンスボディ (200 OK):**

```json
{
  "recipes": [
    {
      "name": "purchase_log",
      "model_version": "sha256:a3f2...e91d",
      "loaded_at": "2026-05-21T00:00:00Z",
      "supported_verbs": [
        "recommend",
        "recommend-related",
        "batch-recommend",
        "batch-recommend-related"
      ],
      "kind": "user-item"
    }
  ]
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | レシピ名 (レシピ YAML ファイルのステム)。 |
| `model_version` | string | アーティファクトの `sha256:<64-hex>` ダイジェスト。 |
| `loaded_at` | string (ISO 8601) | アーティファクトがメモリにロードされたタイムスタンプ。 |
| `supported_verbs` | string[] | このレシピがサポートする colon-verb。レシピの `kind` に依存します。 |
| `kind` | `"user-item"` \| `"item-item"` | モデルがユーザー対アイテムまたはアイテム対アイテムの推薦を生成するかどうか。`"item-item"` レシピは `recommend` および `batch-recommend` をサポートしません。 |

**curl の例:**

```bash
curl -s http://localhost:8080/v1/recipes \
  -H "X-API-Key: <plaintext>" | jq .
```

---

#### GET /v1/recipes/{name}

単一のロード済みレシピの詳細メタデータを取得します。

**認証:** 必須 (`X-API-Key`)。

**レスポンスボディ (200 OK):**

`GET /v1/recipes` の全フィールドに加えて:

| フィールド | 型 | 説明 |
|---|---|---|
| `config_digest` | string \| null | レシピ YAML の `sha256:<hex>`。利用不可の場合は null。 |
| `algorithms` | string[] | チューニング中に評価された全アルゴリズムクラス。 |
| `best_algorithm` | string | 最良として選択されたアルゴリズムクラス。 |
| `best_class` | string \| null | 最良アルゴリズムの完全修飾クラス名。 |
| `best_params` | object \| null | 最良アルゴリズムのハイパーパラメータ。 |
| `best_score` | number \| null | 最良モデルのバリデーションスコア。NaN および Inf は null に正規化されます。 |
| `metric` | `"ndcg"` \| `"map"` \| `"recall"` \| `"hit"` \| null | チューニング時に使用した評価指標。 |
| `cutoff` | integer \| null | チューニング時のオフライン評価指標の計算に使用したカットオフ K。これはリクエストごとの `limit` とは無関係であり、学習時にレシピがどのようにスコアリングされたかを表すのみです。 |
| `tuning` | object \| null | チューニングメタデータ (`tried_algorithms`、`n_trials`、`n_completed`)。 |
| `data_stats` | object \| null | 学習データの統計情報 (`n_rows`、`n_users`、`n_items`)。 |
| `recotem_version` | string \| null | このアーティファクトを学習した recotem のバージョン。 |
| `irspack_version` | string \| null | 学習時に使用した irspack のバージョン。 |
| `recipe_hash` | string \| null | 学習時のレシピ設定の 64 文字の小文字 16 進ダイジェスト (`sha256:` プレフィックスなし。`config_digest` とは異なる形式)。 |
| `trained_at` | string (ISO 8601) \| null | 学習が完了したタイムスタンプ。 |

上記のオプションフィールドは、それらを記録していない旧アーティファクトでは `null` になります。

**ステータスコード:**

| コード | 条件 | エラーコード |
|---|---|---|
| 200 | レシピがロード済み | — |
| 404 | レシピ名がレジストリに存在しない | `RECIPE_NOT_FOUND` |
| 503 | レシピは存在するがロードされていない | `RECIPE_UNAVAILABLE` |

**curl の例:**

```bash
curl -s http://localhost:8080/v1/recipes/purchase_log \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### ヘルスとメトリクス

#### GET /v1/health

全体の liveness および readiness ステータス。Kubernetes の liveness プローブおよび readiness プローブに対応しています。

**認証:** なし (認証不要)。

**レスポンスボディ:**

```json
{"status": "ok", "total": 3, "loaded": 3}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` | 全ての設定済みレシピがロードされている場合 `"ok"`。いずれかのレシピが未ロードの場合 `"degraded"`。`total == 0` の場合、ステータスは常に `"ok"`。 |
| `total` | integer | レジストリ内のレシピエントリの総数。 |
| `loaded` | integer | 正常にロードされ、配信準備ができているレシピ数。 |

**ステータスコード:**

| コード | 条件 |
|---|---|
| 200 | 全レシピがロード済み。 |
| 503 | 1 件以上のレシピが未ロード。 |

::: tip Kubernetes readiness プローブ
`503` レスポンスは Pod を Service エンドポイントから除外します。これは意図的な動作です — 全ての推薦リクエストが `503` を返す Pod にはトラフィックを送るべきではありません。readiness プローブと liveness プローブの両方に `GET /v1/health` を使用してください。
:::

**curl の例:**

```bash
curl -s http://localhost:8080/v1/health | jq .
```

---

#### GET /v1/health/details

ロードエラーとアーティファクト識別子を含むレシピごとのヘルス詳細。

**認証:** 必須 (`X-API-Key`)。

レシピごとの詳細は、公開されるべきでないアーティファクトのキー識別子 (`kid`) を含むため、認証が必要です。認証不要のプローブ用ステータスには `GET /v1/health` を使用してください。

**レスポンスボディ:**

```json
{
  "status": "ok",
  "recipes": {
    "purchase_log": {
      "loaded": true,
      "trained_at": "2026-05-21T00:00:00Z",
      "best_class": "IALSRecommender",
      "kid": "prod-2026-q2"
    },
    "product_recs": {
      "loaded": false,
      "error": "signature mismatch"
    }
  }
}
```

起動時にロードに失敗したレシピのスタブを含め、レジストリ内の全レシピがここに表示されます。オプションフィールド (`trained_at`、`best_class`、`kid`、`error`) は対応する値が設定されている場合のみ存在します。

**ステータスコード:** `GET /v1/health` と同じ — いずれかのレシピが `loaded: false` または `error` フィールドを持つ場合は `503`。

**curl の例:**

```bash
curl -s http://localhost:8080/v1/health/details \
  -H "X-API-Key: <plaintext>" | jq .
```

---

#### GET /v1/metrics

Prometheus メトリクスの公開 (オプトイン)。

**認証:** 必須 (`X-API-Key`)。

**利用可能条件:** 以下の両方の条件が満たされた場合のみこのルートが登録されます:

1. `RECOTEM_METRICS_ENABLED` が真の値 (`1`、`true`、`yes`、`on`) に設定されている。
2. `recotem[metrics]` エクストラがインストールされている (`pip install "recotem[metrics]"`)。

このエンドポイントは OpenAPI スキーマから除外されています。

::: warning Prometheus スクレイパーの設定
多くの Prometheus ターゲットとは異なり、`/v1/metrics` は `X-API-Key` を必要とします。スクレイパーにヘッダを送信するよう設定してください:

```yaml
# prometheus.yml スクレイプ設定 (Prometheus 2.45+)
scrape_configs:
  - job_name: recotem
    metrics_path: /v1/metrics
    static_configs:
      - targets: ["localhost:8080"]
    http_headers:
      X-API-Key:
        values: ["<plaintext>"]
```
:::

**利用可能なメトリクス:**

| メトリクス | 型 | ラベル |
|---|---|---|
| `recotem_v1_requests_total` | Counter | `recipe`, `verb`, `status` |
| `recotem_v1_request_latency_seconds` | Histogram | `recipe`, `verb` |
| `recotem_v1_batch_size` | Histogram | `recipe`, `verb` |
| `recotem_v1_batch_element_errors_total` | Counter | `recipe`, `verb`, `code` |
| `recotem_v1_metadata_degraded_items_total` | Counter | `recipe`, `verb`, `kind` |
| `recotem_v1_validation_errors_outside_verb_total` | Counter | — |
| `recotem_model_loaded` | Gauge | `recipe` |
| `recotem_artifact_load_failures_total` | Counter | `recipe`, `reason` |
| `recotem_active_recipes` | Gauge | — |
| `recotem_swap_total` | Counter | `recipe`, `result` |
| `recotem_artifact_stat_failures_total` | Counter | `recipe` |
| `recotem_watcher_unhandled_errors_total` | Counter | — |
| `recotem_metadata_index_build_errors_total` | Counter | `recipe` |
| `recotem_metadata_serialization_errors_total` | Counter | `recipe`, `verb` |
| `recotem_recipe_rescan_errors_total` | Counter | `recipe` |
| `recotem_recommender_layout_unexpected_total` | Counter | `recipe` |
| `recotem_watcher_state_divergence_total` | Counter | — |
| `recotem_bigquery_storage_fallback_total` | Counter | `reason` |
| `recotem_recipes_dir_scan_failures_total` | Counter | `error_class` |

`verb` ラベルは `recommend`、`recommend-related`、`batch-recommend`、`batch-recommend-related` の値を取ります。`recotem_v1_requests_total` の `status` ラベルは `ok`、`unknown_user`、`unknown_seed_items`、`no_candidates`、`unavailable`、`recipe_not_found`、`validation_error`、`error` の 8 値を取ります。`recotem_artifact_load_failures_total` の `reason` ラベルは `read`、`parse`、`hmac`、`header_json`、`deserialize`、`metadata`、`yaml`、`unexpected`、`dir_scan`、`timeout` の値を取ります。

**curl の例:**

```bash
curl -s http://localhost:8080/v1/metrics \
  -H "X-API-Key: <plaintext>"
```

---

## エラーフォーマット

全てのエラーレスポンスは、最低限 `detail` (人間が読める形式) と `code` (機械が読める UPPER_SNAKE_CASE 形式) を持つフラットな JSON ボディを使用します。

**標準エラーボディ:**

```json
{"detail": "recipe purchase_log is not loaded", "code": "RECIPE_UNAVAILABLE"}
```

**バリデーションエラーボディ (422 のみ):** `request_id` と構造化された `errors` 配列を含みます。

```json
{
  "request_id": "a1b2c3d4e5f6",
  "detail": "Request validation failed",
  "code": "VALIDATION_ERROR",
  "errors": [
    {"loc": ["body", "limit"], "msg": "ensure this value is less than or equal to 1000", "type": "value_error.number.not_le"}
  ]
}
```

**内部エラーボディ (500 のみ):** サーバーログとの照合のために `request_id` を含みます。

```json
{"detail": "internal error", "code": "INTERNAL_ERROR", "request_id": "a1b2c3d4e5f6"}
```

### エラーコード

| コード | HTTP | 発生条件 |
|---|---|---|
| `RECIPE_UNAVAILABLE` | 503 | レシピはレジストリに存在するが、そのアーティファクトがロードされていない。 |
| `RECIPE_NOT_FOUND` | 404 | レシピ名がレジストリに全く存在しない。 |
| `UNKNOWN_USER` | 404 | `user_id` が学習の idmap に存在しなかった。 |
| `UNKNOWN_SEED_ITEMS` | 404 | `seed_items` の全アイテムがモデルに未知。 |
| `NO_CANDIDATES` | 404 | シードアイテムは既知だが、ランキングステージを経て候補が残らなかった。 |
| `VALIDATION_ERROR` | 422 (HTTP) / 要素単位 (バッチ) | リクエストまたは要素ボディのスキーマバリデーション失敗。 |
| `MISSING_API_KEY` | 401 | `X-API-Key` ヘッダが存在しない。 |
| `INVALID_API_KEY` | 401 | `X-API-Key` が設定済みのどのキーとも一致しない。 |
| `INTERNAL_ERROR` | 500 (HTTP) / 要素単位 (バッチ) | リクエスト処理中に未処理の例外が発生した。 |

---

## ミドルウェア

### TrustedHostMiddleware

`RECOTEM_ALLOWED_HOSTS` (デフォルト: `127.0.0.1,localhost`) は `Host` ヘッダの許可リストを制御します。このリストにない `Host` ヘッダを持つリクエストは `400 Bad Request` を受け取ります。これは `GET /v1/health` を含む全エンドポイントに適用されます。

Kubernetes では、kubelet プローブはデフォルトで `Host: localhost` を送信します — `localhost` が常にデフォルトの許可リストに含まれているのはそのためです。Ingress 経由で公開する場合は、`RECOTEM_ALLOWED_HOSTS` に Ingress のホスト名を明示的に追加してください。

### CORS

`RECOTEM_ALLOWED_ORIGINS` (デフォルト: 空 = 全て拒否) は CORS 許可リストを設定します。空の場合、全ての CORS プリフライトリクエストが拒否されます。ブラウザベースのクライアントを許可するには、オリジンのカンマ区切りリストを指定してください。

```yaml
RECOTEM_ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com"
```

---

## OpenAPI ドキュメント

インタラクティブドキュメントは `/docs` (Swagger UI) および `/redoc` で利用できます。生のスキーマは `/openapi.json` で参照できます。

::: warning 開発環境専用
これら 3 つのエンドポイントは `RECOTEM_ENV` が `development`、`dev`、または `test` に設定されている場合のみ利用可能です。それ以外の全ての環境では無効化されます。本番環境のデプロイメントではこれらに依存しないでください。
:::
