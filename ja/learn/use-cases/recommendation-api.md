---
title: アプリに自前のレコメンド API を追加する
description: "レコメンド API を自前で構築する方法。Recotem の :recommend / :recommend-related / バッチエンドポイントを X-API-Key 認証付きで HTTP 配信します。curl と Python の例つき。"
---

# アプリに自前のレコメンド API を追加する

モデルを学習し終えたら、最後の仕上げはそれを HTTP API としてアプリケーションに
公開することです。`recotem serve` は、レシピを置いたディレクトリを
**自前のレコメンド API** に変えます。自分のインフラ上で動く FastAPI サーバーで、
認証も自分で管理でき、リクエストごとの課金もなく、顧客データがネットワークの外に
出ることもありません。

このガイドでは、利用できるエンドポイント、認証方法、そして `curl` と Python
クライアントからの呼び出し方を順に説明します。`recotem train` で署名済みの
アーティファクトを既に作成していることを前提としています(まだの場合は
[GA4 × BigQuery のユースケース](/ja/learn/use-cases/ga4-bigquery)
から始めてください)。

## なぜ SaaS ではなく自前で持つのか

マネージドのレコメンドサービスは手軽に始められますが、規模が大きくなるにつれて、
自前の API が有利になる観点がいくつかあります。

- **データの所在。** インタラクションログや商品カタログが自分の環境の外に出ません。
  モデルの学習も配信もすべて自分の VPC 内で完結するため、コンプライアンス
  (GDPR、個人情報保護、社内のデータ取り扱いポリシー) への対応がシンプルになります。
- **コストの予測しやすさ。** レコメンド単位・ユーザー単位の課金がありません。
  支払うのは動かした計算リソース分だけで、1 つのコンテナで毎秒数千リクエストを
  さばけます。
- **ロックインがない。** レシピはただの YAML ファイル、アーティファクトは可搬な
  署名済みバイナリです。連携部分を書き直すことなく、パイプライン一式をクラウド間や
  オンプレミスへ移せます。
- **リクエスト経路を完全に制御できる。** リバースプロキシ、レート制限、認証方式、
  ネットワーク境界を自分で選べます。

代償として、運用は自分の責任になります。デプロイ、スケーリング、TLS 終端は
自分で担う必要があります。この点はこのガイドの後半と
[Docker デプロイガイド](/ja/docs/deployment/docker) で扱います。

## 利用できるエンドポイント

ロードした各レシピは `/v1/recipes/{name}:<verb>` の下に公開され、
[AIP-136](https://google.aip.dev/136) の colon-verb 規約に従います。
`purchase_log` という名前のレシピは、次のレコメンド動詞を提供します。

| 動詞 | 用途 |
|---|---|
| `POST /v1/recipes/purchase_log:recommend` | 単一ユーザーへの上位 K 件。 |
| `POST /v1/recipes/purchase_log:recommend-related` | 1 件以上のシードアイテムに関連するアイテム(「これに似た商品」)。 |
| `POST /v1/recipes/purchase_log:batch-recommend` | 複数ユーザーへのレコメンドを 1 リクエストで。 |
| `POST /v1/recipes/purchase_log:batch-recommend-related` | 複数のシード集合への関連アイテムを 1 リクエストで。 |

このほかに、レシピ一覧やヘルスチェックのエンドポイント (`GET /v1/recipes`、
`GET /v1/health`) もあります。全フィールドとステータスコードは
[Serving API リファレンス](/ja/docs/serving-api) を参照してください。

## X-API-Key による認証

`GET /v1/health` を除く全エンドポイントは、プレーンテキストの API キーを持つ
`X-API-Key` ヘッダを必要とします。キーは次のコマンドで生成します。

```bash
recotem keygen --type api
```

これは 43 文字のプレーンテキストキー(クライアントに渡すもの)と、サーバーの
`RECOTEM_API_KEYS` に設定する `sha256:<hex64>` ダイジェストを出力します。

```bash
export RECOTEM_API_KEYS="client-a:sha256:<hex64>"
```

::: warning
`RECOTEM_API_KEYS` が空の場合、サーバーはバインド先を `127.0.0.1` に強制し、
すべてのリクエストを認証なしで受け付けます。ループバックの外に公開する前に、
必ず API キーを設定してください。ネットワーク公開の完全なチェックリストは
[セキュリティ](/ja/docs/security) を参照してください。
:::

## ユーザーへのレコメンドを取得する

`:recommend` は `user_id` と任意の `limit`(1〜1000、デフォルト 10)を受け取り、
`score` の降順に並んだアイテムを返します。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

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

各アイテムには常に `item_id` と `score` が含まれます。上の `title` や `category`
のような追加フィールドは、レシピの `item_metadata` ブロックから結合されたものです。
`user_id` が学習時に存在しなかった場合、エンドポイントは `404`(コード
`UNKNOWN_USER`)を返します。これは新規ユーザーでは想定通りの動作なので、
アプリケーション側で処理してください。例えば人気ベースのレコメンドに
フォールバックします。

## 関連アイテムを探す

`:recommend-related` は、1 件以上のシードアイテムから「これを見た人はこれも見ています」
を返します。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["item-42"], "limit": 5}' | jq .
```

レスポンスの形状は `:recommend` と同じです。シードアイテムがいずれもモデルに
知られていない場合は、`404`(`UNKNOWN_SEED_ITEMS`)が返ります。

## 複数ユーザーへ一括でレコメンドする

トップページの事前計算やメール配信のために、`:batch-recommend` は最大 256 件の
ユーザー単位リクエストを 1 回の呼び出しで受け取り、`index` フィールドで入力順を
保持した結果配列を返します。

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

ユーザー単位の失敗(未知のユーザーなど)があってもバッチ全体は失敗しません。
その要素は `status: "error"` を持ち、残りの要素はそのまま処理されます。
`include_metadata: true` を指定すると、単一ユーザーのエンドポイントと同じ
メタデータ結合済みのアイテム形状が得られます。`requests` 配列は 1〜256 件で、
全 `limit` の合計は 5000 を超えてはなりません。

## Python クライアント

以下は `:recommend` を呼び出し、想定される `UNKNOWN_USER` を処理する小さな
`requests` クライアントの例です。

```python
import requests

