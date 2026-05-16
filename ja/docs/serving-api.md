---
title: サービング API
---

# サービング API

`recotem serve` は FastAPI アプリケーションを HTTP 上で公開します。全エンドポイントのリクエスト / レスポンスの形状、認証要件、エラーコードをここに記載します。

## 認証

API キー認証は `X-API-Key` リクエストヘッダーを使用します。キーは `RECOTEM_API_KEYS` にカンマ区切りの `<kid>:sha256:<hex64>` エントリのリストとして設定します。サーバーは送信されたプレーンテキストを保存された scrypt ハッシュと照合します。

`RECOTEM_API_KEYS` が空の場合:
- サーバーは `RECOTEM_HOST` に関わらず `127.0.0.1` をバインドホストに強制します。
- `127.0.0.1` からの全リクエストはキーなしで受け付けられます。
- ローカル開発で認証を明示的に無効化するには `RECOTEM_ENV` を `development`、`dev`、または `test` に設定した上で `--insecure-no-auth` を使用してください。

::: warning
`X-API-Key` ヘッダーの前後の空白はキーの一部として扱われ、一致しません。送信前にクライアント側でトリムしてください。
:::

## 共通ヘッダー

| ヘッダー | 方向 | 説明 |
|----------|------|------|
| `X-API-Key` | リクエスト | 認証トークン (プレーンテキスト)。認証が必要な全エンドポイントで必須。 |
| `X-Request-ID` | リクエスト (任意) | クライアントが指定するリクエスト識別子。`[A-Za-z0-9_-]{1,64}` に一致する必要があります。一致しない値は新たに生成された UUID4 で置換されます。 |
| `X-Request-ID` | レスポンス | 内部で使用されたリクエスト ID のエコー — バリデーション済みのクライアント指定値または生成された UUID4。 |
| `X-Recotem-Metadata-Degraded` | レスポンス | レスポンス内の 1 件以上のアイテムでメタデータの参照失敗があった場合 (アイテムは学習データに存在するが、そのアイテムのメタデータ結合が失敗した場合) に `1` に設定されます。`items` リストには `item_id` と `score` のみを持つそれらのアイテムも含まれます。 |

## エンドポイント

### POST /predict/{name}

単一ユーザーに対する上位 K 件の推薦を取得します。

**認証:** 必須 (`X-API-Key`)。

**パスパラメータ:**

| パラメータ | 型 | 制約 | 説明 |
|------------|-----|------|------|
| `name` | string | `[A-Za-z0-9_-]{1,64}` | レシピ名 (レシピ YAML ファイルのステム)。 |

**リクエストボディ:**

```json
{
  "user_id": "u1",
  "cutoff": 10
}
```

| フィールド | 型 | 制約 | デフォルト | 説明 |
|------------|-----|------|-----------|------|
| `user_id` | string | required | — | 学習データに存在するユーザー識別子。 |
| `cutoff` | integer | 1〜1000 | `10` | 返すアイテム数。 |

**レスポンスボディ (200 OK):**

