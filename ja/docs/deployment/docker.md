---
title: Docker デプロイメント
---

# Docker デプロイメント

Recotem は単一の Docker イメージとして提供されます。`recotem train` と `recotem serve` は同じイメージ内の別々のコマンドです。

## イメージタグ

`.github/workflows/docker.yml` によって `ghcr.io/codelibs/recotem` へプッシュされます。

| タグパターン | 可変性 | 用途 |
|---|---|---|
| `2.0.0`, `2.0.1`, ... (semver `{{version}}`) | 不変 | 本番環境 — ここにピン留めすること |
| `2.0`, `2.1`, ... (semver `{{major}}.{{minor}}`) | マイナーバージョン内で可変 | ローリングマイナーピン |
| `latest` | 可変、`main` をトラック | 簡易評価用。本番環境では使用しないこと |
| `main` (ブランチ参照) | 可変、`main` の最新 | スモークテストのみ |
| `sha-<short>` | 不変 | 特定コミットの再現 |

`:latest` は `main` へのプッシュごとに更新されます。チュートリアルの `compose.yaml` は `:latest` を参照していますが、本番環境では常に semver タグ (例: `2.0.0`) にピン留めしてください。Helm チャートと `examples/k8s/` はすでに `2.0.0a0` にピン留めされています。

イメージはマルチアーキテクチャ (`linux/amd64`, `linux/arm64`) です。SBOM と SLSA プロベナンス証明はプッシュ時に添付されます (`provenance: mode=max`, `sbom: true`)。サプライチェーンポリシーで必要な場合は `cosign verify-attestation` で検証してください。

## compose.yaml ウォークスルー

リポジトリには `compose.yaml` (Docker Compose v2 のデフォルトファイル名 — `docker compose` は `-f` なしで自動的に読み込みます) が含まれています。以下はアノテーション付きのバージョンです。

```yaml
services:

  # ------------------------------------------------------------------
  # train: コンテナ起動時に recotem train を一度だけ実行する。
  # 本番環境では、CronJob (K8s) またはホスト上の cron エントリに置き換えること。
  # ------------------------------------------------------------------
  train:
    image: ghcr.io/codelibs/recotem:latest    # 本番環境では semver タグにピン留めすること
    command: ["train", "/recipes/my_recipe.yaml"]
    working_dir: /workspace
    volumes:
      - ./examples/tutorial-purchase-log:/recipes:ro  # レシピディレクトリを読み取り専用でバインドマウント
      - artifacts:/workspace/artifacts                # 共有アーティファクトボリューム
    environment:
      RECOTEM_SIGNING_KEYS: "${RECOTEM_SIGNING_KEYS}"
    restart: "no"                      # 一度だけ実行; 繰り返すには cron ラッパーを使用

  # ------------------------------------------------------------------
  # serve: 長時間稼働する FastAPI サーバー。artifacts ボリュームの変更を
  # ウォッチし、train が新しいアーティファクトを書き込むとモデルをホットスワップする。
  # ------------------------------------------------------------------
  serve:
    image: ghcr.io/codelibs/recotem:latest    # 本番環境では semver タグにピン留めすること
    command: ["serve", "--recipes", "/recipes/"]
    working_dir: /workspace
    ports:
      - "8080:8080"
    volumes:
      - ./examples/tutorial-purchase-log:/recipes:ro
      - artifacts:/workspace/artifacts:ro  # serve は読み取りのみ; ro で安全
    environment:
      RECOTEM_SIGNING_KEYS:      "${RECOTEM_SIGNING_KEYS}"
      RECOTEM_API_KEYS:          "${RECOTEM_API_KEYS}"
      RECOTEM_HOST:              "0.0.0.0"
      RECOTEM_PORT:              "8080"
      RECOTEM_WATCH_INTERVAL:    "10"    # 10 秒ごとにポーリング
      RECOTEM_LOG_FORMAT:        "json"
      RECOTEM_ALLOWED_HOSTS:     "localhost,myapp.example.com"
      RECOTEM_ALLOWED_ORIGINS:   "https://myapp.example.com"
    healthcheck:
      test:
        - "CMD-SHELL"
        - "python -c \"import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=5).status == 200 else 1)\""
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    restart: unless-stopped

volumes:
  artifacts:
```

リポジトリ内の実際の `compose.yaml` にはチュートリアルワークフローを説明する追加コメントが含まれています。上記のアノテーション付きバージョンは、オペレーターに関連するフィールドを強調しています。

