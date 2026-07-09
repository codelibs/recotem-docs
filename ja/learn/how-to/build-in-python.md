---
title: Python でレコメンドシステムを作る方法
description: Python レコメンド 作り方の完全ガイド。インタラクションデータから配信用 API までのパイプラインを、自作の道筋と実際に動く Recotem レシピで解説します。
---

# Python でレコメンドシステムを作る方法

Python でレコメンドシステムを作りたい場合、うれしいことに難しい部分はすでに
よく理解されており、エコシステムも成熟しています。一方でやっかいなのは、本番の
レコメンダーは 1 つのモデルではなく **パイプライン** だという点です。インタ
ラクションデータを収集し、行列に変換し、アルゴリズムを選んでチューニングし、
正直に評価し、そして他のサービスから呼び出せる API の背後で予測を配信する —
という一連の流れが必要になります。

このガイドではパイプライン全体をたどります。まず、どのツールを選んでも共通する
一般的なステップを示し、次に自作の道筋（numpy、scipy、あるいはライブラリ）を
正直に見渡し、最後に [Recotem](/ja/learn/) を使った合理化された道筋を一気通貫で
紹介します。実際にそのままコピーして動かせるレシピを載せています。用語が初めての
場合は、[レコメンドシステムとは](/ja/learn/concepts/recommendation-system)
から読み始めてください。

## レコメンダーパイプラインの 5 ステップ

週末のプロトタイプからウェアハウス規模のサービスまで、あらゆるレコメンド
システムは同じ 5 つの段階を通ります。

1. **インタラクションを収集する。** ユーザーとアイテムを結ぶイベント — 購入、
   クリック、再生、評価 — を集めます。実際のシグナルの大半は *暗黙的* です
   （星 5 つのレビューではなくクリック）。こうした共起シグナルだけで十分な理由は
   [協調フィルタリング](/ja/learn/concepts/collaborative-filtering) を参照して
   ください。
2. **データを表現する。** これらのイベントを疎なユーザー×アイテム行列に整形
   します。各非ゼロセルは「このユーザーがこのアイテムに反応した」ことを表します。
3. **アルゴリズムを選ぶ。** モデルファミリー — 近傍法、行列分解、グラフ
   ウォーク — とそのハイパーパラメータを決めます。
4. **学習して評価する。** モデルを学習させ、nDCG@K や Recall@K といった
   ランキング指標を使って、ホールドアウトしたインタラクションでオフライン評価
   します。
5. **配信する。** 学習済みモデルを API として公開し、アプリがユーザーの上位 K
   件や、あるアイテムに関連するアイテムを問い合わせられるようにします。

ステップ 1〜4 はデータサイエンスの問題です。ステップ 5 — モデルを信頼性が高く、
認証付きで、無停止で差し替え可能なサービスにすること — こそが、多くの
プロジェクトが行き詰まる場所です。

## 自作の道筋

各ステップを Python ですべて自作することもできます。学習目的や研究であれば、
それはまさに正しい選択です。

- **numpy + scipy。** `scipy.sparse.csr_matrix` で疎行列を作り、それを分解
  します（`scipy.sparse.linalg.svds` による SVD、または独自の交互最小二乗
  ループ）。細部をすべて制御でき、重い依存関係も持ち込みません。