```json
{
  "items": [
    {
      "item_id": "item-42",
      "score": 0.9812,
      "title": "Example Item",
      "category": "news"
    },
    {
      "item_id": "item-17",
      "score": 0.8754
    }
  ],
  "model": {
    "recipe": "news_articles",
    "trained_at": "2026-05-07T01:23:45Z",
    "best_class": "IALSRecommender",
    "kid": "prod-2026-q2"
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

`items` 配列は `score` の降順に並んでいます。各アイテムには常に `item_id` と `score` が含まれます。追加フィールドはレシピの `item_metadata` ブロックで設定されたアイテムメタデータから結合されます。`RECOTEM_METADATA_FIELD_DENY` に列挙されたフィールドはレスポンスの送信前に除去されます。`item_id` または `score` という名前のメタデータカラムは、信頼されたレコメンダーの値を上書きできません。

**ステータスコード:**

| コード | 条件 | レスポンスボディの `code` フィールド |
|--------|------|-------------------------------------|
| 200 | 成功 | — |
| 401 | `X-API-Key` が欠落または不正 | `missing_api_key` または `invalid_api_key` |
| 404 | `user_id` が学習データに存在しない | `user_not_found` |
| 422 | リクエストボディのスキーマバリデーション失敗 (`user_id` の欠落、`cutoff` が範囲外) | — (FastAPI デフォルトのバリデーション形式) |
| 503 | レシピがロードされていないか異常 | `recipe_unavailable` |

**curl の例:**

```bash
curl -s -X POST http://localhost:8080/predict/news_articles \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "cutoff": 10}' | jq .
```

::: tip 404 user_not_found
未知のユーザーに対する 404 レスポンスは、学習時に存在しなかった新規ユーザーでは想定通りの動作です。アプリケーション層でこれを処理してください — 例えば人気ベースの推薦にフォールバックするなど。この 404 はサーバー側のエラー状態ではありません。
:::

---

### GET /health

全体のヘルス状態。Kubernetes の readiness プローブと liveness プローブに対応しています。

**認証:** なし (認証不要)。

**レスポンスボディ (200 OK または 503 Service Unavailable):**

```json
{
  "status": "ok",
  "total": 3,
  "loaded": 3
}
```

| フィールド | 型 | 説明 |
|------------|-----|------|
| `status` | `"ok"` \| `"degraded"` | 全登録レシピがロード済みかつエラーなしの場合 `"ok"`。いずれかのレシピが未ロードまたはロードエラーを持つ場合 `"degraded"`。 |
| `total` | integer | レジストリが認識しているレシピエントリの総数。 |
| `loaded` | integer | 正常にロードされ、推薦の配信準備ができているレシピ数。 |

**ステータスコード:**

| コード | 条件 |
|--------|------|
| 200 | 全登録レシピがロード済みかつエラーなし。 |
| 503 | 1 件以上のレシピが未ロードまたはロードエラーを持つ。 |

::: tip
プローブのロジックには HTTP ステータスコードのみを使用してください。`status: degraded` のレスポンスは 503 を返し、Kubernetes の readiness プローブがその Pod を Service エンドポイントから除外します。これは意図的な動作です — 全ての predict 呼び出しが 503 を返す Pod にはトラフィックを送るべきではありません。
:::

**curl の例:**

```bash
curl -s http://localhost:8080/health | jq .
```

---

### GET /health/details

`kid`、`trained_at`、`best_class`、ロードエラーを含むレシピごとのヘルス詳細。

**認証:** 必須 (`X-API-Key`)。

アーティファクトのキー識別子 (`kid`) が含まれるため、レシピごとの詳細は認証が必要です。これは公開されるべきではありません。認証不要のプローブ用ステータスには `GET /health` を使用してください。

**レスポンスボディ (200 OK または 503):**

```json
{
  "status": "ok",
  "recipes": {
    "news_articles": {
      "loaded": true,
      "trained_at": "2026-05-07T01:23:45Z",
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

レシピディレクトリで見つかった全レシピは、アーティファクトがロードされたかどうかに関わらずここに表示されます。起動時に失敗したレシピは `loaded: false` と `error` フィールドを持つスタブとして表示されます。オプションフィールド (`trained_at`、`best_class`、`kid`、`error`) は対応する値が設定されている場合のみ存在します。フィールドが存在しない場合、対応する値は未設定であることを意味します。

**ステータスコード:** `GET /health` と同じ — いずれかのレシピが未ロードまたはロードエラーを持つ場合は 503。

**curl の例:**

```bash
curl -s http://localhost:8080/health/details \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### GET /models

現在ロードされている全モデルのメタデータを一覧表示します。

**認証:** 必須 (`X-API-Key`)。

起動時にアーティファクトのロードに失敗したレシピのスタブエントリは除外されます — それらは `/health/details` に表示されます。

**レスポンスボディ (200 OK):**

```json
[
  {
    "name": "news_articles",
    "recipe_name": "news_articles",
    "recipe_hash": "ab12cd34...",
    "trained_at": "2026-05-07T01:23:45Z",
    "best_class": "IALSRecommender",
    "best_params": { "alpha": 1.0 },
    "best_score": 0.1234,
    "metric": "ndcg",
    "cutoff": 20,
    "tuning": { "tried_algorithms": ["IALS", "TopPop"], "n_trials": 40, "n_completed": 40 },
    "data_stats": { "n_rows": 12345, "n_users": 678, "n_items": 90 },
    "kid": "prod-2026-q2",
    "recotem_version": "2.0.0",
    "irspack_version": "0.3.14"
  }
]
```

各エントリはアーティファクトのヘッダー JSON に、登録されたレシピの `name` とアクティブな `kid` を加えたものです。鍵の素材は含まれません。ヘッダースキーマは [アーキテクチャ — アーティファクト形式](./#アーティファクト形式) に記載されています。

**curl の例:**

```bash
curl -s http://localhost:8080/models \
  -H "X-API-Key: <plaintext>" | jq .
```

---

### GET /metrics

Prometheus メトリクスの公開 (オプトイン)。

**認証:** なし (認証不要)。

**利用可能条件:** 以下の両方の条件が満たされた場合のみ登録されます:
1. `RECOTEM_METRICS_ENABLED` が真の値 (`1`、`true`、`yes`、`on`) に設定されている。
2. `recotem[metrics]` エクストラがインストールされている (`pip install "recotem[metrics]"`)。

このエンドポイントは OpenAPI スキーマから除外されています (`include_in_schema=False`)。

::: warning ネットワークへの公開
`/metrics` と `/health` は設計上認証不要です — Prometheus と Kubernetes liveness / readiness プローブが期待するスタンスと同じです。これらのエンドポイントはレシピ名、kid、ロードエラー文字列、モデルロードのタイムスタンプ、predict レイテンシのヒストグラムを公開します。API キーミドルウェアに頼るのではなく、クラスターの NetworkPolicy で制限してください。
:::

**利用可能なメトリクス:**

| メトリクス | 型 | ラベル |
|------------|-----|--------|
| `recotem_predict_total` | Counter | `recipe`, `status` |
| `recotem_predict_latency_seconds` | Histogram | `recipe` |
| `recotem_model_loaded` | Gauge | `recipe` |
| `recotem_artifact_load_failures_total` | Counter | `recipe` |
| `recotem_active_recipes` | Gauge | — |
| `recotem_swap_total` | Counter | `recipe`, `result` |
| `recotem_artifact_stat_failures_total` | Counter | `recipe` |
| `recotem_watcher_unhandled_errors_total` | Counter | — |
| `recotem_metadata_lookup_errors_total` | Counter | `recipe` |
| `recotem_recipe_rescan_errors_total` | Counter | `recipe` |
| `recotem_bigquery_storage_fallback_total` | Counter | `reason` |
| `recotem_recipes_dir_scan_failures_total` | Counter | `error_class` |

`recotem_predict_total` の `status` ラベルは `ok`、`user_not_found`、`unavailable`、`error` の値を取ります。

---

## OpenAPI ドキュメントエンドポイント

インタラクティブドキュメントは `/docs` (Swagger UI)、`/redoc`、および生のスキーマは `/openapi.json` でデフォルトで利用できます。

::: warning
`RECOTEM_ENV` が `production`、`prod`、または `staging` に設定されている場合、これら 3 つのエンドポイントは**無効化されます**。本番環境のデプロイメントではこれらに依存しないでください。
:::

---

## ミドルウェア

### TrustedHostMiddleware

`RECOTEM_ALLOWED_HOSTS` (デフォルト: `127.0.0.1,localhost`) は `Host` ヘッダーの許可リストを制御します。このリストにない `Host` ヘッダーを持つリクエストは `400 Bad Request` を受け取ります。これは `/health` を含む全エンドポイントに適用されます。

Kubernetes では、kubelet プローブはデフォルトで `Host: localhost` を送信します — `localhost` が常にデフォルトの許可リストに含まれているのはそのためです。Ingress 経由で公開する場合は、Ingress のホスト名を明示的に追加してください (または Helm チャートを使用すると `ingress.hosts` から自動的に導出されます)。

### CORS

`RECOTEM_ALLOWED_ORIGINS` (デフォルト: 空 = 全て拒否) は CORS 許可リストを設定します。空の場合、全ての CORS プリフライトリクエストが拒否されます。ブラウザベースのクライアントを許可するには、オリジンのカンマ区切りリストを指定してください。

```yaml
RECOTEM_ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com"
```
