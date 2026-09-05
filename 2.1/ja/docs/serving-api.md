---
title: "Serving API"
description: "recotem サービング API の完全リファレンス — 全エンドポイント、認証、リクエスト / レスポンスの形状、エラーコード、ミドルウェア。"
---

# Serving API

`recotem serve` は FastAPI アプリケーションを HTTP 上で公開します。全エンドポイントは `/v1` 名前空間に属します。カスタム動詞は [AIP-136](https://google.aip.dev/136) の colon-verb 規約に従います — 例: `/v1/recipes/{name}:recommend`。

## 認証

認証不要の 3 つのプローブ (`GET /v1/health`、`GET /v1/health/live`、`GET /v1/health/ready`) を除く全エンドポイントは、プレーンテキストの API キーを持つ `X-API-Key` リクエストヘッダを必要とします。

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
| `X-API-Key` | リクエスト | 認証トークン (プレーンテキスト)。3 つのプローブ `GET /v1/health`、`GET /v1/health/live`、`GET /v1/health/ready` を除く全エンドポイントで必須。 |
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
| `user_features` | object \| null | 任意、最大 64 キー。キーは 1〜256 文字、文字列値は 8192 文字以下 | null | レシピの `features.user` カラム名をキーとする生のフィーチャー値。[`features:`](./recipe-reference#features) ブロックで学習したモデルに対してのみ意味を持ちます。[フィーチャーアウェアなコールドスタート](#フィーチャーアウェアなコールドスタート) を参照。 |

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
| 400 | `user_features` が渡されたがモデルに対応するフィーチャー状態がない | `FEATURES_NOT_SUPPORTED` |
| 400 | `numerical` のフィーチャー値がコールドスタートソルバーで扱えない大きさに標準化された | `FEATURE_VALUE_UNUSABLE` |
| 401 | `X-API-Key` が欠落 | `MISSING_API_KEY` |
| 401 | キーがどのエントリとも一致しない | `INVALID_API_KEY` |
| 404 | `user_id` が学習時に存在しなかった (かつ利用可能な `user_features` が渡されなかった) | `UNKNOWN_USER` |
| 413 | リクエストボディが `RECOTEM_MAX_BODY_BYTES` を超過 | `PAYLOAD_TOO_LARGE` |
| 422 | リクエストボディのスキーマバリデーション失敗 | `VALIDATION_ERROR` |
| 503 | レシピがロードされていない | `RECIPE_UNAVAILABLE` |

::: tip UNKNOWN_USER はサーバーエラーではありません
未知のユーザーに対する 404 は、学習時に存在しなかった新規ユーザーでは想定通りの動作です。アプリケーション層でこれを処理してください — 例えば人気ベースの推薦にフォールバックするなど。[`features:`](./recipe-reference#features) ブロックで学習したモデルであれば、代わりに `user_features` を渡すことでその新規ユーザーに対しても実際の推薦を得られます。[フィーチャーアウェアなコールドスタート](#フィーチャーアウェアなコールドスタート) を参照してください。
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
| `user_features` | object \| null | 任意、最大 64 キー。キーは 1〜256 文字、文字列値は 8192 文字以下 | null | レシピの `features.user` カラム名をキーとする生のフィーチャー値。シード履歴のソルブにプロファイルの事前分布を加えます。[フィーチャーアウェアなコールドスタート](#フィーチャーアウェアなコールドスタート) を参照。 |
| `item_features` | object[string, object] \| null | 任意、外側のキーは最大 100 件。各値は最大 64 キー | null | 学習時に存在しなかったシードアイテムの生のフィーチャー値。シードアイテム ID をキーとします。[フィーチャーアウェアなコールドスタート](#フィーチャーアウェアなコールドスタート) を参照。 |

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
| 400 | `user_features` / `item_features` が渡されたがモデルに対応するフィーチャー状態がない | `FEATURES_NOT_SUPPORTED` |
| 400 | `numerical` のフィーチャー値がコールドスタートソルバーで扱えない大きさに標準化された | `FEATURE_VALUE_UNUSABLE` |
| 401 | 認証失敗 | `MISSING_API_KEY` / `INVALID_API_KEY` |
| 404 | シードアイテムが全てモデルに未知 | `UNKNOWN_SEED_ITEMS` |
| 404 | シードは既知だがランキング後に候補が残らない | `NO_CANDIDATES` |
| 413 | リクエストボディが `RECOTEM_MAX_BODY_BYTES` を超過 | `PAYLOAD_TOO_LARGE` |
| 422 | スキーマバリデーション失敗 | `VALIDATION_ERROR` |
| 501 | 学習済みアルゴリズムが `seed_items` から作る合成ユーザーをスコアリングできない | `RELATED_NOT_SUPPORTED` |
| 503 | レシピがロードされていない | `RECIPE_UNAVAILABLE` |

::: warning BPRFM のレシピは related 系の動詞に応答できません
`BPRFMRecommender` は、サポート対象アルゴリズムの中で唯一 `get_score_cold_user` を実装していません。これはこの動詞が `seed_items` から作る合成ユーザーをスコアリングするために必要なものです。探索の勝者が BPRFM になったレシピは、ここでは **`501 RELATED_NOT_SUPPORTED`** を返し、[`:batch-recommend-related`](#post-v1-recipes-name-batch-recommend-related) では `200` の中に要素ごとの `RELATED_NOT_SUPPORTED` を返します。`:recommend` と `:batch-recommend` は影響を受けません:

```console
$ curl -s -w '\nHTTP=%{http_code}\n' -X POST ".../v1/recipes/bprfm_demo:recommend-related" \
    -H "X-API-Key: <plaintext>" -H "Content-Type: application/json" \
    -d '{"seed_items":["291"],"limit":3}'
{"detail":"BPRFMRecommender cannot score a synthetic user built from seed_items, so this
recipe supports :recommend and :batch-recommend only. Retrain the recipe with an algorithm
that does (every supported algorithm except BPRFM) if the related verbs are required.",
 "code":"RELATED_NOT_SUPPORTED"}
HTTP=501
```

アルゴリズムは Optuna の探索が選ぶため、`training.algorithms` に `BPRFM` を他と並べて挙げると、この動詞が使えるかどうかはどれが勝つかに依存します。アプリケーションが関連アイテムを必要とするなら `BPRFM` を挙げないでください。それでも勝った場合は、デプロイ前に `recotem inspect` の `best_class` で確認できます。クライアントのリトライロジックでは `503` と `501` を分けてください。`503` はアーティファクトがロードされれば解消しますが、`501` は再学習しない限り決して解消しません。
:::

`NO_CANDIDATES` はこの動詞のすべての分岐 — 全シード既知の経路と、2 つのフィーチャーアウェアなコールドスタート分岐 — で同一に送出されます。したがってどの経路が処理したかに関わらず、クライアントは HTTP ステータスで分岐できます。

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
| `requests` | RecommendRequest[] | 1〜256 件 | — | ユーザーごとの推薦リクエスト。各要素は `:recommend` ボディと同じ形状で、任意の `user_features` コールドスタートマッピングも含みます。 |
| `include_metadata` | boolean | — | `false` | `false` の場合、バルクパフォーマンスのためメタデータ結合フィールドが `items` から省略されます。単一ユーザーエンドポイントと同じアイテム形状を得るには `true` に設定してください。 |

各要素は単一の `:recommend` エンドポイントとまったく同じように `user_features` を受け付けます ([フィーチャーアウェアなコールドスタート](#フィーチャーアウェアなコールドスタート) を参照)。対応するフィーチャー状態を持たないモデルの要素は、バッチ全体を失敗させるのではなく `status: "error"`、`code: "FEATURES_NOT_SUPPORTED"` として現れます。バルクなコールドスタートではバッチ処理が推奨経路でもあります — リクエストあたりのソルブを 300〜500 µs からユーザーあたり 8〜12 µs まで償却します。

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
- スキーマエラーを持つ個別の要素はバッチ全体を失敗させません。その要素は要素単位の `VALIDATION_ERROR` 結果を受け取り、HTTP レスポンス全体は `200` のままです。コールドスタートのキー長・値の型・値の長さの違反も、`422` でバッチ全体を失敗させるのではなく同じ形で現れます。
- `X-Recotem-Items-Degraded` はバッチレスポンスでは送信されません。
- `503` が返されるのはレシピ自体が利用不可 (未ロード) の場合のみです。`UNKNOWN_USER` などの要素単位のエラーは HTTP ステータスコードに影響しません。
- リクエストボディ全体は引き続き `RECOTEM_MAX_BODY_BYTES` (デフォルト 128 MiB) で制限されます。上限を超えるボディは JSON がパースされる前に `413 PAYLOAD_TOO_LARGE` で拒否されます。

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

| フィールド | 型 | 制約 | デフォルト | 説明 |
|---|---|---|---|---|
| `requests` | RecommendRelatedRequest[] | 1〜256 件 | — | シードごとの関連アイテムリクエスト。各要素は `:recommend-related` ボディと同じ形状で、任意の `user_features` および `item_features` コールドスタートマッピングも含みます。 |
| `include_metadata` | boolean | — | `false` | `false` の場合、メタデータ結合フィールドが `items` から省略されます。単一シードエンドポイントと同じアイテム形状を得るには `true` に設定してください。 |

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

**バッチルール:** 上記の `:batch-recommend` と同一。さらに集計上限がもう 1 つあります。

::: warning 注意 — コールドシードのソルブ集計上限: 512
この動詞には `:batch-recommend` には不要な*第 2 の*集計上限があります。[ケース C](#フィーチャーアウェアなコールドスタート) はコールドシード 1 件につき 1 回のソルブを実行するため、コールドシードの集計件数 — 各要素の `item_features` で指名されたシードの全要素にわたる `sum` — が **512** を超えてはなりません。累計がこの上限を超える要素は、集計 `limit` の上限とまったく同様に `status: "error"`、`code: "VALIDATION_ERROR"` として現れ、以降の要素は引き続き処理されます。

2 つの上限は異なる次元を守っており、どちらか一方が他方を包含することはありません。`sum(limit)` はレスポンスの量を制限し、こちらはソルバーの作業量を制限します。`limit: 1` の要素からなるバッチは集計 `limit` 上限の 2% にとどまりながら 25,600 回のソルブを要求します。件数はリクエストのみから算出されます — `item_features` で指名されたシードは、結果的に既知アイテムで学習済み埋め込みが使われる場合でもカウントされます — したがって同じボディはどのモデルがロードされていても常に同一に受理または拒否されます。

単一の `:recommend-related` 呼び出しがこの上限に達することはありません。`seed_items` は最大 100 件なので、最大でも 1 リクエストあたり 100 回のソルブです。
:::

各要素は単一の `:recommend-related` エンドポイントとまったく同じように `user_features` / `item_features` を受け付けます。ケース A/B/C の優先順位ルールも同じです。候補が 1 件も残らなかった要素は、どの分岐であっても `status: "error"`、`code: "NO_CANDIDATES"` として現れます。

学習済みアルゴリズムが合成ユーザーをスコアリングできないレシピ (該当するのは BPRFM のみ) では、**すべての** 要素が `status: "error"`、`code: "RELATED_NOT_SUPPORTED"` として現れ、HTTP ステータスは `200` のままです。単一動詞の形では代わりに `501` が返ります。[`:recommend-related`](#post-v1-recipes-name-recommend-related) の警告を参照してください。

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

認証不要のプローブ用エンドポイントが 3 つあり、それぞれ別の問いに答えます。Kubernetes の各プローブは対応するものに向けてください — [`GET /v1/health/ready`](#get-v1-health-ready) の下の表を参照。

#### GET /v1/health

「設定された**すべての**レシピが揃っているか?」— 厳格なカウントベースのゲート。`startupProbe` に使ってください。liveness / readiness には使わないでください。

**認証:** なし (認証不要)。

**レスポンスボディ:**

```json
{"status": "ok", "total": 3, "loaded": 3}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` | `total` に数えられた全レシピがロードされている場合 `"ok"`。そのいずれかが未ロードの場合 `"degraded"`。`total == 0` の場合、ステータスは常に `"ok"`。 |
| `total` | integer | レジストリ内のレシピエントリ数。まったくパースできなかったファイルは **除外** される。 |
| `loaded` | integer | 正常にロードされ、配信準備ができているレシピ数。 |
| `skipped` | integer | まったくパースできなかったレシピファイルの数 (YAML 構文エラー、スキーマ違反)。**0 でない場合にのみ現れる。** `total` と `loaded` からは除外される: そのファイルはレシピを宣言していないため、ステータスを `"degraded"` にすることはない。[運用 — パースできないレシピファイル](./operations#パースできないレシピファイル) を参照。 |

**ステータスコード:**

| コード | 条件 |
|---|---|
| 200 | 全レシピがロード済み。`skipped` が 0 でなくてもこれは変わらない。 |
| 503 | 1 件以上のレシピが未ロード。 |

::: warning liveness / readiness をこのエンドポイントに向けないでください
`total` が数えるのはロード可能なモデルではなくレシピです。そのため、**まだ学習されていないレシピが 1 つあるだけでプロセス全体が `503`** になります — 他のレシピはすべて `200` を返し続けているのに、です:

```console
$ curl -s -w ' HTTP=%{http_code}\n' localhost:8080/v1/health
{"status":"degraded","total":2,"loaded":1} HTTP=503

$ curl -s -w '\nHTTP=%{http_code}\n' -X POST \
    "localhost:8080/v1/recipes/purchase_log:recommend" \
    -H "X-API-Key: <plaintext>" -H "Content-Type: application/json" \
    -d '{"user_id":"1","limit":3}'
{"request_id":"c2bc70c2c907","recipe":"purchase_log", ... }
HTTP=200
```

`readinessProbe` に使うと全レプリカが Service から外れます — すべて同じレシピディレクトリを読むため、同時に落ちます。`livenessProbe` ではさらに悪く、kubelet が Pod を再起動し、置き換わった Pod も同じディレクトリを読んで同じように失敗し、CrashLoopBackOff になります。再起動のたびにロード済みだったモデルまで失われます。存在しないアーティファクトは再起動では生まれません。この 2 つのプローブには [`/v1/health/ready`](#get-v1-health-ready) と [`/v1/health/live`](#get-v1-health-live) を使い、`/v1/health` は厳格なゲートが望ましい `startupProbe` に残してください。

レシピの 2 つの失敗モードはここで挙動が分かれます。**パースできないレシピファイル** は `skipped` カウント付きの `200` を返します。**アーティファクトをロードできない正常なレシピ** は `503 degraded` を返します。`skipped` はページング (呼び出し) ではなく警告として通知してください。
:::

**curl の例:**

```bash
curl -s http://localhost:8080/v1/health | jq .
```

---

#### GET /v1/health/live

「再起動すれば直るか?」— liveness プローブ用。プロセスが応答できる限り常に `200` を返します。アーティファクトの状態を一切読まず、レジストリのロックも取らないため、ホットスワップの背後でブロックして健全なプロセスを死亡と報告することがありません。

**認証:** なし (認証不要)。

**レスポンスボディ:**

```json
{"status": "alive"}
```

**ステータスコード:**

| コード | 条件 |
|---|---|
| 200 | プロセスが HTTP に応答している。 |

失敗レスポンスはありません。アーティファクトが欠落している/ロードできない場合、「再起動すれば直るか?」の答えは常に「いいえ」だからです。

**curl の例:**

```bash
curl -s http://localhost:8080/v1/health/live | jq .
```

---

#### GET /v1/health/ready

「このレプリカに Service のトラフィックを流してよいか?」— readiness プローブ用。レシピが 1 つ以上ロードされていれば `200`、1 つもなければ `503`。

**認証:** なし (認証不要)。

**レスポンスボディ:**

```json
{"status": "ready", "total": 3, "loaded": 3}
```

フィールドは `GET /v1/health` と同じで、`status` が `"ok"` / `"degraded"` ではなく `"ready"` / `"unready"` を取ります。`skipped` は 0 でない場合のみ現れます。

**ステータスコード:**

| コード | 条件 |
|---|---|
| 200 | レシピが 1 つ以上ロード済み、またはレジストリが空 (`total == 0`)。 |
| 503 | `total > 0` かつ 1 つもロードされていない — `train` が一度も動いていないコールドなフリート。 |

14 個中 13 個のモデルを保持しているレプリカは、その 13 個を配信できます。それを Service から外しても誰の役にも立ちません。コールドなフリートは引き続き失敗し、これが初回インストール時の保証を守ります: `train` が何かを生成するまで `serve` は Service に入りません。

**curl の例:**

```bash
curl -s http://localhost:8080/v1/health/ready | jq .
```

::: tip どのプローブにどのエンドポイントか
| プローブ | エンドポイント | 答える問い |
|---|---|---|
| `startupProbe` | `/v1/health` | 設定された全レシピが揃っているか (初回起動時の厳格なゲート) |
| `readinessProbe` | `/v1/health/ready` | このレプリカは何か 1 つでも配信できるか |
| `livenessProbe` | `/v1/health/live` | プロセスはまだ応答しているか |

同梱の Helm チャートがレンダリングするのはこの構成で、[Kubernetes デプロイのページ](./deployment/kubernetes#deployment-serve) が示すのも同じです。3 つとも `Host: localhost` を送るため、`RECOTEM_ALLOWED_HOSTS` にはこれを含める必要があります。
:::

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
| `recotem_v1_feature_unknown_value_total` | Counter | `recipe`、`side`、`column` |
| `recotem_v1_feature_unknown_column_total` | Counter | `recipe`、`side` |
| `recotem_v1_cold_start_requests_total` | Counter | `recipe`、`case` |
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

`verb` ラベルは `recommend`、`recommend-related`、`batch-recommend`、`batch-recommend-related` の値を取ります。`recotem_v1_requests_total` の `status` ラベルは `ok`、`unknown_user`、`unknown_seed_items`、`no_candidates`、`unavailable`、`recipe_not_found`、`validation_error`、`features_not_supported`、`feature_value_unusable`、`error` の 10 値を取ります。`recotem_artifact_load_failures_total` の `reason` ラベルは `read`、`parse`、`hmac`、`header_json`、`deserialize`、`metadata`、`yaml`、`unexpected`、`dir_scan`、`timeout`、`version_skew`、`feature_version`、`feature_state` の値を取ります。`recotem_v1_cold_start_requests_total` の `case` ラベルは `features_only` (ケース A)、`features_and_history` (ケース B)、`cold_seeds` (ケース C) の値を取ります。

::: warning 注意 — `status="error"` はサーバー障害のみ
`features_not_supported` と `feature_value_unusable` はクライアント起因の結果であり、不正なクライアントがオンコールを呼び出せないよう専用の `status` ラベルを持っています。アラートは `status="error"` に厳密に設定してください — `status!="ok"` では決して設定しないでください。
:::

**curl の例:**

```bash
curl -s http://localhost:8080/v1/metrics \
  -H "X-API-Key: <plaintext>"
```

---

## フィーチャーアウェアなコールドスタート

`user_features` と `item_features` は [`features:`](./recipe-reference#features) ブロックで学習したモデルに対してのみ意味を持ちます。これらはどのモデルでも受理され検証されますが、対応するフィーチャー状態を持たないモデル — あるいは探索の勝者がフィーチャー非対応であるモデル — は、フィールドを黙って無視したり推測したりせず `400 FEATURES_NOT_SUPPORTED` を返します。

あるアーティファクトがこれらのケースを提供できるかどうかは、リクエストを送らずに事前に読み取れます。`recotem inspect` は `features.active` を出力し、これは探索の勝者が実際にエンコーダ状態を利用できる場合にのみ `true` になります。`features` キーをまったく持たないアーティファクト、または `"active": false` のアーティファクトは `FEATURES_NOT_SUPPORTED` を返します — [レシピリファレンス — アーティファクトヘッダーが記録する内容](./recipe-reference#アーティファクトヘッダーが記録する内容) を参照してください。

### 3 つのケース

| ケース | 動詞 | トリガー | 動作 |
|---|---|---|---|
| A — 未知ユーザー、フィーチャーのみ | `:recommend` | `user_id` が未知で `user_features` が存在 | プロファイルのみに対してすべての既知アイテムをスコアリングします (このユーザーにはまだインタラクション履歴が存在しません)。 |
| B — 未知ユーザー、フィーチャー + アドホックな履歴 | `:recommend-related` | `user_features` が存在 | 既存経路と同じシード履歴のソルブを実行し、プロファイルを結合事前分布として加えます。これはどちらか一方ではなく真の結合ソルブであり、フィーチャーのみのスコアとも履歴のみのスコアとも相関しません。 |
| C — 未知のシードアイテム | `:recommend-related` | 1 件以上の `seed_items` が学習時に存在せず、`item_features` に対応するエントリがある | 各コールドシードの埋め込みをそのフィーチャーから計算し、既知シードの学習済み埋め込みと平均して、アイテム間類似度としてスコアリングします。 |

`:recommend-related` でコールドシードの `item_features` **と** `user_features` の両方が渡された場合は、**ケース C が優先されます**。コールドシードはケース B のソルブが使うシード履歴行列に行を持たないため、ケース B だけを実行するとそのシードの寄与が黙って失われます。コールドシードのフィーチャーを実際に利用できる経路はケース C だけです。

各ケースは `recotem_v1_cold_start_requests_total` を、それぞれ `features_only`、`features_and_history`、`cold_seeds` の `case` ラベルで増加させます。

::: tip ヒント — 既知の `user_id` に `user_features` を渡してもエラーにはなりません
そのユーザーの実際のインタラクション履歴から学習された埋め込みはプロファイルの事前分布を厳密に上回るため、サーバーは常に前者を優先し、渡された `user_features` を単に**無視**します — リクエストを拒否することはありません。これによりクライアントは、そのユーザーが新規か再訪かを事前に知らなくても、常にプロファイルを送信できます。
:::

### 宣言されていないフィーチャーキーは黙って無視されます

宣言されたカラムに該当しないフィーチャーキーはエラーでは**ありません**。エンコードはモデルが*宣言した* `features:` のカラムから駆動されるため、そのサイドのどの宣言済みカラムにも一致しない `user_features` / `item_features` のキーは決して読まれません。リクエストはエラーフィールドなしで `200` を返し、そのキーが拒否されたことを示すものはボディに何も含まれません。

サーバー側の唯一のシグナルは `recotem_v1_feature_unknown_column_total` メトリクスです。ラベルは recipe と**サイドのみ — キー名は決して含まれません**。そうしたキーを 1 つ以上含むリクエストごと、サイドごとに 1 回増加します。これは*宣言済み*カラムにおける未知の*値* (下記) とは別で、そちらも `200` を返しますが `recotem_v1_feature_unknown_value_total` で別途カウントされます。

::: danger クライアントはフィーチャーキーの検証を API に頼ってはいけません
*すべての*キーが誤字である (あるいは誤ったサイドに向けられている) マッピングは、バイアスカラムのみにエンコードされ、**母集団の事前分布に基づく結果**を返します — 空の `user_features` が生成するのと同じ出力であり、レスポンス上では区別できません。黙って無視されたキーは、レスポンス上では、たまたま何のシグナルも追加しなかった正しいリクエストとバイト単位で同一です。
:::

### 未知のフィーチャー値は劣化するだけで、リクエストは失敗しません

「劣化」が何を意味するか、そして `recotem_v1_feature_unknown_value_total` が実際にそれを捕捉するかどうかは、エンコーディングによって異なります。

- `categorical` — 学習時ボキャブラリに存在しない値はそのカラムの全ゼロセグメントにエンコードされ、カウンターが増加します。
- `multi_label` — 各トークンが独立に参照されます。既知のトークンは保持され (入力内で繰り返されていても、それぞれ自身の次元にちょうど `1.0` を寄与します)、未知のトークンは破棄されます。同じ値の中に既知のトークンがあっても、供給されたトークンの**いずれか**がボキャブラリから外れればカウンターは増加します。`"Action|Thrller"` のような混在した値は既知トークンのビットを立て、`Thrller` を破棄し、それでもカウンターを増加させます — 部分的な誤字は黙って吸収されるのではなく捕捉されます。
- `numerical` — **欠損**値 (不在、`null`、`NaN`)、または数値としてまったくパースできない値は行に何も寄与せず、標準化された平均 (`0`) をエンコードするのと等価であり、カウンターを増加させ**ません**。数値としてパースできるが**非有限**である値 (`Infinity` / `-Infinity`、または `"nan"` のような文字列から到達する `NaN`) も行に何も寄与しませんが、このケースはカウンターを増加させ**ます**。不在の値ではなく、サーバーが利用できなかった実在する値だからです。

::: warning 注意 — `numerical` カラムの汎用的な誤字検出器ではありません
**欠損またはパース不能**な `numerical` 値は、何のシグナルもないまま推薦を劣化させ続けます — カバーされるのは上記の非有限のケースのみです。`categorical` と `multi_label` はどちらも確実にカバーされます。
:::

`multi_label` はカウントベクトルではなく multi-**hot** です。`"rock|pop|rock"` は `rock` の次元に `2.0` ではなく `1.0` を寄与します — 1 つの値の中の重複トークンは、学習時もコールドスタートリクエストでもエンコード前に重複除去されます。

### 大きな数値: 広いサイレント劣化帯と、400 になる極端な裾

上記の欠損・パース不能のケースとは異なり、`numerical` 値はサービング時に、そのカラムの*学習時*の平均/標準偏差でリクエスト値を割ることで標準化されます — リクエスト自身の値は含まれていないフィットです。結果として生じる大きさに上限を課すものは何もないため、挙動は「正常」と「ハード 400」のきれいな 2 分割には**なりません**。学習時標準偏差 ≈ 0.425 のカラムに対する実測のスイープでは次のようになりました。

| 値 | 結果 |
|---|---|
| `0.3` | `200`、小さく、正常に見えるスコア |
| `100` | `200`、ただしスコアはすでに明らかに退化している (順序のみで、プロファイルに比例しなくなっている) |
| `1e6` – `1e18` | `200`、値が大きくなるにつれてスコアが際限なく増大する (数億以上へ) |
| 約 `1e19` 以上 | `400 FEATURE_VALUE_UNUSABLE` — ここで初めて irspack のリクエストごとのコールドスタートソルバー自身が諦めます |

::: danger およそ `1e2` から `1e18` はサイレントな劣化です
この帯域ではレスポンスは `200` で、際限のない実質的に無意味なスコアと固定化・退化したランキングが返ります — そしてこれらの有限値はいずれも `recotem_v1_feature_unknown_value_total` に触れません (このカウンターが `numerical` 値で発火するのは非有限の場合のみです)。したがってサーバー側でも何も知らせません。

400 が発生するのは、標準化後の大きさが背後の共役勾配法のソルブを特異にするほど大きくなった場合のみです。**正確な境界は固定の定数ではありません** — カラムの学習時標準偏差と、その系を解く BLAS 実装に依存するため、境界値 (例えば `1e22`) を契約としてハードコードしないでください。
:::

400 の `detail` メッセージが記述するのはクライアントの生の値ではなく**標準化後**の値です。生の値が極端である必要はないからです。学習時標準偏差が十分に小さいカラムでは、`10000` のような普通の生の値でも、通常サイズの標準偏差に対する `1e22` と同じようにソルバーを壊す大きさに標準化されえます。したがって `detail` の文字列は、渡された値そのものが極端だったとは決して主張せず、結果として生じた*標準化後*の値がこのモデルのコールドスタートスコアリングにとって数値的に利用不能だったと述べます。これはどちら側 (生の値の大きさか、極小の標準偏差か) が原因であっても真です。

ほぼ定数のカラムは別のバグではなく、標準偏差が小さいケースの特殊例です。そしてその最も一般的な原因には学習側で下限が設けられています。`build_encoder_state` は、`numerical` カラムの学習時標準偏差が `1e-8 × max(abs(mean), 1.0)` 以下である場合に、それをゼロに丸めます — 実際の意図的な小さい分散を保ちつつ、現実的な浮動小数点の丸め誤差を吸収できるだけの厳密さです。この下限に捕捉されたカラムは標準化の除算にそもそも到達せず、欠損値とまったく同じように劣化します (`feature_zero_variance_column` として 1 度だけログに記録されます)。400 にはなりません。ただしこれは現象一般を解消するものではありません。丸め誤差ではない真に小さい分散を持ち、下限のわずかに上にあるカラムは、上記のスイープと同じ仕組みで普通の値を利用不能な大きさに標準化します。

標準化後の大きさをソルバーに渡す前にクランプすること — これはサイレント劣化帯を塞ぎます — は見落としではなく意図的に見送られました。クランプの境界 (学習時標準偏差の何倍を「大きすぎる」とするか) を決めることは、同じエンコーディングを利用する学習を含むすべての下流に影響するモデリング上の決定であり、400 の経路のバグ修正ではないからです。

いずれにせよ学習は影響を受けません。学習時のエンコードを通る同じ値はこのガードの影響を受けず、ガードはサービング時のコールドスタートのソルブのみを包みます。学習側にははるかに強い自己制約があります — `numerical` カラムの学習時の平均/標準偏差は標準化される値そのものから計算されるため、外れ値はそれ自身が割られる標準偏差を膨らませます。サービング時にはそのような自己制約はありません。リクエストの値は、それを含まずにフィットされた標準偏差に対して標準化されるからです。

### コールドスタートフィールドの長さとサイズの上限

コールドスタートのフィーチャーマッピングは 3 つの軸で制限され、いずれもモデルに到達する前に拒否されます。

| 軸 | 上限 | 上限超過時 |
|---|---|---|
| キー数 | `user_features` / `item_features` マッピングごとに **64 キー**以下。`item_features` はさらに外側のシード ID キーを **100** に制限します。 | `422 VALIDATION_ERROR` |
| キー長 | 各フィーチャー辞書のキー (`user_features` のカラム名、`item_features` の外側のシード ID、ネストされたシードごとのフィーチャーキー) は **1〜256 文字**である必要があります。 | `422`。エラーは違反した長さのみを報告し、キーのテキストは決して含みません |
| 値の型 | 各フィーチャー値は JSON の**スカラー** (文字列、数値、真偽値、`null`) である必要があります。 | 配列やオブジェクトは `422` |
| 値の長さ | 各*文字列*のフィーチャー値は **8192 文字以下**である必要があります (`multi_label` のトークナイズ処理を制限します)。文字列以外のスカラーは影響を受けません。 | `422`。エラーは違反したカラム名を示しますが、値そのものは決して出力しません |

値の型のルールは単なるサイズガードではありません。値は `str(value)` を介してエンコードされるため、配列は Python の repr として学習時ボキャブラリと照合されることになり、決して何にも一致しません — もともと何もしない操作であり、ただコストが高いだけでした。

バッチ動詞では、キー長・値の型・値の長さの違反は、バッチ全体を失敗させるのではなく `200` のバッチレスポンス内の要素ごとの `VALIDATION_ERROR` として現れます。

これらのフィールドごとの上限とは独立に、**リクエストボディ全体**が `RECOTEM_MAX_BODY_BYTES` (デフォルト **128 MiB**、`[1 MiB, 2 GiB]` にクランプ) で制限されます。この上限を超えるボディは JSON がパースされる**前**に `413 PAYLOAD_TOO_LARGE` で拒否されるため、ボディがどのフィールドを持つかに関わらずすべての POST エンドポイントに適用されます。

::: warning 注意 — フィーチャー値は個人データです
`user_features` と `item_features` は構造上、個人データ (年齢層、国、デバイスカテゴリなど) を運びます。生のフィーチャー値がログに記録されることはなく、レスポンスボディに反映されることもありません。[セキュリティ — リクエスト側の PII](./security#リクエスト側の-pii-user-features-item-features) を参照してください。
:::

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
| `FEATURES_NOT_SUPPORTED` | 400 (HTTP) / 要素単位 (バッチ) | 対応するフィーチャー状態を持たないモデルに `user_features` / `item_features` が渡された — `features:` ブロックがないか、探索の勝者がエンコーダ状態を利用できない (`features.active: false`)。 |
| `FEATURE_VALUE_UNUSABLE` | 400 | `numerical` のフィーチャー値が、リクエストごとのコールドスタートのソルブを数値的に特異にする大きさに標準化された。メッセージが示すのは*標準化後*の値であり、生の値ではない。 |
| `RELATED_NOT_SUPPORTED` | 501 (HTTP) / 要素ごと (バッチ) | レシピの学習済みアルゴリズムが `seed_items` から作る合成ユーザーをスコアリングできないため、related 系 2 動詞が使えない。この位置に来るサポート対象アルゴリズムは `BPRFMRecommender` だけ。リトライしても決して解消せず、別のアルゴリズムでの再学習が必要。 |
| `PAYLOAD_TOO_LARGE` | 413 | リクエストボディが `RECOTEM_MAX_BODY_BYTES` (デフォルト 128 MiB) を超過。JSON がパースされる前に、すべての POST エンドポイントで適用される。 |
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
