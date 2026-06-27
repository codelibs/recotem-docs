---
title: オペレーションランブック
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

すべてのレシピが正常にロードされたことを確認してください。レシピごとの状態は認証が必要な `/v1/health/details` エンドポイントにあります — パブリックな `/v1/health` は `{status, total, loaded}` の集計値のみを返します。

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

単一ホストまたは分散クラスター上での複数プロセスの Optuna 探索 (並列化) には、レシピに `training.storage_path` を設定してください。受け入れられる形式: 裸のパス (SQLite)、または `sqlite://`、`postgresql://`、`postgres://`、`mysql://` で始まる URL。同じレシピに対する複数の `recotem train` 呼び出しは、作業を重複させるのではなく共有トライアルプールに収束します。スタディ名は `recotem_<recipe.name>_<run_id>` です。

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

serve フリートのゼロダウンタイムアップグレードには、新旧両方の署名 kid を設定した新しい Pod をデプロイし (ローテーションスタイル)、新しい Pod が正常になったら古い Pod をドレインしてください (`RECOTEM_DRAIN_SECONDS` に依存)。

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

- 分割によって空のテストセットが生成された (ユーザー数またはインタラクション数が少なすぎる)。`split.scheme: random` を試すか `split.heldout_ratio` を下げてください。
- クレンジング後のデータのアイテム数がカットオフに対して少なすぎる。`training.cutoff` を下げてください。

### 推薦エンドポイントで 401

- `X-API-Key` ヘッダーの先頭または末尾の空白は鍵の一部として扱われ、一致しません。クライアント側でトリムしてください。
- `RECOTEM_API_KEYS` のハッシュが、送信しているプレーンテキストに対して `recotem keygen --type api` で生成されたことを確認してください。ワイヤープレフィックスは `sha256:` ですが、ダイジェストは scrypt です — 単純な `sha256(plaintext)` では一致しません。

### /v1/recipes/{name}:recommend で 503 (および関連動詞)

レシピが不健全です (`loaded: false`)。エラーは `/v1/health/details` を確認してください。通常は署名の不一致または破損したアーティファクトです。

### /v1/recipes/{name}:recommend で 404 UNKNOWN_USER

リクエストの `user_id` が学習データに存在しませんでした。これは新規ユーザーの場合に期待される動作です。アプリケーションレイヤーで処理してください (例: 人気度ベースのレコメンデーションにフォールバックする)。

### ウォッチャーが新しいアーティファクトを検知しない

- `RECOTEM_WATCH_INTERVAL` を確認してください。デフォルトは 5 秒です。
- オブジェクトストアの場合、serve プロセスの IAM ロールがアーティファクトバケットに対する `GetObject` (S3) または `storage.objects.get` (GCS) を持っていることを確認してください。
- アーティファクトパスに対して `recotem inspect` を実行し、それが有効でサーバーが知っている kid で署名されていることを確認してください。`recotem inspect` はローカルパスと fsspec URI の両方を受け付けます (例: `s3://bucket/key.recotem`)。

### ログのリダクション

すべてのログイベントは出力前にリダクションプロセッサーによって処理されます。期待していた値があるべきログ行で `[REDACTED]` が見える場合、フィールド名がリダクションパターンに一致しています。これは意図的です — 詳細はセキュリティドキュメントを参照してください。