BASE = "http://localhost:8080"
API_KEY = "<plaintext>"  # `recotem keygen --type api` で生成

def recommend(user_id: str, limit: int = 10) -> list[dict]:
    resp = requests.post(
        f"{BASE}/v1/recipes/purchase_log:recommend",
        headers={"X-API-Key": API_KEY},
        json={"user_id": user_id, "limit": limit},
        timeout=5,
    )
    if resp.status_code == 404:
        # UNKNOWN_USER: 学習時に存在しなかった新規ユーザー。
        # 人気リストや編集部のおすすめなどにフォールバックする。
        return []
    resp.raise_for_status()
    return resp.json()["items"]

for item in recommend("u1"):
    print(item["item_id"], item["score"])
```

送信前にキーの前後の空白は取り除いてください。`X-API-Key` の先頭・末尾の
空白はキーの一部として扱われ、一致しません。

## デプロイする

サーバーは単一の Docker イメージとして提供されます。本番では通常、長時間稼働する
`serve` コンテナ 1 つと、アーティファクトボリュームを共有するスケジュール実行の
`train` ジョブを動かします。

```bash
docker run --rm \
  -p 8080:8080 \
  -v recotem_artifacts:/workspace/artifacts:ro \
  -v /opt/recotem/recipes:/recipes:ro \
  -e RECOTEM_SIGNING_KEYS="${RECOTEM_SIGNING_KEYS}" \
  -e RECOTEM_API_KEYS="${RECOTEM_API_KEYS}" \
  -e RECOTEM_HOST="0.0.0.0" \
  ghcr.io/codelibs/recotem:latest \
  serve --recipes /recipes/
```

Compose の詳しい手順、イメージタグの方針、ボリューム権限の注意点は
[Docker デプロイガイド](/ja/docs/deployment/docker) にあります。Recotem 自体は
TLS 終端やレート制限を行いません。[セキュリティ](/ja/docs/security) で説明している
とおり、TLS と IP 単位のクォータのためにリバースプロキシ(nginx、Caddy、または
クラウドのロードバランサ)を前段に置いてください。

## ホットスワップとモデルバージョン

サービングプロセスはアーティファクトディレクトリを監視し、`recotem train` が
新しいモデルを書き出すと**ホットスワップ**します。再起動もリクエストの取りこぼしも
ありません。ポーリング間隔は `RECOTEM_WATCH_INTERVAL`(デフォルト 5 秒)です。
レシピの `output.versioning: append_sha` モードと組み合わせると、各学習実行が
コンテンツアドレス方式で新しいアーティファクトを書き出し、ポインタファイルを
アトミックに切り替えるため、スワップは全か無かで行われます。

各レコメンドレスポンスは、どのモデルが応答したかを正確に示します。

- ボディの `model_version` フィールド(アーティファクトの `sha256:<64-hex>`
  ダイジェスト)。
- それを反映する `X-Recotem-Model-Version` レスポンスヘッダ。

この値を記録しておくと、配信したレコメンドを特定の学習実行と対応づけられます。
A/B 分析や、ホットスワップが実際に反映されたかの確認に役立ちます。

## 次のステップ

- [Serving API リファレンス](/ja/docs/serving-api) — 全エンドポイント、フィールド、エラーコード。
- [セキュリティ](/ja/docs/security) — 認証、ネットワーク公開、リバースプロキシのチェックリスト。
- [Docker デプロイ](/ja/docs/deployment/docker) — 本番の compose、イメージタグ、共有アーティファクトボリューム。
- [レシピリファレンス](/ja/docs/recipe-reference) — API レスポンスの形を決める `output` と `item_metadata` のフィールド。
- [GA4 × BigQuery で商品レコメンド](/ja/learn/use-cases/ga4-bigquery) — ここで配信するモデルを作るピラーのユースケース。
- [Recotem を学ぶ](/ja/learn/) に戻る。