## 重要なポイント

### 共有アーティファクトボリューム

`train` と `serve` は同じ `artifacts` ボリュームをマウントします。サーバーは `RECOTEM_WATCH_INTERVAL` を通じて変更をポーリングし、新しいアーティファクトが現れるとホットスワップします。再起動は不要です。

### 環境変数によるシークレット管理

`RECOTEM_SIGNING_KEYS` や `RECOTEM_API_KEYS` を Compose ファイルにハードコードしないでください。`.env` ファイルまたはシークレットマネージャーから渡してください。

```bash
# .env (このファイルは絶対にコミットしないこと)
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
RECOTEM_API_KEYS=client-a:sha256:dd0eeff...,client-b:sha256:1122334...
```

```bash
docker compose --env-file .env up -d serve
```

### Docker 内の RECOTEM_HOST

デフォルトのバインドホストは `127.0.0.1` であり、ループバックのみにバインドされるためコンテナ外部からアクセスできません。Docker 内で実行する場合は `RECOTEM_HOST=0.0.0.0` を設定してください。

::: warning 注意
`RECOTEM_API_KEYS` が空の場合、サーバーは `RECOTEM_HOST` の設定に関わらず強制的に `127.0.0.1` にバインドします。開発環境でこれを上書きするには、`RECOTEM_ENV` を `development`、`dev`、または `test` に設定した上で `--insecure-no-auth` を渡してください。本番環境では絶対に使用しないでください。
:::

### ボリュームのパーミッション (UID 1000)

イメージは `appuser` (UID/GID 1000) として実行されます。コンテナが書き込むホストのバインドマウントディレクトリ (例: `./artifacts/`) は UID 1000 で書き込み可能でなければなりません。

```bash
mkdir -p ./artifacts && chown 1000:1000 ./artifacts
```

名前付き Docker ボリューム (`compose.yaml` のような) は適切なオーナーシップで事前作成されるため `chown` は不要です。コンテナは `readOnlyRootFilesystem` のセマンティクスも考慮しており、マウントされたボリューム以外で書き込み可能な場所は `/tmp` のみです。

### イメージレベルの HEALTHCHECK

Dockerfile は独自の `HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3` を宣言しており、`urllib.request.urlopen(f'http://127.0.0.1:{RECOTEM_PORT}/health', timeout=3)` でパブリックな `/health` エンドポイントをプローブします (これにより上書きされた `RECOTEM_PORT` も反映されます)。ワンショットの `train` コンテナでは、プロセスがすでに終了した後にこれが実行されますが、誤った失敗は発生しません。アノテーション付き例の Compose レベルのヘルスチェックも `/health` を対象とし、`serve` サービスのイメージデフォルトを上書きします — オーケストレーターは `/health` からの HTTP 200 レスポンスに依存してください。

### リバースプロキシバインディング

リバースプロキシを前段に置く場合、ホスト上でポートをローカルホストのみにバインドしてください。

```yaml
ports:
  - "127.0.0.1:8080:8080"   # ホストローカルのリバースプロキシからのみアクセス可能
```

## スケジュールによる train の実行

ワンショットの `train` サービスを cron ラッパーに置き換えるか、ホストの cron を使ってコンテナ内でコマンドを実行してください。

```bash
# ホスト cron — 既存の serve コンテナの共有ボリューム内で実行
0 3 * * * docker compose -f /opt/recotem/compose.yaml run --rm train
```

または、アーティファクトボリュームを共有する使い捨てコンテナとして `train` イメージを実行してください。

```bash
docker run --rm \
  -w /workspace \
  -v recotem_artifacts:/workspace/artifacts \
  -v /opt/recotem/recipes:/recipes:ro \
  -e RECOTEM_SIGNING_KEYS="${RECOTEM_SIGNING_KEYS}" \
  ghcr.io/codelibs/recotem:latest \
  train /recipes/my_recipe.yaml
```

ホストベースのスケジューリングパターンについては [cron / systemd デプロイメント](./cron-systemd) を参照してください。

## 環境変数リファレンス

