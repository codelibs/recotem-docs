---
title: バッチとスケジューリング
description: cron、Docker Compose、または Kubernetes CronJob を使ってスケジュールに従って再学習します。
---

# バッチとスケジューリング

推薦モデルは、ユーザーの行動やアイテムカタログの変化とともに精度が低下していきます。`recotem train` をスケジュール (毎晩、毎週、またはデータ更新のたびに) で実行することで、手動の介入なしに予測を最新の状態に保てます。

学習から配信までの流れはシンプルです。

1. スケジューラがレシピに対して `recotem train` を実行します。
2. `recotem train` が新しいアーティファクト (学習済みモデルファイル) をディスクまたはクラウドストレージに書き出します。
3. `recotem serve` が次のポーリング (デフォルトで 5 秒ごと) で新しいアーティファクトを検出し、インメモリのモデルをホットスワップします。サーバーの再起動は不要です。

クライアントはダウンタイムを経験しません。新しいモデルが完全に読み込まれて検証されるまで、古いモデルが引き続き応答します。

---

## パターン 1 — Linux cron または systemd タイマー

最もシンプルな構成: アーティファクトが保存されているのと同じホスト上の cron ジョブです。

### cron

`/etc/cron.d/recotem` にエントリを追加します。署名鍵が crontab 自体に現れないよう、シークレットは別ファイルから読み込みます (システムによっては `/etc/cron.d/` が全ユーザーに読み取り可能な場合があります)。

```bash
# /etc/recotem/secrets — パーミッション 600、サービスユーザーが所有
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
```

```cron
# /etc/cron.d/recotem — システム crontab 形式 (ユーザーフィールドを含む)
# `recotem` ユーザーとして毎日 03:00 に学習を実行。シークレットを読み込んでから学習。
0 3 * * * recotem . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

ユーザー crontab (`crontab -e`) の場合は `recotem` ユーザー名フィールドを省略してください。ユーザー crontab は実行ユーザーとして動作し、5 フィールド形式を使います。

シークレットファイルを保護します。

```bash
chmod 600 /etc/recotem/secrets
chown recotem:recotem /etc/recotem/secrets
```

### systemd タイマー

systemd タイマーを使うと、より良いロギング (journald 経由) が得られ、実行が漏れた場合もクリーンに処理されます。

```ini
# /etc/systemd/system/recotem-train.service
[Unit]
Description=Recotem daily training
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=recotem
EnvironmentFile=/etc/recotem/secrets
ExecStart=/usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml
StandardOutput=journal
StandardError=journal
SyslogIdentifier=recotem-train
```

```ini
# /etc/systemd/system/recotem-train.timer
[Unit]
Description=Recotem daily training timer

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true   # スケジュールされた実行が漏れた場合、次回起動時に実行

[Install]
WantedBy=timers.target
```

有効化して起動します。

```bash
systemctl daemon-reload
systemctl enable --now recotem-train.timer
```

状態と直近のログを確認します。

```bash
systemctl status recotem-train.timer
journalctl -u recotem-train.service -n 50
```

`recotem serve` プロセスはコンパニオンの systemd サービスとして実行できます。`recotem train` が新しいアーティファクトを書き出すと、`recotem serve` のウォッチャーがそれを検出してモデルをホットスワップします。serve サービスを再起動する必要はありません。

---

## パターン 2 — Docker Compose

チュートリアルの `compose.yaml` には `train` サービス (一回限り) と `serve` サービス (常時稼働) が含まれています。serve を常時稼働させながら cron スケジュールで train を実行することで、同じパターンを本番環境に適用できます。

```bash
# スケジュールに従って学習を実行 (ホストの crontab や CI トリガーから)
RECOTEM_SIGNING_KEYS="prod:..." \
RECOTEM_API_KEYS="client:sha256:..." \
docker compose run --rm train
```

`train` サービスは `artifacts` ボリュームに書き込み、`serve` サービスは同じボリュームから読み込みます。serve コンテナはボリュームを読み取り専用でマウントするため、ボリュームレベルでのコンテナ間のファイルロック調整は不要です。

---

## パターン 3 — Kubernetes CronJob

すでに Kubernetes を使っているチームには、学習に `CronJob`、配信に `Deployment` を使う方法が自然なアプローチです。両者は共有の PersistentVolumeClaim またはオブジェクトストレージ (S3、GCS) を通じてアーティファクトにアクセスします。

### CronJob (学習)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: recotem-train
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid      # 前の実行がまだ動いていればスキップ
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: train
              image: ghcr.io/codelibs/recotem:latest
              command: ["recotem", "train", "/recipes/my_recipe.yaml"]
              volumeMounts:
                - name: recipes
                  mountPath: /recipes
                  readOnly: true
                - name: artifacts
                  mountPath: /artifacts
              env:
                - name: RECOTEM_SIGNING_KEYS
                  valueFrom:
                    secretKeyRef:
                      name: recotem-auth
                      key: RECOTEM_SIGNING_KEYS
          volumes:
            - name: recipes
              configMap:
                name: recotem-recipes
            - name: artifacts
              persistentVolumeClaim:
                claimName: recotem-artifacts
```

