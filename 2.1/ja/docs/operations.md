---
title: オペレーションランブック
description: "Recotem 本番運用のランブック。署名鍵と API キーのローテーション、破損アーティファクトの復旧、メモリサイジング、監視、トラブルシューティングを解説します。"
---

# オペレーションランブック

このランブックは Recotem の本番デプロイメントにおける day-two オペレーションを扱います: 鍵ローテーション、アーティファクトリカバリ、CLI フラグリファレンス、学習パイプラインの可観測性、メモリサイジング、SIGTERM 処理、ウォッチャーのセマンティクス、バックアップ、モニタリング、アップグレード、トラブルシューティング。

完全な環境変数リファレンスについては [環境変数](./environment-variables) (またはすべての変数とデフォルト値・スコープを一覧する [Docker デプロイメント](./deployment/docker) ページのテーブル) を参照してください。

---

## 署名鍵のローテーション

署名鍵は `RECOTEM_SIGNING_KEYS` にカンマ区切りの `<kid>:<hex64>` エントリのリストとして設定します (64 hex 文字 = 32 生バイト)。サーバーはいずれかのエントリに対して検証します。`recotem train` は常に**最初**のエントリ (アクティブキー) で署名します。

このマルチ kid パターンにより、ゼロダウンタイムのローテーションが可能です。

### ステップバイステップのローテーション

**1. 新しい鍵を生成する。**

```bash
recotem keygen --type signing --kid prod-2026-q3
# kid=prod-2026-q3
# plaintext=<64 hex chars>       <-- 32 生バイト; これが署名鍵
# fingerprint=ddeeff00           <-- sha256(key_bytes)[:8]; /security.posture ログと一致
# env_entry=RECOTEM_SIGNING_KEYS=prod-2026-q3:<64 hex chars>
```

署名鍵の場合、`plaintext` 行が実際の鍵です — それ (または既成の `env_entry=` 行) を `RECOTEM_SIGNING_KEYS` にコピーしてください。`fingerprint=` 行は `sha256(key_bytes)[:8]` であり、起動時の `security.posture` ログの `fingerprint` フィールドと一致します。これは情報提供のみで、`RECOTEM_SIGNING_KEYS` で使用してはなりません。(`sha256:` ワイヤープレフィックスは `RECOTEM_API_KEYS` エントリ専用です。)

**2. 新しい kid を最初のエントリとして追加し、古いものを残す。**

```bash
# 変更前:
RECOTEM_SIGNING_KEYS="prod-2026-q2:aabbcc..."

# 変更後 (新しい鍵を最初に):
RECOTEM_SIGNING_KEYS="prod-2026-q3:ddeeff...,prod-2026-q2:aabbcc..."
```

更新した環境変数で `recotem serve` を再起動 (またはリロード) してください。サーバーはどちらの kid で署名されたアーティファクトも受け入れるようになります。

**3. すべてのモデルを再学習する。**

各レシピに対して `recotem train` を実行します。各新しいアーティファクトは `prod-2026-q3` (最初のエントリ) で署名されます。サーバーは新しいアーティファクトが現れるたびに各モデルをホットスワップします。`prod-2026-q2` で署名された古いアーティファクトは各レシピが再学習されるまで引き続きサービスされます。

**4. 古い kid を削除して検証する。**

すべてのレシピが再学習されてホットスワップされたら、古いエントリを削除してください。

```bash
RECOTEM_SIGNING_KEYS="prod-2026-q3:ddeeff..."
```

`recotem serve` を再起動します。古い kid で署名されたアーティファクトはロードに失敗し、`/v1/health/details` で `loaded: false` と表示されます。それらのレシピを再学習してください。