- **専用ライブラリ。** `implicit`、`LightFM`、`Surprise`、
  [`irspack`](https://github.com/tohtsky/irspack) といったパッケージは、
  十分にテストされたレコメンダーを実装しているため、iALS をゼロから導出し直す
  必要がありません。Recotem 自体も irspack の上に構築されています。

やっかいなのはモデルの *周辺* すべてです。未来のインタラクションをリークさせない
再現可能な学習/評価分割、正則化の強さを手探りしないためのハイパーパラメータ
探索、文字列のユーザー ID が往復しても保たれる ID マップ、そして配信レイヤー —
認証、入力バリデーション、アトミックなモデル再読み込み、ヘルスチェック。この
配管部分は、たいていモデル本体よりもはるかに大量のコードになります。

::: tip 自作が正解になるのはどんなときか
**カスタム損失、新しいアーキテクチャ、研究水準の制御** が必要な場合や、すでに
自前で持っている大きな学習パイプラインの一部としてレコメンダーを組み込む場合は、
numpy/scipy や生のライブラリに手を伸ばしてください。一方で「インタラクション
ログがあり、良い上位 K 件の API が欲しい」という一般的なケースでは、レシピ駆動の
ツールがモデリングの判断を奪うことなく定型作業を取り除いてくれます。
:::

## Recotem を使った合理化された道筋

Recotem はステップ 3〜5 を、1 つの YAML **レシピ** と 2 つのコマンドにまとめ
ます。[Optuna](https://optuna.org/) によるハイパーパラメータ探索を irspack の
アルゴリズム群に対して実行し、選んだランキング指標で各候補を評価し、勝者となった
モデルを可搬なアーティファクトに署名し、FastAPI エンドポイントで配信します。
インストールは `pip install recotem` です。

### ステップ 1 — インタラクションをテーブルとして収集する

Recotem は、CSV、Parquet ファイル、BigQuery クエリ、SQL データベースから
インタラクションを読み込みます。最小の形は、ユーザー列とアイテム列を持つ、
インタラクション 1 件につき 1 行です。

```csv
user_id,item_id
1,42
1,17
2,42
3,88
```

注文エクスポートから始める EC 向けのウォークスルーは、
[購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) を参照してください。

### ステップ 2 — レシピを書く（ここでアルゴリズムを選ぶ）

レシピは唯一の信頼できる情報源です。1 つの YAML ファイル = 1 つのモデル =
1 つの `/v1/recipes/{name}:recommend` エンドポイントです。次の例は、そのまま
実行できるように小さな公開購買ログ CSV で学習します。これは Recotem 自身の
テストが使うファイルと同じものです。`recipe.yaml` として保存してください。

```yaml
name: purchase_log

source:
  type: csv
  path: https://raw.githubusercontent.com/codelibs/recotem/refs/tags/v1.0.0/frontend/e2e/test_data/purchase_log.csv
  sha256: 945fc769205a5976d38c5783500ae473afbb04608043b703951a699993c8f8be
  dtype:
    user_id: str
    item_id: str

schema:
  user_column: user_id
  item_column: item_id

cleansing:
  drop_null_ids: true
  dedup: keep_last
  min_rows: 100
  min_users: 10
  min_items: 10

training:
  algorithms: [IALS, TopPop]
  metric: ndcg
  cutoff: 10
  n_trials: 10
  split:
    scheme: random
    heldout_ratio: 0.2
    seed: 42

output:
  path: ./artifacts/purchase_log.recotem
  versioning: append_sha
```

`training.algorithms` のリストが *アルゴリズムを選ぶ* 場所です。複数の候補を
挙げて、探索に最良のものを選ばせます。Recotem は `IALS`（暗黙的フィードバックの
行列分解）、`CosineKNN`、`TopPop`（人気度ベースライン）、`RP3beta`（グラフ
ウォーク）、`DenseSLIM`、`TruncatedSVD`、`BPRFM` をサポートします。上記の各
フィールドは [レシピリファレンス](/ja/docs/recipe-reference) に文書化されて
います。

::: warning HTTP/HTTPS ソースにはチェックサムが必要
このレシピは CSV を HTTPS 経由で取得するため、`sha256` ピンが必須です。Recotem
は学習前にダウンロードを検証するので、差し替えられたり破損したりしたファイルで
学習することは決してありません。ローカルの `path: ./data/interactions.csv` の
場合は省略します。
:::

### ステップ 3 — 1 コマンドで学習と評価を行う

署名鍵を生成してから学習します。

```bash
recotem keygen --type signing --kid dev
export RECOTEM_SIGNING_KEYS="dev:<出力の平文16進>"

mkdir -p artifacts
recotem train recipe.yaml
```

学習はステップ 3 と 4 をまとめて実行します。Recotem はインタラクションの 20% を
ホールドアウトし（`split.scheme: random`）、IALS と TopPop にわたって Optuna
探索を実行し、各試行を **nDCG@10**（`metric: ndcg`、`cutoff: 10`）でスコア
付けし、最良のものを残します。最後のログ行が勝者を報告します。

```json
{"event":"train_done","name":"purchase_log","exit_code":0,
 "artifact":"./artifacts/purchase_log....recotem","best_class":"IALSRecommender"}
```

`best_score` と、それが選ばれた際の指標はアーティファクト内部に記録されます。
`recotem inspect` でいつでも読み出せます。nDCG や Recall@K のようなランキング
指標になじみがない場合は、
[レコメンド評価指標](/ja/learn/concepts/evaluation-metrics) を参照してください。

### ステップ 4 — モデルを配信する

```bash
recotem keygen --type api --kid dev
export RECOTEM_API_KEYS="dev:sha256:<出力のハッシュ16進>"
export RECOTEM_API_PLAINTEXT="<出力の平文>"

recotem serve --recipes ./
```

サーバーは署名済みアーティファクトを読み込み、署名鍵に対して HMAC 検証を行い、
`/v1/recipes/purchase_log:recommend` エンドポイント（および関連動詞・バッチ
動詞）を登録します。準備完了を確認します。

```bash
curl -s http://localhost:8080/v1/health
```

```json
{"status": "ok", "total": 1, "loaded": 1}
```

### ステップ 5 — レコメンドを取得する

`:recommend` 動詞への POST で、あるユーザーの上位アイテムを問い合わせます。

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "42", "score": 0.91},
    {"item_id": "17", "score": 0.84}
  ]
}
```

アイテムは `score` の降順で返ります。Python からは、同じ呼び出しが短い
`requests` クライアントになります。学習時に見られなかったユーザーに対して API が
返す `404` を明示的に処理している点に注目してください。

```python
import requests