| 変数 | 必須 | デフォルト | 備考 |
|----------|----------|---------|-------|
| `RECOTEM_SIGNING_KEYS` | はい (train+serve) | — | `<kid>:<hex>,...` |
| `RECOTEM_API_KEYS` | はい (serve) | — | `<kid>:sha256:<hex>,...` |
| `RECOTEM_HOST` | いいえ | `127.0.0.1` | Docker 内では `0.0.0.0` にすること |
| `RECOTEM_PORT` | いいえ | `8080` | |
| `RECOTEM_WATCH_INTERVAL` | いいえ | `5` | アーティファクトポーリング間隔 (秒、1〜30 にクランプ) |
| `RECOTEM_LOG_FORMAT` | いいえ | `auto`* | コンテナ内では `json` を推奨 |
| `RECOTEM_ALLOWED_HOSTS` | いいえ | `127.0.0.1,localhost` | カンマ区切り。空白のみまたは空の入力はデフォルトにフォールバック |
| `RECOTEM_ALLOWED_ORIGINS` | いいえ | `""` (拒否) | カンマ区切りの CORS オリジン |
| `RECOTEM_MAX_ARTIFACT_BYTES` | いいえ | `2147483648` (2 GiB) | アーティファクトごとのサイズ上限 (ヘッダー + ペイロードを含む) |
| `RECOTEM_MAX_PAYLOAD_BYTES` | いいえ | `536870912` (512 MiB) | serve 側のデシリアライズにおける HMAC 検証後のペイロード上限。1 MiB〜16 GiB にクランプ。`RECOTEM_MAX_ARTIFACT_BYTES` 以下でなければならず、そうでない場合は起動時に `ConfigError` (終了コード 8) が発生する。 |
| `RECOTEM_MAX_DOWNLOAD_BYTES` | いいえ | `268435456` (256 MiB) | HTTP/HTTPS、ローカル、オブジェクトストレージの読み取りにおけるソースパスボディの上限 (1 MiB〜16 GiB にクランプ) |
| `RECOTEM_HTTP_TIMEOUT_SECONDS` | いいえ | `30` | HTTP/HTTPS ソースフェッチの接続/読み取りタイムアウト (1〜600 にクランプ) |
| `RECOTEM_HTTP_ALLOW_PRIVATE` | いいえ | `""` (ブロック) | `1`/`true`/`yes`/`on` に設定すると RFC1918/ループバック/リンクローカル宛のフェッチを許可する。SSRF 攻撃を防ぐため本番環境では未設定のままにすること。 |
| `RECOTEM_DRAIN_SECONDS` | いいえ | `30` | SIGTERM グレースウィンドウ (秒、1〜300 にクランプ) |
| `RECOTEM_ENV` | いいえ | `""` | `development`、`dev`、または `test` に設定した場合のみ `--insecure-no-auth` が許可される。`--dev-allow-unsigned` は `development` に設定した場合のみ許可される。 |
| `RECOTEM_ARTIFACT_ROOT` | いいえ | `""` | 設定した場合、ローカルの `output.path` はこのディレクトリ配下に解決されなければならない (シンボリックリンク回避ガード) |
| `RECOTEM_LOCK_DIR` | いいえ | `""` | レシピごとの学習ロックファイルのディレクトリを上書き。`output.path` がリモート URI の場合に必要。未設定の場合はシステムの一時ディレクトリ配下にフォールバック。 |
| `RECOTEM_METADATA_FIELD_DENY` | いいえ | `""` | メタデータ結合後に `/predict` レスポンスから除外するカンマ区切りの列名 |
| `RECOTEM_METRICS_ENABLED` | いいえ | `""` | `1`/`true`/`yes`/`on` に設定すると Prometheus `/metrics` エンドポイントを有効化。`recotem[metrics]` エクストラが必要。 |
| `RECOTEM_STARTUP_PARALLELISM` | いいえ | `""` (自動) | 起動時にアーティファクトを並列ロードするスレッド数。デフォルトは `min(len(recipes), 8)`。1〜32 にクランプ。デバッグ時は `1` に設定して逐次ロードを強制。 |

*`auto` は TTY の場合は `console`、それ以外は `json` に切り替わります。

## ヘルスチェック

`/health` エンドポイントは認証不要でコンテナプローブに安全です。

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "total": 1,
  "loaded": 1
}
```

いずれかのレシピのロードに失敗した場合、`status` は `degraded` (HTTP 503) になります。このエンドポイントを対象に Kubernetes の readiness probe または Docker の HEALTHCHECK を設定してください。完全なレスポンス仕様については [Serving API](../serving-api) を参照してください。

`kid`、`trained_at`、`best_class` などレシピごとの詳細については、認証が必要な `/health/details` エンドポイントを使用してください。