`concurrencyPolicy: Forbid` を設定することで、重複する実行が並行して動くのではなくスキップされます。Recotem のレシピごとのファイルロックは単一ホスト上での二次的な保護を提供しますが、Kubernetes のポリシーの方がコストが低くポッドをまたいだ信頼性も高いです。

**終了コードごとの推奨再起動動作:**

| 終了コード | 意味 | 対応 |
|---|---|---|
| 0 | 成功 (またはロックスキップ — 下記参照) | ジョブは正常終了 |
| 2 | レシピエラー (不正な YAML、スキーマ違反) | 再試行しない — ConfigMap を修正する |
| 3 | データソースエラー | 通常は再試行しない (永続的な問題) |
| 4 | 学習エラー | `backoffLimit` まで再試行 |
| 5 | アーティファクトエラー (破損ファイル、HMAC 検証の失敗) | 再試行しない — アーティファクトファイルまたは署名に使った鍵を調査する |
| 6 | ロック競合 (`--fail-on-busy` が設定されている) | 再試行するか別の場所にルーティング |
| 7 | HTTP フェッチエラー (一時的) | 再試行 |
| 8 | 設定エラー (環境変数の欠落) | 再試行しない — Secret を修正する |

### 重複実行の処理

デフォルトでは、別のプロセスがロックを保持している場合、`recotem train` は `recipe_lock_contended_skipping` というログイベントを記録して終了コード 0 で終了します。Kubernetes Job は正常終了と見なします。これは cron における正しい動作です (実行が遅くなっても重複するジョブが積み重なるべきではありません)。スキップされた実行を把握したい場合は、終了コードではなく構造化ログイベントにアラートを設定するか、`--fail-on-busy` を渡してロック競合を終了コード 6 にしてください。

::: warning 注意
Recotem のファイルロックはホストローカルです。`s3://` や `gs://` のアーティファクトパスの場合、別のポッドからの並行書き込みを防ぎません。単一ライターのセマンティクスを保証するには、`concurrencyPolicy: Forbid` (上記の例にすでに設定済み) を使用して Kubernetes レイヤーで制御してください。
:::

---

## 配信を自動的に最新の状態に保つ

`recotem serve` が起動すると、`RECOTEM_WATCH_INTERVAL` 秒ごと (デフォルト 5 秒、最大 30 秒まで設定可能) に新しいアーティファクトをポーリングします。学習が新しいアーティファクトを書き出すと、ウォッチャーは以下を実行します。

1. mtime または ETag でファイルの変化を検出します。
2. アーティファクトの全バイトを読み込みます。
3. 設定された署名鍵に対して HMAC 署名を検証します。
4. 検証が通れば、インメモリのモデルをアトミックに入れ替えます。
5. 検証に失敗した場合 (鍵の不一致、ファイル破損)、以前の正常なモデルを維持し、エラーは構造化ログと `/v1/health/details` のレシピごとの `last_load_error` に記録されます。

入れ替え中にリクエストがドロップされることはありません。新しいモデルの準備が整うまで、以前のモデルが引き続き応答します。

現在のモデルの状態はいつでも確認できます。

```bash
curl http://localhost:8080/v1/health
# {"status":"ok","total":1,"loaded":1}
```

---

## 参考ドキュメント

- [デプロイ: Docker](/docs/deployment/docker) — 本番環境向け Docker パターン
- [デプロイ: Kubernetes](/docs/deployment/kubernetes) — 完全な Helm チャートリファレンスとローリングアップデートのガイド
- [デプロイ: cron / systemd](/docs/deployment/cron-systemd) — 詳細な cron とラッパースクリプトのパターン
- [オペレーション](/docs/operations) — 鍵のローテーション、メモリのサイジング、トラブルシューティング