BASE = "http://localhost:8080"
API_KEY = "<平文>"  # `recotem keygen --type api` で取得


def recommend(user_id: str, limit: int = 10) -> list[dict]:
    resp = requests.post(
        f"{BASE}/v1/recipes/purchase_log:recommend",
        headers={"X-API-Key": API_KEY},
        json={"user_id": user_id, "limit": limit},
        timeout=5,
    )
    if resp.status_code == 404:
        # UNKNOWN_USER: アプリ層で人気アイテムにフォールバックする
        return []
    resp.raise_for_status()
    return resp.json()["items"]


for item in recommend("1", limit=5):
    print(item["item_id"], item["score"])
```

これで完全なレコメンドシステムです。ログから構築した行列、オフライン nDCG で
選ばれたチューニング済みモデル、そして認証付き API — 自前の配信コードは一切
ありません。アイテム間ウィジェット向けの `:recommend-related` やバッチ動詞を
含む完全なエンドポイントリファレンスは、[Serving API](/ja/docs/serving-api)
にあります。

## 次のステップ

- [レコメンドシステムとは](/ja/learn/concepts/recommendation-system) — 上記の
  各ステップの背後にある概念。
- [協調フィルタリングとは](/ja/learn/concepts/collaborative-filtering) —
  インタラクションデータだけからレコメンドが生まれる仕組み。
- [レコメンド評価指標](/ja/learn/concepts/evaluation-metrics) — nDCG、MAP、
  Recall@K を正しく読む。
- [購買ログからレコメンド](/ja/learn/use-cases/purchase-logs) — 同じパイプ
  ラインを実際の EC 注文データに適用する。
- [チュートリアル](/ja/guide/tutorial/) — このレシピを Docker または pip で
  一気通貫に実行する。
- [レシピリファレンス](/ja/docs/recipe-reference) — すべてのレシピフィールドの
  詳細。
- [Learn ハブ](/ja/learn/) に戻る。