すべてのレシピが正常にロードされたことを確認してください。レシピごとの状態は認証が必要な `/v1/health/details` エンドポイントにあります — パブリックな `/v1/health` は `{status, total, loaded}` の集計値と、レシピファイルがまったくパースできなかった場合の `skipped` ([パースできないレシピファイル](#パースできないレシピファイル) を参照) のみを返します。

```bash
# -f / --fail は 4xx/5xx で終了コード 22 を返し、503 を隠す場合がある。
# 代わりに -w でステータスコードを取得する。
HTTP_STATUS=$(curl -s -o /tmp/health.json -w "%{http_code}" \
  -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  http://localhost:8080/v1/health/details)
echo "HTTP $HTTP_STATUS"
jq '.recipes | to_entries[] | select(.value.loaded == false)' /tmp/health.json
```

`jq` コマンドの出力が空であれば、すべてのレシピが新しい鍵で正常にロードされています。

### 鍵フィンガープリント

起動時に `recotem serve` は kid ごとに `sha256(key)[:8]` を含む `security.posture` イベントをログ出力します。鍵自体を公開することなく正しい鍵がアクティブであることを確認できます。

```json
{"event": "security.posture", "signing_keys": [{"kid": "prod-2026-q3", "fingerprint": "ddeeff00"}], ...}
```

---

## API キーのローテーション

API キーは `RECOTEM_API_KEYS` に `<kid>:sha256:<hex64>` エントリとして格納されます。ローテーションは追加式です: 新しいエントリを追加し、クライアントを更新し、古いエントリを削除します。

**1. 新しい鍵を生成する。**

```bash
recotem keygen --type api --kid client-a-v2
# kid=client-a-v2
# plaintext=<43-char base64url — クライアントに共有する>
# hash=sha256:<64-hex — RECOTEM_API_KEYS に入れる>
# env_entry=RECOTEM_API_KEYS=client-a-v2:sha256:<64-hex>
```

`--type api` が必要です — 指定しない場合 `recotem keygen` はデフォルトで `--type signing` となり、誤ったキーフォーマットを出力します。

**2. 古いエントリの隣に新しいエントリを追加する。**

```bash
# 変更前:
RECOTEM_API_KEYS="client-a:sha256:oldhhh..."

# 変更後:
RECOTEM_API_KEYS="client-a:sha256:oldhhh...,client-a-v2:sha256:newhhh..."
```

`recotem serve` を再起動します。両方の鍵が同時に有効になります。新しいプレーンテキストをクライアントに共有してください。

**3. クライアントが新しい鍵に切り替える。**

**4. 古いエントリを削除する。**

```bash
RECOTEM_API_KEYS="client-a-v2:sha256:newhhh..."
```

`recotem serve` を再起動します。

プレーンテキストは生成時に一度だけ表示されます。紛失した場合は新しい鍵を生成してください — リカバリの手段はありません。

---

## 破損したアーティファクトからのリカバリ

アーティファクトが破損している場合 (不完全な書き込み、ディスクエラー、ストレージ側の破損)、`recotem serve` はエラーをログ出力し、レシピを `loaded: false` としてマークします。起動時のイベント名は `initial_artifact_parse_failed` (または `initial_artifact_read_failed`) で、ウォッチャーのホットスワップ中は `artifact_load_failed` です。

```json
{"event": "artifact_load_failed", "name": "my_recipe", "error": "magic bytes mismatch", "kid": "<unknown>"}
```

`kid` フィールドが `"<unknown>"` になるのは、アーティファクトが完全な kid を保持するには短すぎる場合 (不完全な書き込み、ゼロバイトファイル) のみです。期待される長さの改ざんまたは誤ったマジックファイルの場合、解析された kid 文字列がそのまま表示されます。

サーバーは継続して動作し、そのレシピの推薦エンドポイントに対して 503 を返します。

**リカバリ手順:**

**1. アーティファクトを検査する** (破損したファイルでも安全 — HMAC とサイズチェックがデシリアライズ前に拒否します)。`recotem inspect` はローカルパスと fsspec URI の両方を受け付けます。

```bash
recotem inspect ./artifacts/my_recipe.recotem
# ローカルパス — 終了コード 5: ArtifactError: magic bytes mismatch

recotem inspect s3://my-bucket/artifacts/my_recipe.recotem
# オブジェクトストア URI — 同じ終了コードが適用される
```

**2. 再学習する。**

```bash
recotem train ./recipes/my_recipe.yaml
```

新鮮な署名済みアーティファクトが書き込まれます。サーバーは次のポーリングで新しいファイルを検知してホットスワップします。

**3. 確認する。**

```bash
curl -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  http://localhost:8080/v1/health/details | jq '.recipes.my_recipe'
# {"loaded": true, "best_class": "IALSRecommender", ...}
```

`versioning: append_sha` でアーティファクトが書き込まれた場合、古い破損ファイルは sha サフィックス付きの名前でまだ存在します。新しいアーティファクトのロードを確認してから削除できます。

```bash
ls ./artifacts/
# my_recipe.recotem           <- ポインターファイル (現在のものを指す)
# my_recipe.abc12345.recotem  <- 古い破損ファイル (削除可能)
# my_recipe.def67890.recotem  <- 新しい正常ファイル (現在)
rm ./artifacts/my_recipe.abc12345.recotem
```

---

## CLI フラグリファレンス

### recotem train フラグ

| フラグ | デフォルト | 説明 |
|------|---------|-------------|
| `--no-lock` | `false` | レシピごとの POSIX ファイルロック取得をスキップする。別のメカニズム (例: スケジューラーレベルのミューテックス) で同時書き込みがないことを保証できる場合のみ安全。 |
| `--fail-on-busy` | `false` | レシピのロックが保持されている場合、デフォルトの動作 (終了コード 0、`recipe_lock_contended_skipping` をログ) の代わりに即座に終了コード 6 (`LockContestedError`) で終了する。非ゼロを「他で再試行」と扱うオーケストレーターで使用する。 |
| `--lock-timeout <seconds>` | `0.0` | 失敗前にレシピのロックを待機する秒数。`0.0` = ノンブロッキング即時失敗 (デフォルト)。`-1` = 無期限待機。`--no-lock` が設定されている場合は無効。 |
| `-q` / `--quiet` | `false` | Optuna のトライアルごとの出力を抑制する。大きな探索予算でのログ量を削減する。 |
| `-v` / `--verbose` | `false` | トライアルごとのハイパーパラメータ値をログに出力する。探索動作のデバッグに有用。本番環境では使用しないこと (大量のログを生成する場合がある)。 |
| `--run-id <id>` | ランダム 12-hex | 安定した実行識別子。同じ値を繰り返し使用することで永続的な Optuna スタディを再開できる (レシピに `training.storage_path` が設定されている必要がある)。パターン: `[A-Za-z0-9_.-]{1,64}`。省略すると毎回新しいランダム ID が生成される。 |
| `--env-var KEY=VALUE` | — | シェル環境にエクスポートせずにレシピの環境変数展開用の追加 `RECOTEM_RECIPE_*` 値を注入する。`KEY` は `RECOTEM_RECIPE_` で始まる必要がある。繰り返し可能: `--env-var A=x --env-var B=y`。 |
| `--dev-allow-unsigned` | `false` | HMAC 署名をスキップし、決定論的なインメモリ開発鍵を使用する。`RECOTEM_ENV=development` と `--i-understand-this-loads-arbitrary-code` の両方が必要。管理されたローカルテスト環境以外では絶対に使用しないこと。 |

### recotem inspect フラグ

`recotem inspect` はアーティファクト引数としてローカルパスと fsspec URI の両方を受け付けます。

```bash
recotem inspect ./artifacts/my_recipe.recotem           # ローカルパス
recotem inspect s3://my-bucket/artifacts/my.recotem     # S3 URI
recotem inspect gs://my-bucket/artifacts/my.recotem     # GCS URI
recotem inspect az://my-container/artifacts/my.recotem  # Azure Blob URI
recotem inspect https://host/artifacts/my.recotem        # HTTPS URI
```

`RECOTEM_SIGNING_KEYS` が設定されている必要があります (または `RECOTEM_ENV=development` で `--dev-allow-unsigned`)。署名鍵が存在せず `--dev-allow-unsigned` が渡されない場合、`inspect` は終了コード 8 (`_EXIT_CONFIG`) で終了します — 5 ではありません。

| フラグ | デフォルト | 説明 |
|------|---------|-------------|
| `--dev-allow-unsigned` | `false` | `RECOTEM_SIGNING_KEYS` が未設定の場合、決定論的なインメモリ開発鍵 (`dev:0000…`) に対して検証する。`recotem train --dev-allow-unsigned` で生成されたアーティファクトの検査に有用。 |

完全な終了コード表については [終了コードとエラー](./exit-codes) を参照してください。

---

## 学習パイプラインイベント

成功した学習実行はこれらの構造化イベントを順番に出力します。SLO とアラートルールの基礎として使用してください。

| イベント | フェーズ | 主要フィールド |
|-------|-------|--------------------|
| `training_started` | 開始 | `recipe`, `run_id` |
| `fetching_data` | データソース | — |
| `data_fetched` | データソース | `n_rows` |
| `data_cleansed` | クレンジング | `n_rows`, `drop_count` |
| `splitting_data` / `split_done` | 分割 | `val_offset` |
| `search_started` | チューニング | `algorithms`, `n_trials` |
| `search_done` | チューニング | `best_class`, `best_score`, `n_completed` |
| `training_final_model` / `final_model_trained` | 再フィット | `recommender` |
| `artifact_written` | 永続化 | `versioning`, `artifact`, `pointer` (append_sha), `kid` |
| `train_done` | 終了 | `name`, `run_id`, `exit_code`, `artifact`, `best_class`, `best_score`, `trials`, `n_orphaned`, `trained_at`, `kid`, `recipe_hash`, `n_rows`, `n_users`, `n_items` |
| `train_error` | 失敗 | `error`, `code` (非ドメイン例外は `internal_error`)、`recipe`, `run_id`, `exit_code`, `trained_at`; `code=min_data_violation` の場合はさらに `n_rows`, `n_users`, `n_items`, `min_rows`, `min_users`, `min_items` |
| `recipe_lock_contended_skipping` | 開始 | `recipe`, `run_id` (デフォルト `--fail-on-busy=False` は終了コード 0) |
| `csv_source_redirect` | データソース | `from_`, `to`, `status` |
| `csv_source_size_exceeded` | データソース | `path`, `bytes_read`, `cap` |
| `metadata_source_redirect` | データソース | `from_`, `to`, `status` |
| `metadata_source_size_exceeded` | データソース | `path`, `bytes_read`, `cap` |

`csv_source_redirect` / `csv_source_size_exceeded` にアラートを設定するオペレーターは、`metadata_source_redirect` / `metadata_source_size_exceeded` にも同等のアラートを追加してください。どちらのイベントファミリーも、HTTP/HTTPS フェッチがリダイレクト上限またはバイト上限に達したときに発生します。

`train_error` イベントはレシピ名フィールドに (`recipe=` ではなく) `name=` を使用し、署名 kid が判明している場合は `kid=` を含みます。これは `train_done` イベントのフィールド名と一致します。

### ウォッチャーとローダーの構造化ログイベント

アラートに有用な、ウォッチャー、レシピローダー、サイズ上限ヘルパーが出力する追加イベント:

| イベント | レベル | 出力元 | 重要性 |
|-------|-------|-----------|--------------|
| `recipe_security_violation_skipped` | ERROR | `recipe/loader.py` 寛容なローダー | レシピファイルにセキュリティカテゴリのエラー (パストラバーサル、許可されていないスキーム、埋め込まれた認証情報) が含まれる。レシピはスキップされるがサーバーは継続して動作する。**アラート対象** — 設定ミスまたは潜在的に悪意のあるレシピファイルを示す。 |
| `recipe_load_error_skipped` | WARN | `recipe/loader.py` 寛容なローダー | 非セキュリティ上の理由 (スキーマエラー、YAML パースエラー) でレシピのロードに失敗した。レシピはスキップされる。 |
| `size_cap_probe_failed` | WARN | `_size_cap.py` | オブジェクトストアパスへの fsspec `info()` 呼び出しが予期せず失敗した。サイズ上限チェックがスキップされた。後続の読み取りは続行されるが、事前読み取り上限の制限を受けない。 |
| `auth_anonymous_bypass` | DEBUG | `serving/auth.py` | API キーなしで通過したすべてのリクエスト (`RECOTEM_API_KEYS` が空の場合)。アクセスログ相関のためすべてのリクエストで出力される。 |
| `auth_anonymous_bypass_first_seen` | INFO | `serving/auth.py` | 特定の `client_host` からの最初の匿名リクエスト (プロセスごと)。最初に見た IP を追跡する LRU キャッシュは 1024 エントリに制限される。 |
| `kid_extraction_failed` | WARN | `serving/watcher.py` | アーティファクトの kid バイトを生バイトから解析できなかった。 |
| `artifact_stat_timeout` | WARN | `serving/watcher.py` | stat() フューチャーがフューチャーごとのタイムアウト内に完了しなかった。ハングしたオブジェクトストアの stat はティックの進行や SIGTERM 処理をブロックしなくなった。 |

---

## 同時学習と永続的な探索ストレージ

`recotem train` は作業の開始前に `<recipe.output.path>.lock` でレシピごとの POSIX `flock` を取得します。ロックは**ホストローカル**です: `flock` は同一ホスト上のプロセスのみを調整します。`output.path` がリモート URI (`s3://`, `gs://`, `http(s)://`, ...) の場合、ロックファイルは URI から派生したホストローカルパスに作成され、別の Pod やノードによる同じアーティファクトへの同時書き込みを防ぎません。ホスト間のシングルライター保証にはスケジューラーを使用してください (Kubernetes の `concurrencyPolicy: Forbid`、Argo の `synchronization.mutex`、Airflow の `max_active_runs=1` など)。Recotem はリモートスキームの実行ごとに `recipe_lock_local_only` をログ出力します。

ロックのデフォルト動作:

- **ノンブロッキング**: ロック競合が発生した場合は即座に終了コード 0 と `recipe_lock_contended_skipping` で終了します (cron フレンドリー: 遅い実行によって重複したジョブが積み重なりません)。
- **`--fail-on-busy`**: これを終了コード 6 (`LockContestedError`) に変更し、オーケストレーターが作業を他の場所に委任できるようにします。`LockContestedError` は意図的に `TrainingError` 階層の外にあります — これはオーケストレーションの状態であり、学習の失敗ではありません。
- **`--no-lock`**: ロック取得を完全にスキップします。他のメカニズムで同時書き込みがないことを保証できる場合のみ安全です。

単一ホストまたは分散クラスター上での複数プロセスの Optuna 探索 (並列化) には、レシピに `training.storage_path` を設定してください。受け入れられる形式: 裸のパス (SQLite)、または `sqlite://`、`postgresql+psycopg://`、`mysql+pymysql://` で始まる URL。`+driver` サフィックスは必須です: この URL は Optuna の `RDBStorage` にそのまま渡され、`RDBStorage` はドライバの事前チェックを行いません。そのため裸の `postgresql://` (インストールされていない `psycopg2` にルーティングされます) は Optuna 内部で `ImportError: Failed to import DB access module for the specified storage URL` として失敗し、`postgres://` (SQLAlchemy 2.x で削除されたダイアレクト) は `NoSuchModuleError` として失敗します。どちらのメッセージも対処方法を示さず、`recotem validate` でも検出されません。

**サーバーバックエンドの形式には、加えてドライバのエクストラのインストールが必要です。素の `pip install recotem` にはどちらも含まれていません:**

```bash
pip install "recotem[postgres]"   # postgresql+psycopg:// 用
pip install "recotem[mysql]"      # mysql+pymysql:// 用
```

これは見落としやすい問題です。URL 自体はパースが**通ってしまう**ためです: `sqlalchemy` は推移的にすべてのインストールへ入ります (Optuna が依存しており、Optuna はコア依存です) が、`psycopg` と `pymysql` は上記のエクストラにしか含まれません。そのため素のインストールでは、推奨形式である `postgresql+psycopg://` であっても、**綴りを間違えた場合とまったく同じ** `ImportError: Failed to import DB access module for the specified storage URL` で失敗し、メッセージからは両者を区別できません。`+driver` サフィックスを既に書いているのにこのエラーが出る場合は、エクストラをインストールしてください。

同じレシピに対する複数の `recotem train` 呼び出しは、作業を重複させるのではなく共有トライアルプールに収束します。スタディ名は `recotem_<recipe.name>_<run_id>` です。

---

## アトミック書き込みの保証

`recotem train` は同じディレクトリの一時ファイルにアーティファクトを書き込み、`fsync()` でデータをフラッシュし、その後 `os.replace()` します — ローカル FS 上では POSIX アトミックなため、リーダーは不完全なファイルを見ることはありません。オブジェクトストア (S3 / GCS / Azure) では `put_object` セマンティクス (最後の書き込みが勝つ) でアーティファクトが書き込まれます。`versioning: append_sha` モードでは、不変の sha サフィックス付きオブジェクトが最初に書き込まれ、次に小さなポインターオブジェクトが上書きされます。ローテーション中にポインターを開いたリーダーは、古いまたは新しいターゲット名のどちらかを見ます — 不完全なポインターは見ません。

---

## SIGTERM / ドレインシーケンス

uvicorn が `SIGTERM` (または `SIGINT`) を受け取ったとき:

1. uvicorn は新しい接続の受け入れを停止する。
2. FastAPI のライフスパンが終了する: `ArtifactWatcher.stop()` が呼び出され、ポーリングスレッドは次のティック (≤ `RECOTEM_WATCH_INTERVAL` 秒) で終了する。繰り返しの警告タスクはキャンセルされる。
3. 進行中のリクエストには `RECOTEM_DRAIN_SECONDS` (デフォルト 30) まで完了する時間が与えられ、uvicorn はその後残りの接続を閉じる。
4. `drain_seconds` とともに最終的な `serve_shutdown` イベントがログに記録される。

Kubernetes では、SIGKILL の前にウォッチャーのティックとドレインウィンドウを確保するため、`terminationGracePeriodSeconds` を `RECOTEM_DRAIN_SECONDS + 5` 以上に設定してください。

---

## recotem serve のメモリサイジング

各モデルレプリカはロードされたすべてのモデルを RAM に保持します。適切に計画してください。

| 要因 | 影響 |
|--------|--------|
| `RECOTEM_MAX_ARTIFACT_BYTES` | アーティファクトファイルごとのハード上限 (デフォルト 2 GiB、[1 MiB, 16 GiB] にクランプ)。小さなモデルが多い場合は削減する。 |
| `RECOTEM_MAX_PAYLOAD_BYTES` | アーティファクトごとのデシリアライズ済みペイロードの上限 (デフォルト 512 MiB、HMAC 検証後)。`RECOTEM_MAX_ARTIFACT_BYTES` 以下でなければならない。そうでない場合、`recotem serve` は起動時に `ConfigError` (終了コード 8) で失敗する。 |
| レシピ数 | 各レシピは 1 つのモデルをロードする。10 レシピ × 500 MiB = 5 GiB ベースライン。 |
| レプリカ数 | 各レプリカは独立している。2 レプリカ = 2 倍のメモリ。 |
| アイテムメタデータ | レシピごとのインメモリ DataFrame。サイズ ≈ 行数 × 列数 × 8 バイト。 |

おおよその計算式:

```
Pod あたりの RAM ≈ (avg_artifact_size_GiB × n_recipes) + (avg_metadata_size_GiB × n_recipes) + 1 GiB OS オーバーヘッド
```

大きなモデル (多くのコンポーネントを持つ IALS、大規模なアイテムセット) の場合、ホストサイズを決定する前に `recotem inspect` を使って `data_stats` と `best_params` をヘッダーから読み取ってください。

`recotem serve` はプロセスあたり最大 100 レシピ向けに設計されています。それを超える場合は複数の `serve` プロセスにレシピをシャーディングしてください (別々の `--recipes` ディレクトリ、別々のポート、プロキシレイヤーでロードバランシング)。

---

## フィーチャーアウェア iALS のサイジング

レシピの [`features:`](./recipe-reference#features) ブロックは、Recotem のレシピの他の部分とは異なるスケールのコストを追加します。以下はすべて `features:` が存在する場合にのみ当てはまります。

### ボキャブラリはインタラクション件数ではなくカタログサイズに比例する

この機能の運用上もっとも意外な性質です。エンコード後の次元は**取得したフィーチャーテーブル全体**から構築され、インタラクションデータに実際に現れるアイテム/ユーザーの部分集合からは構築されません。これこそが、学習に一度も現れないコールドスタートのアイテムやユーザーをサービング時にスコアリングできる理由です。その帰結として、インタラクションがそのうち 1,000 アイテムしかカバーしていない 100 万アイテムのカタログでも、残り 999,000 アイテム分のエンコード次元 — および後述するトライアルあたりの学習コスト — をそのまま支払います。それらのカラムが役に立つのは、来ないかもしれないコールドスタートリクエストに対してだけであってもです。

`RECOTEM_MAX_FEATURE_DIM` (デフォルト 5000、`[16, 100000]` にクランプ) はサイドごとのエンコード次元に上限を設けます (アイテムとユーザーは独立して検査されます)。超過するとエンコーダ状態が構築される時点で `TrainingError` (終了コード 4) が発生します。オペレーターがこの上限に対して使える**唯一の**レバーが `min_frequency` (レシピレベル、カラムごと) です。高カーディナリティの `categorical` / `multi_label` カラムでこれを上げてボキャブラリを縮小してください。レシピからボキャブラリをインタラクションでカバーされた行に限定する方法はありません。

::: warning 注意 — `min_frequency` が制限するのは次元であって、それを発見するために使うメモリではありません
ボキャブラリ構築は取得したカラムのすべてのトークンを辞書に数え上げ、その後で初めて刈り込みます。`multi_label` の分岐は、まず全行のトークンを 1 つのリストに平坦化します。したがって高カーディナリティのカラムは、`min_frequency` をどれだけ積極的に設定しても一時的なカウントコストを丸ごと支払います — 数十万の異なる値を持つカラムは、刈り込み後のボキャブラリが空になる場合でもカウントに数十 MB を要します。`RECOTEM_MAX_FEATURE_DIM` のチェックはすべてのカラムのボキャブラリが構築された**後**に実行されるため、上限が拒否する実行でもこの一時的なコストは全額支払われます。`min_frequency` はトライアルを保護しますが、エンコーダ状態の構築は保護しません。
:::

### トライアルあたりの時間は次元より速く、メモリは 2 乗で増加し、どちらも `training.parallelism` と乗算される

irspack はサイドごとに密な `Fᵀ F` グラム行列を構成し、Cholesky 分解で解きます。2 つのコストは異なるスケールをするため、ホストをサイジングする際は分けて考える価値があります。**時間**はエンコード後の次元に対して**超線形**に増加します。そしてサイジングを誤らせるのはここです — **指数そのものが次元とともに上昇する**ため、範囲全体に当てはまる単一のべき乗は存在しません。既定の 5,000 を下回る範囲ではフィーチャー処理はまだトライアル時間の主要因ではなく、次元を倍にしてもコストは 2 倍未満です。5,000 以上ではグラム行列とその Cholesky が支配的になり、倍化のコストは純粋な 3 乗が示す 8 倍に近づきます。1 つのフィクスチャ、`parallelism: 1`、3 回の交互実行の中央値で、倍化ごとに実測:

| 倍化 | コスト | 含意される指数 |
|---|---|---|
| 1,251 → 2,501 | 1.74 倍 | 0.80 |
| 2,501 → 5,001 | 1.85 倍 | 0.89 |
| 5,001 → 10,001 | 5.07 倍 | 2.34 |
| 10,001 → 20,001 | **7.46 倍** | **2.90** |

このページの以前の版は、範囲全体を平坦な `dim^2.4` と要約し、倍化のコストを 5.1〜5.8 倍として 3 乗の場合を明示的に否定していました。これは 5,000 → 10,000 の段については正しく、両端では誤りです。小さい上限を引き上げるコストを過大に、既定の上限を引き上げるコストを過小に見せます — そして 10,000 → 20,000 の段こそ、既定の上限がカタログを拒否したときにオペレーターが取る段です。5,000 から 20,000 への**2 回**の倍化は約 30 倍ではなく約 38 倍で見積もってください。

**メモリ**にこの複雑さはなく、**2 乗**で増加し、グラム行列は float64 で `dim² × 8` バイトです。ただしこれは**見積もりではなく下限**として扱ってください。式は 200 MB / 800 MB / 3.2 GB を与えますが、特徴量なしの同一実行に対するピーク RSS の増分の実測は **287 MB / 960 MB / 3.5 GB** で、式は 10〜43% 過小評価となり、既定の上限である 5,000 で最もずれます。グラム行列が支配的ですが、エンコーダ状態・特徴量行列そのもの・ソルバの作業領域も同時に生存しています。irspack はどちらでもエラーを出さず、劣化するだけです。トライアルあたりの実測値:

| エンコード次元 | 時間 | メモリ |
|---|---|---|
| 5,000 | 0.6〜2.4 秒 | 約 200 MB |
| 10,000 | 4.2〜12 秒 | 約 800 MB |
| 20,000 | 43〜70 秒 | 約 3.2 GB |

時間の列が範囲なのは、トライアルが同時に適合させるインタラクションデータにも依存し、次元だけで決まらないためです。低い方の値は小さいフィクスチャ、高い方の値は 10 万行のフィクスチャによるものです。メモリはグラムの式が予測するとおり、どちらでも安定しています。**サイジングは高い方の値で行ってください。** 上昇する指数はこの表からも見えます — 小さいフィクスチャでは 4.2/0.6 と 43/4.2 が倍化あたり 7.0 倍と 10.2 倍です。単一の平坦なべき乗が誤った要約だった理由がこれです。

`training.parallelism` は Optuna の `n_jobs` であり、プロセスではなく**プロセス内スレッド**です。したがって同時実行される各トライアルが独自の密なグラム行列を構築して解きます。`parallelism=4, dim=10k` ではグラム行列だけでおよそ 4 × 771 MB ≈ 3 GB になり、探索がメモリに保持する他のすべてがこれに加わります。学習ホストのサイジング (あるいは `parallelism` と `RECOTEM_MAX_FEATURE_DIM` の設定) はこの乗算を念頭に行ってください。

### ペイロードとサービング側の RSS は次元だけでなくカタログサイズにも比例する

irspack は学習済みレコメンダー上に `self.item_features` (および `self.user_features`) を保持し、`__getstate__` を定義していないため、エンコード済みのフィーチャー行列はそのままアーティファクトのペイロードにシリアライズされます。サイズはエンコード次元だけでなく `n_items × nnz_per_row` に比例します。試算では、100 万アイテム × エンコード 500 次元 × 1 行あたり非ゼロ 5 件 ≈ 42 MiB、100 万アイテム × 5,000 次元 × 1 行あたり非ゼロ 10 件 ≈ 80 MiB です。512 MiB という `RECOTEM_MAX_PAYLOAD_BYTES` のデフォルトに対して無視できませんが、それ自体が致命的というほどではありません。

`RECOTEM_MAX_FEATURE_DIM` が制限するのは**カラム**です。`n_items × nnz_per_row` を制限するものは何もないため、1 行あたりのエンコードが密な (多数の `multi_label` タグ、低い `min_frequency`) 非常に大きなカタログは、エンコード次元が控えめでも大きなペイロードを生成しえます。アーティファクトがロードされると、同じバイト数がサービング側の常駐メモリにも計上されます (上記の [recotem serve のメモリサイジング](#recotem-serve-のメモリサイジング) を参照)。

### コールドスタートのレイテンシと `n_threads`

コールドスタートのスコアリングは行列の参照ではなく反復的な共役勾配法のソルブです。実測レイテンシ (1,000 アイテム、64 コンポーネント): 単一のコールドスタートリクエストは中央値 300〜500 µs、バッチ処理はこれを**ユーザーあたり 8〜12 µs** まで償却します — ユーザーあたり 30〜40 倍の改善であり、バルクなコールドスタートのワークロードでバッチ動詞 (`:batch-recommend` / `:batch-recommend-related`) が推奨経路である理由です。

::: warning 注意 — `n_threads` が大きいと単一リクエストのレイテンシが悪化します
`n_threads=16` では中央値 734〜857 µs、p95 は 2.0〜2.2 ms であり、`n_threads` が 1〜4 のほうが高速です。irspack にはここに固定のデフォルトがありません — `IALSRecommender(n_threads=None)` は irspack のスレッディングヘルパーを通じて `$IRSPACK_NUM_THREADS_DEFAULT` に解決され、なければ `os.cpu_count()` にフォールバックするため、実効的なデフォルトは学習ホストのコア数になります。Recotem は `n_threads` を設定せず、解決された値は学習時にシリアライズされたモデルに焼き込まれます — サービング時のオーバーライドはありません。単一リクエストのコールドスタートレイテンシが重要なワークロードでは、**学習**環境で `IRSPACK_NUM_THREADS_DEFAULT` を設定してください。これはサービング時ではなく学習時の判断です。
:::

---

## SLO

Recotem は内部的に SLO を強制しません。本番環境の推奨ベースラインターゲット:

| メトリクス | ターゲット |
|--------|--------|
| 推薦エンドポイント p99 レイテンシ | < 50 ms (純粋なレコメンダー、メタデータ結合なし) |
| `/v1/health` p99 レイテンシ | < 5 ms |
| 可用性 (レシピごと) | `recotem_model_loaded{recipe}` Prometheus ゲージで測定 |
| アーティファクトホットスワップ時間 | ≤ `RECOTEM_WATCH_INTERVAL` + モデルロード時間 |
| 学習から提供までのラグ | 学習をスケジュール; serve は ≤ `RECOTEM_WATCH_INTERVAL` 秒で検知 |

Prometheus メトリクスを有効化:

```bash
pip install "recotem[metrics]"
```

`RECOTEM_METRICS_ENABLED=1` を設定して `/v1/metrics` エンドポイントを有効化してください。

---

## ウォッチャーとレジストリのセマンティクス

`ArtifactWatcher` は serve プロセス内のデーモンスレッドとして実行されます:

- `RECOTEM_WATCH_INTERVAL` 秒ごと (1〜30 にクランプ、±10% のジッター) にポーリングします。最大 16 の stat() 呼び出しがスレッドプール経由で並列に発行されます。各並列 stat() フューチャーはフューチャーごとのタイムアウト `min(RECOTEM_WATCH_INTERVAL, 30)` 秒が適用されるため、ハングしたオブジェクトストアの stat (例: S3 の TCP ブラックホール) はティック全体をブロックしません。
- `recotem serve` のシャットダウン (SIGTERM) 時に、`ArtifactWatcher.stop()` は `executor.shutdown(wait=False, cancel_futures=True)` を呼び出し、キューに入っているが未開始のフューチャーが即座に破棄されます。
- 変更はアーティファクトポインターの mtime/size (ローカル FS) または ETag/VersionId (オブジェクトストア) から検知されます。マーカーが変化すると、ウォッチャーは完全なバイトを一度読み取り、sha256 を計算し、**sha256 も変化した場合のみリロードします** — 同じ内容のファイルに置き換えると mtime は変化しますが不要なスワップはトリガーされません。
- レシピディレクトリは各ティックで再スキャンされます: 新しい `*.yaml` ファイルは `recipe_discovered` と即時の強制ロードをトリガーし、削除されたファイルは `recipe_removed` をトリガーしてエントリがレジストリから削除されます。
- リロード中に何らかの失敗 (`artifact_load_failed`、`artifact_load_unexpected_error`) が発生した場合、既存のエントリは引き続きサービスされ、`last_load_error` フィールドが設定されるため `/v1/health` は陳腐化を示しつつ推薦エンドポイントは前の正常なモデルを返し続けます。

### 初期ロードの失敗

起動時にアーティファクトのロードが失敗した場合、レシピはスタブとして登録されます (`loaded=false`、`error=<理由>`)。サーバーは起動し、`/v1/health` は `degraded` を報告し、レシピの推薦エンドポイントは 503 を返します。部分的な障害はプロセスを再起動せずに再学習によって回復できます。

起動専用のイベントバリアント:

| イベント | トリガー |
|-------|---------|
| `initial_artifact_read_failed` / `initial_artifact_read_error` | I/O エラーまたは上限超過 |
| `initial_artifact_parse_failed` | マジック / バージョン / ヘッダー構造エラー |
| `initial_artifact_hmac_failed` | HMAC 不一致または不明な kid |
| `initial_artifact_deserialize_failed` | FQCN 許可リスト拒否またはペイロードデコードエラー |
| `initial_artifact_hmac_skipped_dev` | `--dev-allow-unsigned` |

### パースできないレシピファイル

*まったく* パースできないファイル (YAML 構文エラー、スキーマ違反) は、アーティファクトのロードに失敗したレシピとは異なる扱いになります。そのファイルはレシピを宣言していません — 名前もアーティファクトも、配信する対象もありません。このようなファイルは **スキップ** されます:

- `/v1/health` の **`total` と `loaded` のカウントから除外され**、代わりに独立した `skipped` カウントとして報告されます。このフィールドはカウントが 0 でない場合にのみ現れます。`/v1/health` は *ロード可能な* レシピがすべてロードされていれば `ok` (HTTP 200) を返すため、1 つのファイルのタイプミスが Pod 内の他のすべてのレシピの Kubernetes readiness プローブを失敗させることはありません。
- **`/v1/health/details` には引き続き表示され**、ファイル名の語幹をキーとして `"skipped": true` と、問題の **ファイル名** とパースエラーを示す `error` 文字列を伴います。レシピ名が読み取れないため語幹は便宜的なものです — 原因にたどり着く識別子はファイル名です。
- `skipped` のエントリは `/v1/health/details` を `degraded` に **しません**。配信が止まったものは何もないからです。

```json
{"status": "ok", "total": 3, "loaded": 3, "skipped": 1}
```

Pod がトラフィックを受け続けるかどうかを決めるのがこの区別です。**パースできないレシピファイル** は `skipped` カウント付きの `200` になり、Pod は Service に残ります。**アーティファクトをロードできない正常なレシピ** は `503 degraded` ([初期ロードの失敗](#初期ロードの失敗) を参照) になり、Pod は外されます。ログ上はどちらも失敗したレシピに見えますが、可用性の事象は後者だけです。

::: warning アラート
`skipped` のカウントでページング (呼び出し) しないでください — これは可用性ではなく設定品質のシグナルです。壊れたファイルが気づかれて修正されるよう警告レベルで通知し (`skipped > 0` がデプロイサイクルを超えて継続した場合)、readiness は `status` に紐づけたままにしてください。
:::

---

## バックアップと障害復旧

アーティファクトは自己完結型の署名済みバイナリです — 他のバイナリアセットと同様にバックアップしてください:

- **ローカル FS**: アーティファクトルート (または各レシピの `output.path` を含むディレクトリ) をスナップショット。`versioning: append_sha` は自動的に以前のバージョンを保持します。ポインターファイルが唯一の変更可能な部分です。
- **オブジェクトストア**: バケットのバージョニングを有効化してください。`append_sha` と組み合わせることで、学習実行ごとの不変な履歴が得られます。
- **レシピ**: レシピディレクトリをバージョン管理にコミットしてください。`RECOTEM_SIGNING_KEYS` (シークレットマネージャーに別途保管) と合わせて、レシピ + 鍵で `recotem train` を通じてあらゆるアーティファクトを再現できます。

ホスト障害後に `recotem serve` を復旧するには、レシピディレクトリと署名鍵のみが必要です。不足しているアーティファクトを再生成するために学習を再実行してください。ウォッチャーは再起動なしにそれらを検知します。

---

## モニタリング SLI

本番アラートの高シグナルメトリクス:

| シグナル | ソース | アラート閾値 (推奨) |
|--------|--------|-----------------------------|
| レシピが未ロード | `recotem_model_loaded{recipe=...} == 0` が `RECOTEM_WATCH_INTERVAL × 3` を超えて継続 | オンコールに page |
| ホットスワップ失敗 | `rate(recotem_swap_total{result="error"}[5m]) > 0` | warn |
| 再起動からのアーティファクトロード失敗 | `recotem_artifact_load_failures_total{recipe=...}` の増加 | warn |
| irspack バージョンスキュー | `rate(recotem_artifact_load_failures_total{reason="version_skew"}[5m])` | warn — 学習側とサービング側が乖離している。ホットスワップ時のスキューは旧モデルの配信を継続するが、同じアーティファクトは次回の再起動でレシピを失敗させる。[irspack バージョンスキュー](#irspack-バージョンスキュー) を参照 |
| コールドスタートのクライアントエラー | `rate(recotem_v1_requests_total{status=~"features_not_supported\|feature_value_unusable"}[5m])` | warn のみ。決してページングしないこと — 継続的なレートは、クライアントが `features:` ブロックを持たないレシピに `user_features`/`item_features` を送っているか、標準化できない値を送っていることを意味する。対処は呼び出し側にあり、モデルは正常 |
| アーティファクト stat 失敗 (ウォッチャーポーリング) | `recotem_artifact_stat_failures_total{recipe=...}` の増加 | warn |
| ウォッチャーの未処理エラー | `recotem_watcher_unhandled_errors_total` の増加 | warn |
| predict エラー率 | `rate(recotem_v1_requests_total{status="error"}[5m]) / rate(recotem_v1_requests_total[5m])` | 1% で warn、10% で page |
| predict レイテンシ | `histogram_quantile(0.99, recotem_v1_request_latency_seconds_bucket)` | レシピごとの SLO |
| アクティブレシピ | 前回のスクレイプから `recotem_active_recipes` が 0 より減少 | warn |
| BigQuery Storage API フォールバック | `rate(recotem_bigquery_storage_fallback_total{reason="api_error"}[5m]) > 0` | warn |
| レシピディレクトリスキャン失敗 | `rate(recotem_recipes_dir_scan_failures_total[5m]) > 0` | warn |

根本原因のコンテキストのために、構造化ログイベント `artifact_load_failed`、`artifact_disappeared`、`recipe_not_loaded_at_startup`、`auth_invalid_key` と組み合わせてください。

---

## アップグレード

Recotem は semver に従います。メジャーバージョン内 (`2.x`):

- レシピは有効のまま残ります。レシピローダーは後方互換性があります。
- アーティファクトフォーマットバージョンは `1` です。古いリーダーは新しいフォーマットを `unsupported format version` で拒否します。フォーマットが変更された場合、ライターをアップグレードした後に再学習してください。リーダーは先にアップグレードできます。
- FQCN 許可リストはリリースごとに凍結されます。変更は CHANGELOG に記載されます。アーティファクトが削除されたクラスをエンコードしている場合は再学習してください。
- **irspack のシリアライゼーション形式は上記のいずれにもカバーされません。** irspack は自身のマイナーバージョン間で形式の安定性を保証しないため、irspack のマイナーをまたぐ Recotem のアップグレードは既存のアーティファクトを拒否することがあります — アルゴリズムごと、遷移ごとに判定されます。この軸は**双方向**です。サービングを先行させる段階的な移行はできず、ロールバックもできません。許可リストのルール、拒否されるアルゴリズム、アップグレード手順については [irspack バージョンスキュー](#irspack-バージョンスキュー) を参照してください。
- **scikit-learn はさらに別の、ガードのない軸です。** `TruncatedSVD` のアーティファクトは sklearn の推定器を埋め込んでおり、sklearn は自身のマイナーバージョンをまたぐデシリアライズの正しさを保証しません。Recotem は `scikit-learn>=1.8,<1.10` を範囲でピン留めして窓を狭めていますが、閉じてはいません (範囲内の 2 つのインストールが異なる可能性があります)。ランタイムのチェックもありません。

serve フリートのゼロダウンタイムアップグレードには、新旧両方の署名 kid を設定した新しい Pod をデプロイし (ローテーションスタイル)、新しい Pod が正常になったら古い Pod をドレインしてください (`RECOTEM_DRAIN_SECONDS` に依存)。

::: danger この手順は新しい Pod が既存のアーティファクトをロードできることを前提としています
署名鍵のローテーションでは成り立ちますが、**irspack のマイナーをまたぐ場合は成り立ちません**。Recotem 2.1.0 は irspack を 0.4.x から 0.5.x へ移行します。irspack 0.5.x を実行する新しい Pod は、0.4.x で学習された IALS アーティファクトに対して決して正常になりません — デシリアライズ前に拒否され、レシピは `loaded: false` のままとなり、`/v1/health` は 503 を返すため、どの新規 Pod も readiness プローブを通過しません。

該当するレシピを*先に*新しい irspack バージョンで再学習するか、学習側とサービング側を同時にアップグレードして再学習の期間を受け入れてください。irspack を移行するアップグレードの前には必ず [irspack バージョンスキュー](#irspack-バージョンスキュー) を確認してください。
:::

---

## トラブルシューティング

### recotem serve が起動するがレシピが loaded: false

```bash
curl -H "X-API-Key: $RECOTEM_API_PLAINTEXT" \
  http://localhost:8080/v1/health/details | jq '.recipes'
```

```json
{"my_recipe": {"loaded": false, "last_load_error": "signature mismatch"}}
```

原因と修正:

| エラー | 原因 | 修正 |
|-------|-------|-----|
| `signature mismatch` | アーティファクトが `RECOTEM_SIGNING_KEYS` にない鍵で署名されている | 学習時に使用した署名 kid を追加する |
| `unknown kid: prod-old` | アーティファクト内の kid がサーバーの鍵リストにない | その kid を追加するか、既知の kid で再学習する |
| `magic bytes mismatch` | 破損または不完全なアーティファクト | 再学習する |
| `payload exceeds max bytes` | ペイロードが `RECOTEM_MAX_PAYLOAD_BYTES` (デフォルト 512 MiB) またはアーティファクトが `RECOTEM_MAX_ARTIFACT_BYTES` (デフォルト 2 GiB) を超えている | 該当する上限を増やすかモデルサイズを削減する |
| `header JSON too large` | 不正なアーティファクト | 再学習する |
| `irspack version skew: ...` | 学習側とサービング側の irspack の **major.minor** 遷移について、そのアーティファクトのアルゴリズムが互換性検証済みでない (例: 0.4 ↔ 0.5 をまたぐ IALS アーティファクト) | サービングホストの irspack バージョンでレシピを再学習する。[irspack バージョンスキュー](#irspack-バージョンスキュー) を参照 |
| `feature version check failed: ...` | アーティファクトの `features.version` が欠落、整数でない、またはこのビルドが実装するエンコーダ状態のバージョンでない (reason は `feature_version`) | サービング側のビルドの Recotem バージョンで再学習する。[セキュリティ — フィーチャーエンコーダのバージョンゲート](./security#フィーチャーエンコーダのバージョンゲート) を参照 |
| `feature state check failed: ...` | `features` ヘッダーがペイロード内のエンコーダ状態と食い違っている (reason は `feature_state`) — 不正に構築された、または部分的に改竄されたアーティファクト | 再学習する。[セキュリティ — フィーチャーのヘッダーとペイロードの突き合わせ](./security#フィーチャーのヘッダーとペイロードの突き合わせ) を参照 |

### irspack バージョンスキュー

irspack はマイナーリリース間でシリアライゼーション形式の安定性を保証しません。Recotem はすべてのアーティファクトヘッダーに学習時の `irspack_version` を記録し、ペイロードをデシリアライズする**前**に実行中の irspack と照合します。

このルールは拒否リストではなく**許可リスト**です。

- **major.minor が同一** → 常にロードされます。パッチの差 (`0.5.0` → `0.5.3`) は許容され、検証済みテーブルは参照されません。
- **major.minor が異なる** → アーティファクトの `best_class` *と*その正確な遷移の両方が Recotem の互換性検証済みテーブルに存在する場合にのみロードされます。存在しないものはすべて拒否されます。

**0.4 ↔ 0.5 で双方向に**互換性が検証済み: `CosineKNNRecommender`、`TopPopRecommender`、`RP3betaRecommender`、`DenseSLIMRecommender`、`TruncatedSVDRecommender`。ある行がテーブルに載るのは、一方のバージョンで学習したアーティファクトを他方でロードし — irspack だけを変数として — 推薦スコアがビット単位で一致することを確認した場合のみです。

0.4 ↔ 0.5 で拒否されるもの:

| `best_class` | 理由 |
|--------------|-----|
| `IALSRecommender` | **既知の破壊的変更**、双方向。0.5.0 でフィーチャーアウェア iALS が追加され、`IALSModelConfig` のシリアライズされた状態が 7 要素タプルから 10 要素タプルに拡大した。`__setstate__` はアリティが厳密なバインディング。 |
| `BPRFMRecommender` | **未検証** — `bprfm` エクストラの提供開始により学習可能になったため相互運用の実験は可能になったが、まだ実施されていない (irspack 0.4.x 環境が必要で、さらに BPRFM のペイロードは LightFM オブジェクトを内包するため、このテーブルが扱っていない 2 つ目のバージョン軸が加わる)。テーブルにないことは*未証明*を意味し、既知の破損を意味しない。 |
| `best_class` が欠落または文字列でない | **フェイルクローズ**: 自身のアルゴリズムを名乗れないヘッダーはテーブルに一致しえない。 |

拒否された場合、レシピは reason `version_skew` で `loaded: false` としてマークされ、次のエラーが表示されます (レシピ `news`、0.4.2 で学習した IALS アーティファクトを 0.5.0 で配信):

```
irspack version skew: retrain recipe 'news' with irspack 0.5.0 — IALSRecommender
0.4.2→0.5.0 is not verified compatible. Recotem allows only (algorithm, irspack
transition) pairs it has empirically verified load correctly; unverified is not
proof of breakage — the one known break is IALSRecommender at irspack 0.5.0,
whose serialized model state changed shape. Retrain and redeploy, or if you know
this artifact is unaffected set RECOTEM_ALLOW_IRSPACK_VERSION_SKEW=1 to
downgrade this to a warning.
```

対処法が意図的に前置きされています。サービングは保存する `last_load_error` を 200 文字に切り詰めてから `/v1/health/details` の `error` として公開するため、修正方法、レシピ名、アルゴリズム、両方のバージョンをすべてその予算内に収める必要があります。全文はログには残ります。

**将来の irspack のマイナーはすべて拒否から始まります。** このガードは*検証済み*のペアのテーブルを参照するため、後の 0.5 → 0.6 のアップグレードでは、上記の 5 つを含む**すべての**アルゴリズムのアーティファクトが、誰かがその遷移を検証して行を追加するまで拒否されます。これは意図的であり、テストされていないものを拒否するという安全側のデフォルトを保ちます。

**フェイルオープンのケース。** `irspack_version` を持たないヘッダー (2.0 以前のアーティファクト)、またはどちらか一方のバージョンがパースできない場合は、警告をログに記録してロードします。検証できないバージョンは非互換性の証拠ではなく、デシリアライザが最後の砦として残るからです。非対称性に注意してください — 使用できない*バージョン*はフェイルオープン、実際のスキューにおける使用できない *`best_class`* はフェイルクローズです。

**このチェックが存在する理由。** これがなければ、障害は irspack の C++ 層から素の `TypeError: __setstate__(): incompatible function arguments` として現れ、レシピ名も対処法も示しません。

**アップグレード手順。** 学習側とサービング側を同時にアップグレードし、その後すべての IALS および BPRFM のレシピを再学習してください。破壊的変更は双方向であるため、サービングを先に移す段階的なアップグレードはできず、アーティファクトを 0.5.x で再学習した後にサービングを 0.4.x に戻すこともできません。アーティファクトのインプレース移行はありません。欠けているフィールドは内部の C++ の状態であり、再学習だけが正しく生成できます。

::: danger 影響範囲 — 今は劣化、後で停止
サービングはクラッシュしません。影響を受けたレシピが失敗としてマークされ、他のすべてのレシピは配信を続けます。**ホットスワップ**の間は以前ロードされたモデルがメモリに残るため (ロードエラーは `loaded` フラグを消さずにエントリに注記されます)、稼働中のフリートに投入されたスキューのあるアーティファクトは、障害ではなく「引き続き旧モデルを配信」に劣化し、件数ベースの `/v1/health` は `200` のままです。エラー文字列も走査する `/v1/health/details` だけが `degraded` を報告します。

この耐性は**プロセス単位であり、再起動を生き延びません。** 起動時にはフォールバックできる既ロードのモデルが存在しません。レシピは `loaded: false` のスタブとして登録され、`/v1/health` は **503** を返し、`/v1/health` を指すすべての readiness / liveness プローブが失敗します。つまりスキューのあるアーティファクトは稼働中のフリートでは無害に居座り、次の再起動、ノードのドレイン、スケールアップで — それを持ち込んだデプロイからかなり後になって — Pod を落とします。

同梱の Helm チャート (`replicaCount: 2`、`strategy:` ブロックなし) では、Kubernetes のローリングアップデートのデフォルトにより `maxUnavailable = floor(0.25 × 2) = 0` となるため、ローリングアップデートは即時の障害ではなく、旧 Pod が配信を続けたまま**停滞**します — 新しい Pod は決して ready にならず、場所を空けるために旧 Pod を落とすこともできません。危険なのは停滞したロールアウトではなく、劣化状態が次の*不本意な*再起動で終わることです。チャートは `pdb.enabled: false` も同梱しているため、ノードのドレインが両方のレプリカを同時に落とすことがあります。
:::

**エスケープハッチ。** `RECOTEM_ALLOW_IRSPACK_VERSION_SKEW=1` は拒否を `irspack_version_skew_allowed` 警告に格下げし、ペイロードをデシリアライザに到達させます。アーティファクトが影響を受けないと分かっている場合にのみ使用してください — 既知の破損ではなく単に*未検証*であるアルゴリズムに対してがもっとも正当化しやすい使い方です。互換性のないペイロードがロード可能になるわけではありません。本当に壊れているアーティファクトは、このガードが置き換えようとしている素の `TypeError` で失敗します。

学習側とサービング側が乖離したフリートを検知するには `recotem_artifact_load_failures_total{reason="version_skew"}` を監視してください。

**このガードがカバーしない別の軸: scikit-learn。** `TruncatedSVDRecommender` は sklearn の推定器をペイロードに埋め込みます。sklearn は自身のマイナーバージョンをまたぐデシリアライズが「コードの破損や無効な結果につながる可能性がある」と警告します (`InconsistentVersionWarning`)。Recotem は `scikit-learn>=1.8,<1.10` を範囲でピン留めしてこれを抑えていますが、範囲の指定は**軸を狭めるだけで閉じません** — 範囲内の 2 つのインストールが異なる可能性があり、irspack のガードは sklearn のバージョンを一切検査しません。TruncatedSVD のアーティファクトをビット単位で再現する必要がある場合は、sklearn を厳密にピン留めするか、学習側とサービング側を同じロックファイルからビルドしてください。

### recotem train が終了コード 3 (DataSourceError) で終了する

BigQuery の場合: `gcloud auth application-default print-access-token` を実行して ADC が機能していることを確認してください。JSON の標準エラー行で正確なエラーを確認してください。

```bash
recotem train recipe.yaml 2>&1 | grep '"event":"train_error"' | jq .
```

#### BigQuery Storage Read API フォールバック

サービスアカウントが `bigquery.readSessions.create` を持っていない場合、BigQuery ソースは `bigquery_storage_fallback` 警告をログ出力し、より遅い REST API にフォールバックします。権限を付与するには:

```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<SA>@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/bigquery.readSessionUser"
```

フォールバックを無効化してエラーを表面化させるには、`RECOTEM_BQ_REQUIRE_STORAGE_API=1` を設定してください。

### recotem train が min_data_violation で終了コード 4 で終了する

クレンジング後のデータセットが閾値を下回りました。JSON エラー行に観測されたカウントが含まれます。

```json
{"event": "train_error", "code": "min_data_violation", "n_rows": 842, "min_rows": 1000, ...}
```

レシピの `cleansing.min_rows` を下げるか、ソースからの行数が減った原因を調査してください。

### recotem train が zero_score で終了コード 4 で終了する

すべての Optuna トライアルのスコアが 0.0 でした。一般的な原因:

- 分割によってホールドアウトのテストセットが空になった。`random` と `time_user` ではホールドアウトが
  **ユーザーごと**に切り捨てられ、`1 / heldout_ratio` 個未満の異なりアイテムしか持たないユーザーは
  何も寄与しません。したがってスキームの変更やユーザー数の増加では解決しません。**`split.heldout_ratio`
  を上げて**ください (エラーメッセージに有効な最小値が示されます)。あるいは 1 ユーザーあたりの履歴を
  深くするか、深いユーザーが検証ユーザーとして抽出されていない場合は `split.test_user_ratio` を上げてください。
- クレンジング後のデータのアイテム数がカットオフに対して少なすぎる。`training.cutoff` を下げてください。

### recotem train が feature_axis_error で終了コード 4 で終了する

[`features:`](./recipe-reference#features) のいずれかのサイドのフィーチャーテーブルが、インタラクションデータと ID の重なりを**まったく**持ちません — 1 件も一致しませんでした。ソース側で ID カラムの型が変わると、それまで成功していた実行がこれで中断されるため、一目で認識できるようにしておく価値があります。メッセージは両側から ID をサンプリングするため、通常はそれだけで原因が分かります。

```
features.item: none of the 1200 item ids in the interaction data were found in
the feature table's 'item_id' column, so every item would encode to the bias
column alone ... feature-table ids look like ['1.0', '2.0', '3.0']; interaction
ids look like ['1', '2', '3'].
```

これが警告ではなく致命的である理由は、そうしなければ障害が**サイレント**になるからです。すべてのエンティティがバイアスカラムのみにエンコードされるため、学習は最後まで実行され、実体は通常の iALS でありながらヘッダーが `features` を宣言するアーティファクトに署名してしまいます。モデルは配信され、スコアは悪化し、その理由はログのどこにも残りません。

発生原因はほぼ次の 2 つに集約されます。

- **ID の dtype 不一致** — 上記のサンプルが示すケースです。整数の ID カラムに空セルが 1 つあるだけで pandas は `float64` と推論するため、インタラクション側が `"1"` を持つ一方で `1` が `1.0` として読み込まれます。データを整形するのではなくソース側で型を固定してください。`csv` のフィーチャーテーブルなら `dtype: {item_id: str}` を追加します。`dtype` は csv 専用です — `bigquery` / `sql` ではクエリ側でキャストし (`CAST(item_id AS STRING)`)、`parquet` ではファイルのスキーマで型を修正してください。
- **存在はするが誤った `id_column`** — 存在はするがエンティティ ID を保持しないカラムは、フェッチ時の存在チェックを通過し、ここで初めて失敗します。`features.<side>.id_column` が `schema.item_column` / `schema.user_column` と同じ ID 空間を指しているか確認してください。

Recotem は意図的に ID カラムを自動変換しません。フレームが取得された時点で pandas はすでに `float64` と推論しており、元のテキストは復元できません — `1.0` と読めるカラムは、ID が文字どおり `"1.0"` であるカラムと区別できません。したがって整数値の float を int に戻す整形は、その形式を正当に使っているカタログの ID を黙って書き換えることになり、検出可能な失敗を静かな破損と引き換えにしてしまいます。また誤った `id_column` のケースはまったく捕捉できません。

::: tip ヒント — 中断するのは一致が**ゼロ**の場合のみです
部分的なカバレッジは正当かつ想定内です。フィーチャーテーブルに存在しない ID はバイアスのみにエンコードされ、そのエンティティに限り通常の iALS に劣化します。これはコールドスタートのスコアリングを可能にしているのと同じ仕組みです。低カバレッジの警告しきい値は意図的に存在しません — dtype や `id_column` の誤りはカラム全体の性質であり、必ずちょうど 0% になるため、ゼロより上のしきい値は正しい設定でも発火してしまいます。カバレッジを追跡したい場合は `feature_axis_coverage` イベント (`side`、`matched`、`total`) に対して自分でアラートを設定してください。
:::

### 推薦エンドポイントで 401

- `X-API-Key` ヘッダーの先頭または末尾の空白は鍵の一部として扱われ、一致しません。クライアント側でトリムしてください。
- `RECOTEM_API_KEYS` のハッシュが、送信しているプレーンテキストに対して `recotem keygen --type api` で生成されたことを確認してください。ワイヤープレフィックスは `sha256:` ですが、ダイジェストは scrypt です — 単純な `sha256(plaintext)` では一致しません。

### /v1/recipes/{name}:recommend で 503 (および関連動詞)

レシピが不健全です (`loaded: false`)。エラーは `/v1/health/details` を確認してください。通常は署名の不一致または破損したアーティファクトです。

### /v1/recipes/{name}:recommend で 404 UNKNOWN_USER

リクエストの `user_id` が学習データに存在しませんでした。これは新規ユーザーの場合に期待される動作です。アプリケーションレイヤーで処理してください (例: 人気度ベースのレコメンデーションにフォールバックする)。[`features:`](./recipe-reference#features) ブロックで学習したモデルであれば、`user_features` を渡すことで代わりにそのユーザーへの実際の推薦が返ります — [サービング API — フィーチャーアウェアなコールドスタート](./serving-api#フィーチャーアウェアなコールドスタート) を参照してください。

### /v1/recipes/{name}:recommend-related で 404

このステータスは 2 つの異なるコードで共有されます。

- `UNKNOWN_SEED_ITEMS` — 渡された `seed_items` のいずれも学習済みモデルに知られていません。通常はクライアント側のデータの問題です。
- `NO_CANDIDATES` — 少なくとも 1 件のシードは既知でしたが、ランカーが内部のフィルタリング後に候補を 1 件も残しませんでした。通常はクライアントの誤りではなくデータ分布の問題です。この動詞のすべての分岐 (2 つのフィーチャーアウェアなコールドスタート分岐を含む) が同じ形で送出するため、どの経路が処理したかに関わらず空の結果は同一に報告されます。

### /v1/recipes/{name} のいずれかの動詞で 422

ハンドラーが実行される前にリクエストのバリデーションが失敗しました。ボディは `{"detail": "Request validation failed", "code": "VALIDATION_ERROR", "errors": [...]}` で、リクエストは `recotem_v1_requests_total` で `status="validation_error"` としてカウントされます。

コールドスタートのフィールドでは、キー数・キー長・値の型・値の長さの違反もこの形で現れます — [サービング API — コールドスタートフィールドの長さとサイズの上限](./serving-api#コールドスタートフィールドの長さとサイズの上限) を参照してください。

### /v1/recipes/{name}:batch-recommend または :batch-recommend-related での部分的な失敗

バッチエンドポイントは 1 回の呼び出しで最大 256 件のリクエストを受け付け、要素ごとの `status` を返すため、1 件の不正な入力がバッチ全体を失敗させることはありません。HTTP レスポンスは*いずれか*の要素が成功すれば **200** です (失敗した要素は `code` フィールド付きの `status: "error"` を持ちます)。HTTP **503** は、レシピ自体が利用不可で 1 件も処理できない場合のために予約されています。

クライアント側のデータの問題とモデルの問題を切り分けるには、`code` ごとに `recotem_v1_batch_element_errors_total` を監視してください。

### ウォッチャーが新しいアーティファクトを検知しない

- `RECOTEM_WATCH_INTERVAL` を確認してください。デフォルトは 5 秒です。
- オブジェクトストアの場合、serve プロセスの IAM ロールがアーティファクトバケットに対する `GetObject` (S3) または `storage.objects.get` (GCS) を持っていることを確認してください。
- アーティファクトパスに対して `recotem inspect` を実行し、それが有効でサーバーが知っている kid で署名されていることを確認してください。`recotem inspect` はローカルパスと fsspec URI の両方を受け付けます (例: `s3://bucket/key.recotem`)。

### ログのリダクション

すべてのログイベントは出力前にリダクションプロセッサーによって処理されます。期待していた値があるべきログ行で `[REDACTED]` が見える場合、フィールド名がリダクションパターンに一致しています。これは意図的です — 詳細はセキュリティドキュメントを参照してください。
