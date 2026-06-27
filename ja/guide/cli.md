---
title: CLI リファレンス
description: Recotem の全 6 コマンド、フラグ、および使用例。
---

# CLI リファレンス

Recotem は 6 つのコマンドを提供します。各コマンドは独立したプロセスとして動作し、スケジューラや CI システムが利用できる明確な終了コードを返します。オプションの全一覧は `recotem <command> --help` でいつでも確認できます。

---

## `recotem train`

データを取得し、ハイパーパラメータ探索を実行して最良のモデルを学習し、署名付きアーティファクトを書き出します。

```bash
recotem train <recipe.yaml> [flags]
```

**主なフラグ:**

| フラグ | デフォルト | 説明 |
|---|---|---|
| `--no-lock` | false | レシピごとのファイルロックをスキップします。別の手段で並行ライターが発生しないことを保証できる場合のみ安全です。 |
| `--fail-on-busy` | false | ロックが別プロセスに保持されている場合、デフォルト (スキップして終了コード 0) の代わりに終了コード 6 で即座に終了します。非ゼロの終了を「別の場所で再試行」と解釈するオーケストレータで有用です。 |
| `--lock-timeout <seconds>` | `0.0` | ロック取得を失敗とみなすまでの待機時間。`0.0` = ノンブロッキング、`-1` = 無期限に待機。 |
| `-q` / `--quiet` | false | Optuna のトライアルごとの出力を抑制します。大きな探索予算でのログ量を削減します。 |
| `-v` / `--verbose` | false | 各トライアルのハイパーパラメータ値を出力します。デバッグに有用ですが、本番環境では使用しないでください。 |
| `--run-id <id>` | ランダム | この学習実行の安定した識別子。同じ ID を再利用すると、永続的な Optuna スタディを再開できます (レシピに `training.storage_path` が必要)。 |
| `--env-var KEY=VALUE` | — | シェルにエクスポートせずにレシピ変数展開用の `RECOTEM_RECIPE_*` 値を注入します。繰り返し指定可能です。 |
| `--dev-allow-unsigned` | false | HMAC 署名をスキップします。`RECOTEM_ENV=development` と付属フラグ `--i-understand-this-loads-arbitrary-code` が必要です。ローカル開発以外では絶対に使用しないでください。 |

**例:**

```bash
recotem train recipes/news_articles.yaml --quiet --fail-on-busy
```

---

## `recotem serve`

ディレクトリ内のすべての `*.yaml` レシピを読み込み、新しいアーティファクトが現れるとモデルをホットスワップする FastAPI 予測サーバーを起動します。

```bash
recotem serve --recipes <directory> [flags]
```

**主なフラグ:**

| フラグ | デフォルト | 説明 |
|---|---|---|
| `--recipes <dir>` | (必須) | `*.yaml` レシピファイルが含まれるディレクトリ。 |
| `--port` / `-p <port>` | `8080` (または `RECOTEM_PORT`) | バインドするポート。 |
| `--host` / `-H <host>` | `127.0.0.1` (または `RECOTEM_HOST`) | バインドするホスト。Docker や Kubernetes 内では `0.0.0.0` に設定します。 |
| `--insecure-no-auth` | false | API キー認証を無効にします。`RECOTEM_ENV` が `development`、`dev`、または `test` に設定されている必要があります。 |
| `--dev-allow-unsigned` | false | アーティファクトの読み込み時に HMAC 検証をスキップします。`RECOTEM_ENV=development` と付属フラグ `--i-understand-this-loads-arbitrary-code` が必要です。制御されたローカルテスト以外では絶対に使用しないでください。 |

**例:**

```bash
recotem serve --recipes ./recipes/ --port 8080
```

サーバーは `RECOTEM_WATCH_INTERVAL` 秒ごと (デフォルト 5 秒) に新しいアーティファクトをポーリングします。`recotem train` が新しいアーティファクトを書き出すと、サーバーが読み込んで更新済みモデルの配信を開始します。再起動は不要です。

---

## `recotem inspect`

モデルのペイロードを読み込まずにアーティファクトのヘッダーを読み取り検証します。破損の可能性があるファイルに対して安全に実行できます。HMAC チェックとサイズチェックはデシリアライズより前に実行されます。

```bash
recotem inspect <artifact-path-or-uri>
```

ローカルパスと fsspec URI の両方に対応しています。

```bash
recotem inspect ./artifacts/my_model.recotem
recotem inspect s3://my-bucket/artifacts/my_model.recotem
recotem inspect gs://my-bucket/artifacts/my_model.recotem
recotem inspect az://my-container/artifacts/my_model.recotem
recotem inspect https://host/artifacts/my_model.recotem
```

