---
title: チュートリアル
description: 実際の購買ログデータセットから推薦システムを学習・配信し、10 分以内に予測を取得します。
---

# チュートリアル

このチュートリアルでは、Recotem の一連の操作を体験します。データの取得、モデルの学習、配信、そして推薦エンドポイントの呼び出しです。使用するデータセットは小さな公開購買ログ CSV (Recotem の統合テストでも使用しているファイル) で、ラップトップで約 1 分で学習が完了します。

**前提条件:** Docker と Compose プラグイン、または Python 3.12 以上と Recotem がインストールされた環境が必要です。ディスクとネットワークアクセスは約 50 MB 程度 (`raw.githubusercontent.com` へのアクセスが必要です)。

実行方法を選んでください。

- [パス A — Docker Compose](#パス-a-docker-compose) (推奨。Python のインストール不要)
- [パス B — pip](#パス-b-pip)

---

## チュートリアルのレシピ

`examples/tutorial-purchase-log/recipe.yaml` のレシピがパイプライン全体を定義しています。

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

いくつか注目すべき点があります。

- **`source.sha256`** は HTTP/HTTPS 経由でデータファイルを取得する場合に必須です。Recotem はダウンロード後に期待するチェックサムと照合します。これにより、ファイルが密かに差し替えられたり破損したりした状態で学習が始まるのを防ぎます。
- **`training.algorithms`** には 2 つの候補を指定しています。IALS (暗黙的フィードバックの行列分解) と TopPop (人気ベースライン) です。Optuna が各アルゴリズムに対してトライアルを実行し、最も高いスコアの組み合わせを選択します。
- **`output.versioning: append_sha`** は各学習実行でユニークなサフィックスを付けた新しいアーティファクトを書き出し、ポインタファイルをアトミックに更新します。サーバーはポインタを通じて読み込むため、古いモデルから新しいモデルへの切り替えは常にアトミックです。

---

## パス A — Docker Compose

### ステップ 1 — 鍵の生成

```bash
docker run --rm ghcr.io/codelibs/recotem:latest keygen --type signing --kid dev
```

出力から `env_entry=` の行をコピーして設定します。

```bash
export RECOTEM_SIGNING_KEYS="dev:<出力の plaintext-hex>"
```

次に API キーを生成します。

```bash
docker run --rm ghcr.io/codelibs/recotem:latest keygen --type api --kid dev
```

`env_entry=` の行と `plaintext=` の行の両方をコピーします。

```bash
export RECOTEM_API_KEYS="dev:sha256:<出力の hash-hex>"
export RECOTEM_API_PLAINTEXT="<出力の plaintext>"   # ステップ 4 (curl) で使用
```

### ステップ 2 — 学習

リポジトリのルートから実行します。

```bash
docker compose run --rm train
```

これにより一回限りの学習コンテナが実行されます。GitHub から CSV を取得し、sha256 を検証して Optuna 探索を実行し、serve コンテナと共有する `artifacts` ボリュームに署名付きアーティファクトを書き出します。

最後のログ行は次のようになるはずです。

```json
{"event":"train_done","name":"purchase_log","exit_code":0,
 "artifact":"./artifacts/purchase_log....recotem","best_class":"IALSRecommender"}
```

### ステップ 3 — 配信

```bash
docker compose up -d serve
```

サーバーが起動してモデルを読み込んだか確認します。

```bash
curl http://localhost:8080/v1/health
```

期待されるレスポンス:

```json
{"status":"ok","total":1,"loaded":1}
```

### ステップ 4 — 予測

```bash
curl -sX POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | python3 -m json.tool
```

期待されるレスポンスの形式 (スコアの値とダイジェストは学習の実行ごとに異なります):

```json
{
  "request_id": "...",
  "recipe": "purchase_log",
  "model_version": "sha256:7f9c2ba4e88f827d616045507605853ed73b8093a07ef41c995c66e94c4eaa1d",
  "items": [
    {"item_id": "42", "score": 0.91},
    {"item_id": "17", "score": 0.87}
  ]
}
```

`model_version` は `sha256:` に続いて読み込まれたアーティファクトの 64 文字の hex SHA-256 ダイジェストが付きます。同じダイジェストは `X-Recotem-Model-Version` レスポンスヘッダーにも返されるため、クライアントはどのモデルバージョンが各予測を生成したかを記録できます。

### ステップ 5 — 後片付け

```bash
docker compose down -v
```

---

## パス B — pip

### ステップ 1 — インストールと確認

```bash
pip install recotem
recotem --help
```

### ステップ 2 — 鍵の生成

```bash
recotem keygen --type signing --kid dev
recotem keygen --type api     --kid dev
```

出力に表示された値をエクスポートします。

```bash
export RECOTEM_SIGNING_KEYS="dev:<署名の plaintext-hex>"
export RECOTEM_API_KEYS="dev:sha256:<API の hash-hex>"
export RECOTEM_API_PLAINTEXT="<API の plaintext>"
```

### ステップ 3 — レシピの検証 (任意だが推奨)

```bash
recotem validate examples/tutorial-purchase-log/recipe.yaml
```

これにより、レシピを解析してデータソースの `probe()` メソッドをファイル全体のダウンロードなしに実行します。HTTP/HTTPS ソースの場合、プローブは SSRF ホスト公開チェックを実行します。バイト上限、リダイレクトスキームポリシー、`sha256` 検証はフェッチ時に発動します。フル学習を始める前に設定上の問題を早期に発見するのに役立ちます。

### ステップ 4 — 学習

`output.path` の相対パス (`./artifacts/...`) が正しく解決されるよう、リポジトリのルートから実行してください。

```bash
mkdir -p artifacts
recotem train examples/tutorial-purchase-log/recipe.yaml
```

### ステップ 5 — 配信

```bash
recotem serve --recipes examples/tutorial-purchase-log/
```

### ステップ 6 — 予測

別のターミナルで実行します。

```bash
curl -sX POST http://127.0.0.1:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "1", "limit": 5}' | python3 -m json.tool
```

---

## 何が起きたのか

- `recotem train` はレシピを解析し、HTTPS 経由で CSV を取得して sha256 を検証し、IALS と TopPop に対して Optuna によるハイパーパラメータ探索を実行し、署名鍵で署名したバイナリアーティファクトを書き出しました。
- `recotem serve` はアーティファクトディレクトリを監視し、新しいファイルを検出して同じ署名鍵で HMAC 検証を行い、`/v1/recipes/purchase_log:recommend` (および関連 verb) エンドポイントとして登録しました。
- リクエストは API キーの許可リストで認証され、学習済みモデルでスコアリングされました。

---

## よくある問題

| 症状 | 考えられる原因 | 対処方法 |
|---|---|---|
| `RecipeError: 'source.path' uses a network scheme … requires a 'sha256' integrity pin` | レシピから `sha256` フィールドが削除された | `sha256:` の行を再度追加する |
| `DataSourceError: sha256 mismatch` | 上流のファイルが変更された | `curl -sL <url> \| shasum -a 256` で再計算してレシピを更新する |
| `DataSourceError: HTTP 404 fetching ...` | URL が変更された | ブラウザで URL を確認し、`v1.0.0` タグがまだ存在するか確認する |
| `ArtifactError: RECOTEM_SIGNING_KEYS not set` | ステップ 1 (鍵の生成) がエクスポートされていない | エクスポートを再実行して再試行する |
| `/v1/recipes/...` で `401 Unauthorized` | API キーの値が間違っている | `keygen --type api` の `hash` ではなく `plaintext` の値を使用する |
| 学習直後に `503 RECIPE_UNAVAILABLE` | ウォッチャーがまだポーリングしていない | `RECOTEM_WATCH_INTERVAL` 秒 (デフォルト 5 秒、チュートリアルの compose では 10 秒) 待つ。`/v1/health` を確認する |
| パス B: アーティファクトが予期しないディレクトリに書き出される | レシピの `output.path` が作業ディレクトリからの相対パス | リポジトリのルートから `recotem train` を実行するか、`output.path` を絶対パスに変更する |
| pip インストール後に `recotem: command not found` | 仮想環境がアクティベートされていない | 仮想環境をアクティベートするか、`python -m recotem ...` で実行する |

---

## 次のステップ

- [レシピの基本](/ja/guide/recipe-basics) — レシピの各セクションを詳しく理解する
- [CLI リファレンス](/ja/guide/cli) — `train`、`serve` などのコマンドの全フラグ
- [レシピリファレンス](/docs/recipe-reference) — すべてのレシピフィールドの詳細ドキュメント
- [バッチとスケジューリング](/ja/guide/batch) — cron スケジュールで学習を実行する
