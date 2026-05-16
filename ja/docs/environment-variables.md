---
title: 環境変数
---

# 環境変数

このページはすべての `RECOTEM_*` 環境変数の公式リファレンスです。`train` スコープの変数は `recotem train` のみが読み取ります。`serve` スコープの変数は `recotem serve` のみが読み取ります。`both` スコープの変数は両方のコマンドが読み取ります。

## 認証と署名

これらの変数はアーティファクトの整合性 (署名鍵) と API 認証を制御します。シークレットとして扱う必要があります。保管の推奨事項については [セキュリティ — シークレットの取り扱い](./security#シークレットの取り扱い) を参照してください。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_SIGNING_KEYS` | (必須) | both | — | `kid:hex64,kid2:hex64` — HMAC-SHA256 署名/検証鍵 (64 hex 文字 = 32 生バイト)。複数エントリによりゼロダウンタイムのローテーションが可能。`recotem train` は常に**最初**のエントリで署名する。設定ミスまたは欠落した値はフェールクローズ — 未署名フォールバックなし。 |
| `RECOTEM_API_KEYS` | (空) | serve | — | `kid:sha256:hex64,...` — API キー許可リスト。各エントリは kid と scrypt ダイジェストのペア (`sha256:` はダイジェストファミリーラベルであり、アルゴリズムではない)。空の値はバインドアドレスを `RECOTEM_HOST` の設定に関わらず `127.0.0.1` に強制する。 |

::: tip ヒント — 鍵の生成
これらの変数の正しいフォーマットの値を生成するには `recotem keygen --type signing` および `recotem keygen --type api` を使用してください。正確な出力フォーマットについては [セキュリティ — `recotem keygen` 出力フォーマット](./security#recotem-keygen-出力フォーマット) を参照してください。
:::

## ネットワークバインディング

これらの変数は `recotem serve` が接続をリッスンする場所を制御します。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_HOST` | `127.0.0.1` | serve | — | uvicorn バインドホスト。`RECOTEM_API_KEYS` が設定されている場合、Docker または Kubernetes 内では `0.0.0.0` にする必要がある。API キーが設定されていない場合は強制的に `127.0.0.1` に戻される (`host_forced_to_loopback` 警告あり)。 |
| `RECOTEM_PORT` | `8080` | serve | — | uvicorn バインドポート。 |
| `RECOTEM_ALLOWED_HOSTS` | `127.0.0.1,localhost` | serve | — | `TrustedHostMiddleware` に渡すカンマ区切りのリスト。未認識の `Host` ヘッダーを持つリクエストは拒否される。空白のみのカンマ入力はデフォルトにフォールバック。本番環境ではクライアントが使用する正確なホスト名を明示的に設定すること。 |
| `RECOTEM_ALLOWED_ORIGINS` | (空) | serve | — | カンマ区切りの CORS 許可リスト。空はすべてのクロスオリジンリクエストを拒否することを意味する。ブラウザクライアントが CORS リクエストを送信する場合に設定する。 |

::: warning 注意 — recotem serve を外部に公開する
非ループバックインターフェースにバインドするには `RECOTEM_API_KEYS` を設定する必要があります。`RECOTEM_HOST=0.0.0.0` を設定し、`RECOTEM_ALLOWED_HOSTS` にクライアントの正確なホスト名を設定し、TLS を終端するリバースプロキシを前段に配置してください。`recotem serve` は TLS を終端しません。
:::

## 制限とキャップ

これらの変数はメモリとダウンロードサイズの制限を制御します。すべてデシリアライズ前に適用されます。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_MAX_ARTIFACT_BYTES` | 2 GiB | serve | [1 MiB, 16 GiB] | アーティファクトファイルごとのサイズ上限。デシリアライズが発生する前に適用される。小さなモデルが多い場合はメモリ上限を下げるために削減する。 |
| `RECOTEM_MAX_PAYLOAD_BYTES` | 512 MiB | serve | [1 MiB, 16 GiB] | HMAC 検証後のデシリアライズ中に適用されるペイロードごとの上限。`RECOTEM_MAX_ARTIFACT_BYTES` 以下でなければならない。そうでない場合は起動時に `ConfigError` (終了コード 8) で失敗する。デシリアライズによるメモリ展開を制限するため `RECOTEM_MAX_ARTIFACT_BYTES` より小さく設定されている。 |
| `RECOTEM_MAX_DOWNLOAD_BYTES` | 256 MiB | train | [1 MiB, 16 GiB] | HTTP/HTTPS、ローカルファイル、オブジェクトストアのソース読み取りにおける生 I/O バイト上限。上限はストリーム途中で適用される。超過すると `DataSourceError` (終了コード 3) が発生する。解凍後の DataFrame はキャップ**しない** — [セキュリティ — 解凍後サイズ上限の未適用](./security#解凍後サイズ上限の未適用medium-5) を参照。 |

## HTTP フェッチャー

これらの変数は `recotem train` が `http://` および `https://` ソースパスをフェッチする方法を制御します。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_HTTP_TIMEOUT_SECONDS` | `30` | train | [1, 600] | HTTP/HTTPS ソースフェッチの接続・読み取りタイムアウト (秒)。 |
| `RECOTEM_HTTP_ALLOW_PRIVATE` | (未設定) | train | — | 真値: `1`、`true`、`yes`、`on`。設定すると HTTP フェッチャーはプライベート (RFC1918)、ループバック、リンクローカル宛への接続を許可する。クラウドメタデータサービス (AWS IMDSv1 の `169.254.169.254`、GCP の `metadata.google.internal`) への SSRF 攻撃をブロックするため本番環境では未設定のままにすること。 |

::: warning 注意
`RECOTEM_HTTP_ALLOW_PRIVATE` は本番環境では絶対に設定しないでください。その唯一の目的はデータオリジンが信頼された内部ホストであるラボ環境のサポートです。[セキュリティ — ネットワークソースに対するオペレーターの責任](./security#ネットワークソースに対するオペレーターの責任) を参照してください。
:::

## ウォッチャーと起動

これらの変数は `recotem serve` がアーティファクトファイルを監視し、起動時にモデルをロードする方法を制御します。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_WATCH_INTERVAL` | `5` | serve | [1, 30] | アーティファクトウォッチャーのポーリングインターバル (秒)。ウォッチャーは新しいまたは変更されたアーティファクトファイルを検知し、プロセスを再起動せずにモデルをホットスワップする。 |
| `RECOTEM_STARTUP_PARALLELISM` | (自動) | serve | [1, 32] | 起動時にアーティファクトを並列ロードするスレッド数。デフォルトの自動サイジングは `min(len(recipes), 8)`。`0` の設定はセンチネルではなく — 1 にクランプして `env_var_clamped` 警告を出力する。デバッグには `1` に設定して逐次ロードを強制する。 |

## ライフサイクル

これらの変数はランタイム環境、グレースフルシャットダウン、ログ出力を制御します。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_ENV` | (空) | serve | — | デプロイメント環境タグ。`--insecure-no-auth` は `development`、`dev`、または `test` に設定した場合のみ許可される。`--dev-allow-unsigned` は `development` に設定した場合のみ許可される。`production`、`prod`、または `staging` に設定すると `/docs`、`/redoc`、`/openapi.json` エンドポイントが無効化される (リクエストは 404 を返す)。 |
| `RECOTEM_DRAIN_SECONDS` | `30` | serve | [1, 300] | SIGTERM グレースフルドレインウィンドウ (秒)。進行中のリクエストはこのウィンドウが完了するまで待機でき、その後 uvicorn は残りの接続を閉じる。Kubernetes では `terminationGracePeriodSeconds` を少なくとも `RECOTEM_DRAIN_SECONDS + 5` に設定すること。 |
| `RECOTEM_LOG_FORMAT` | `auto` | both | — | ログ出力フォーマット。`auto` は stdout が TTY でない場合は JSON、それ以外はコンソール形式を使用する。`json` は構造化 JSON を強制する。`console` は人間が読める出力を強制する。 |

## 運用

これらの変数はストレージパス、ロック、メタデータフィールドフィルタリング、メトリクスを設定します。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_ARTIFACT_ROOT` | (空) | train | — | 設定した場合、レシピのローカル `output.path` の値はこのディレクトリ配下に存在しなければならない。シンボリックリンクエスケープは拒否される。ホスト上で train プロセスがアーティファクトを書き込める場所を制限するために使用する。 |
| `RECOTEM_LOCK_DIR` | (空) | train | — | レシピごとの学習ロックファイルのディレクトリを上書きする。ローカルの `output.path` 値は常に `<output_path>.lock` でロックされる。リモートの `output.path` 値 (`s3://`、`gs://` など) はホストローカルのロックファイルを必要とする。`RECOTEM_LOCK_DIR` が未設定の場合は `<tempdir>/recotem-locks/` にフォールバックする。注意: `flock` はホストローカル — ホスト間のシングルライター保証にはスケジューラーレベルのミューテックスを使用すること (Kubernetes の `concurrencyPolicy: Forbid` など)。 |
| `RECOTEM_METADATA_FIELD_DENY` | (空) | serve | — | アイテムメタデータ結合後に `/predict` レスポンスから除外する列名のカンマ区切りリスト。マッチングは大文字小文字を区別しない — メタデータの `"Internal_ID"` は拒否リストに `"internal_id"` があればストリップされる。PII 列を API レスポンスから除外するために使用する。 |
| `RECOTEM_METRICS_ENABLED` | (未設定) | serve | — | 真値: `1`、`true`、`yes`、`on`。Prometheus `/metrics` エンドポイントを有効化する。`recotem[metrics]` エクストラが必要 (`pip install "recotem[metrics]"`)。エンドポイントはオプトインでデフォルトでは無効。 |

## データソース

これらの変数は特定のデータソースの動作を調整します。`recotem train` のみが、対応するソースが使用されたときのみ読み取ります。詳細は [データソース](./data-sources/) リファレンスを参照してください。

| 変数 | デフォルト | スコープ | クランプ | 説明 |
|---|---|---|---|---|
| `RECOTEM_BQ_REQUIRE_STORAGE_API` | (未設定) | train | — | 真値: `1`、`true`、`yes`、`on`。設定すると、BigQuery Storage Read API が失敗した場合 (例: `bigquery.readSessions.create` IAM 権限の欠落) に BigQuery ソースがより遅い REST API にサイレントフォールバックするのではなく、`DataSourceError` (終了コード 3) を発生させる。スループット低下を受け入れるのではなく IAM のギャップを表面化させるために使用する。 |
| `RECOTEM_MAX_SQL_ROWS` | `50_000_000` | train | [1_000, 500_000_000] | SQL データソースが返す行数のハードキャップ。上限を超えると `DataSourceError` (終了コード 3) を発生させる。**行数**をキャップするのであって、DataFrame の常駐メモリではない — [SQL ソース — メモリバウンドの注意点](./data-sources/sql#memory-bound-caveat) を参照。 |
| `RECOTEM_SQL_ALLOW_PRIVATE` | (未設定) | train | — | 真値: `1`、`true`、`yes`、`on`。SQL ソースがプライベート / ループバックの DSN ホストを受け入れるオプトイン (デフォルトは SSRF 対策のため拒否)。あらゆるドライバルーティング形式 (netloc、`?host=`、`?hostaddr=`、`?service=`、`?unix_socket=`、絶対パスホスト、ホスト情報のないネットワーク DSN) をカバー — このフラグなしでは全てデフォルトで拒否される。各プローブ / フェッチ前の DNS リバインディング再チェックも無効化される — オプトインはホストをエンドツーエンドで信頼することを意味する。 |
| `RECOTEM_GA4_MAX_PAGES` | `500` | train | [1, 10_000] | GA4 Data API ページネーションループのハード上限。デフォルト上限ではプロパティが大きすぎる場合に到達する。クォータを確認してから引き上げること。 |

## レシピ展開

`RECOTEM_RECIPE_` プレフィックスを持つ変数のみが、レシピ YAML ファイル内での `${...}` 展開の対象となります。

| 変数 | デフォルト | スコープ | 説明 |
|---|---|---|---|
| `RECOTEM_RECIPE_*` | — | train | 名前が `RECOTEM_RECIPE_` で始まる任意の変数は、レシピフィールドでの `${VAR_NAME}` 置換の候補となる。二次的なブラックリストがこのプレフィックス内でも機密名をブロックする。 |

::: warning 注意 — RECOTEM_RECIPE_* 展開のセキュリティ制約
二次的なブラックリストは、`RECOTEM_RECIPE_` プレフィックスを持つ場合でも、機密パターンに一致する変数名の展開を拒否します。ブラックリストは完全一致、プレフィックス一致、部分文字列一致のルールを使用します — 特に、部分文字列 `KEY` を含む名前は拒否されます。`RECOTEM_RECIPE_` プレフィックスはデータセット名、日付範囲、パーティション列、機能フラグなどの非機密設定値を対象としています。このプレフィックスの下にシークレットを格納しないでください。完全なルールと例については [セキュリティ — レシピの環境変数展開ブラックリスト](./security#レシピの環境変数展開ブラックリスト) を参照してください。
:::