成功すると `HMAC: OK  (kid=<kid>)` に続いてヘッダー JSON が出力されます。ヘッダーにはレシピ名、最良アルゴリズム、最良スコア、学習日時、データ統計が含まれます。

`RECOTEM_SIGNING_KEYS` の設定が必要です。鍵が設定されておらず `--dev-allow-unsigned` が渡されていない場合、コマンドは終了コード 8 (設定エラー) で終了します。

---

## `recotem validate`

レシピファイルをスキーマに対して検証し、データソースの基本的な接続確認を行います。高速な事前チェックで、データセット全体のダウンロードや学習の実行は行いません。

```bash
recotem validate <recipe.yaml>
```

実行内容:

1. YAML を解析してすべてのフィールドをレシピスキーマに対してチェックします。
2. データソースプラグインをインスタンス化します (`recotem[bigquery]` などのエクストラが欠落している場合に検出されます)。
3. ソースのオプションの `probe()` メソッドを実行します。
   - **ローカル / オブジェクトストレージパス** (`file`、`s3://`、`gs://`、`az://`) — ファイルの存在を確認します。
   - **HTTP / HTTPS パス** — SSRF ホスト公開チェックを実行します (バイト上限、リダイレクトスキームポリシー、`sha256` 検証はフェッチ時に発動します)。
   - **BigQuery** — ADC、プロジェクトアクセス、SQL/パラメータ構文を検証する無料のドライランクエリを実行します。
   - **SQL** — 接続を開いて軽微な疎通確認クエリを実行します。

**例:**

```bash
recotem validate recipes/news_articles.yaml
# Recipe 'news_articles': schema OK
# DataSource: probe OK (csv)
# Validation passed.
```

検証に失敗した場合、終了コードで何が問題かがわかります (レシピスキーマエラーは 2、データソースエラーは 3)。[終了コード](/docs/exit-codes)を参照してください。

---

## `recotem schema`

レシピモデルの JSON Schema を標準出力に出力します。JSON Schema に対応したエディタ (VS Code、JetBrains IDE など) での自動補完とインライン検証を有効にするために使用します。

```bash
recotem schema > recipe-schema.json
```

`*.yaml` ファイルを `recipe-schema.json` に対して検証するようにエディタを設定するか、YAML Language Server に向けてください。出力されるスキーマには、登録されているすべてのデータソース種別 (CSV、Parquet、BigQuery、およびインストール済みプラグイン) が含まれます。

---

## `recotem keygen`

署名鍵または API キーを生成し、キー ID、平文、すぐに使える環境変数エントリを出力します。

```bash
recotem keygen --type signing --kid <name>
recotem keygen --type api     --kid <name>
```

| フラグ | デフォルト | 説明 |
|---|---|---|
| `--type` | `signing` | HMAC アーティファクト鍵の場合は `signing`、クライアント認証鍵の場合は `api`。 |
| `--kid <name>` | 自動生成 (UUID プレフィックス) | 鍵の短い識別子。構造化ログ (サーバーアクセスログには認証済みリクエストごとに対応する `kid` が含まれます)、`/v1/health/details` のレシピごとの `kid` フィールド、および鍵ローテーション手順で使用されます。 |

平文は一度だけ表示されます。すぐにシークレットマネージャーに保存してください。後から復元する方法はありません。紛失した場合は新しい鍵を生成してください。

**例:**

```bash
recotem keygen --type signing --kid prod-2026-q2
# kid=prod-2026-q2
# plaintext=<64 文字の hex>
# fingerprint=<8 文字の hex>  # サーバーログと照合できます。設定には使いません
# env_entry=RECOTEM_SIGNING_KEYS=prod-2026-q2:<64 文字の hex>
```

---

## 終了コード

すべてのコマンドは一貫した終了コードを返します。ログ出力を解析する代わりに、CI パイプライン、cron スクリプト、Kubernetes の再起動ロジックでこれらを利用してください。

| コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 予期しないエラー (バグまたは環境の問題) |
| 2 | レシピエラー (不正な YAML、スキーマ違反、無効な環境変数) |
| 3 | データソースエラー (CSV フォーマットエラー、列の欠損、BigQuery アクセス拒否) |
| 4 | 学習エラー (全トライアルの失敗、データが最小閾値を下回る) |
| 5 | アーティファクトエラー (ファイル破損、HMAC 検証の失敗) |
| 6 | ロック競合 (`--fail-on-busy` が設定されておりロックが保持されている) |
| 7 | HTTP フェッチエラー (SSRF ガードによる拒否、タイムアウト、sha256 不一致、バイト上限超過) |
| 8 | 設定エラー (署名鍵の欠落、不正な環境変数) |

典型的な原因を含む完全な終了コードリファレンスについては [終了コード](/docs/exit-codes) を参照してください。
