---
title: cron / systemd デプロイメント
---

# cron / systemd デプロイメント

`recotem train` は明確な終了コードコントラクトを持つ通常のプロセスです。スケジュールに従ってコマンドを実行できるスケジューラーであれば何でも使用できます。

## Linux cron

システム crontab 形式 (6 フィールド形式にはユーザー名カラムが含まれます) を使って `/etc/cron.d/recotem` に追加します。シークレットファイルをソースすることで、プレーンテキストの鍵が crontab 自体に現れないようにします。

```cron
# /etc/cron.d/recotem — `recotem` ユーザーとして実行
0 3 * * * recotem . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

`crontab -e` で管理するユーザー crontab の場合、`recotem` ユーザー名を省略します — ユーザー crontab は 5 フィールド形式を使用し、実行ユーザーとして動作します。

```cron
0 3 * * * . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

```bash
# /etc/recotem/secrets — モード 600、cron ユーザー所有
export RECOTEM_SIGNING_KEYS="prod-2026-q2:aabbcc..."
```

crontab とシークレットファイルの両方を保護してください。

```bash
chmod 600 /etc/cron.d/recotem
chown root:root /etc/cron.d/recotem
chmod 600 /etc/recotem/secrets
chown recotem:recotem /etc/recotem/secrets
```

::: danger 警告 — シークレットを crontab に直接埋め込まないこと
`/etc/cron.d/` のファイルは一部のディストリビューションで誰でも読み取り可能な場合があります。

```cron
# 悪い例 — /etc/cron.d/recotem を読める任意のローカルユーザーに鍵が露出する
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
0 3 * * * recotem /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```
:::

## ラッパースクリプト

リトライ、アラート、ログローテーションをより細かく制御するには、ラッパースクリプトを使用してください。

```bash
#!/usr/bin/env bash
# /usr/local/bin/recotem-train-daily.sh
set -euo pipefail

. /etc/recotem/secrets

RECIPE=/etc/recotem/recipes/my_recipe.yaml
LOG=/var/log/recotem/train-$(date +%Y%m%d-%H%M%S).log

/usr/local/bin/recotem train "$RECIPE" 2>&1 | tee "$LOG"
EXIT=${PIPESTATUS[0]}

case $EXIT in
  0) echo "train: success" ;;
  2) echo "train: RecipeError (check recipe YAML)" >&2; exit $EXIT ;;
  3) echo "train: DataSourceError (transient?)" >&2; exit $EXIT ;;
  4) echo "train: TrainingError (data or tuning issue)" >&2; exit $EXIT ;;
  5) echo "train: ArtifactError (check RECOTEM_SIGNING_KEYS)" >&2; exit $EXIT ;;
  6) echo "train: lock contested — another process holds the lock; retry later" >&2; exit $EXIT ;;
  7) echo "train: HTTP fetch error — network issue or sha256 mismatch; alert ops" >&2; exit $EXIT ;;
  8) echo "train: config error — check RECOTEM_SIGNING_KEYS and env vars; alert ops, do not retry" >&2; exit $EXIT ;;
  *) echo "train: unexpected error (exit $EXIT)" >&2; exit $EXIT ;;
esac
```

```cron
0 3 * * * recotem /usr/local/bin/recotem-train-daily.sh
```

完全な終了コードリファレンスとコードごとの推奨リトライポリシーについては [終了コードとエラー](../exit-codes) を参照してください。

## systemd タイマー

systemd タイマーはより良いロギング (journald)、依存関係の処理、再起動制御を提供します。

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
Persistent=true          # 前回の実行を逃した場合は次回起動時に実行

[Install]
WantedBy=timers.target
```

有効化と起動:

```bash
systemctl daemon-reload
systemctl enable --now recotem-train.timer
```

状態の確認:

```bash
systemctl status recotem-train.timer
journalctl -u recotem-train.service -n 50
```

## 環境ファイル

`EnvironmentFile` (systemd) またはシークレットソースパターン (cron) はモード `600`、サービスユーザー所有、バージョン管理から除外されている必要があります。

```bash
# /etc/recotem/secrets — モード 600、owner recotem
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
```

::: tip ヒント
systemd の `EnvironmentFile` では `export` を使用しないでください — systemd はファイルをシェル構文としてではなく `KEY=VALUE` ペアとして直接読み取ります。
:::

## systemd サービスとしての serve

```ini
# /etc/systemd/system/recotem-serve.service
[Unit]
Description=Recotem serve
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=recotem
EnvironmentFile=/etc/recotem/secrets
Environment=RECOTEM_HOST=0.0.0.0
Environment=RECOTEM_PORT=8080
Environment=RECOTEM_LOG_FORMAT=json
Environment=RECOTEM_WATCH_INTERVAL=30
ExecStart=/usr/local/bin/recotem serve --recipes /etc/recotem/recipes/
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=recotem-serve

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now recotem-serve.service
```

`recotem train` が新しいアーティファクトを書き込むと、serve プロセスは次のポーリングで検知してホットスワップします — サービスの再起動は不要です。

## タイムゾーン

`cron` はシステムタイムゾーン (`/etc/localtime`) を使用します。明示的な UTC を使いたい場合は crontab の先頭に `CRON_TZ=UTC` を設定してください。上記の systemd タイマーは `OnCalendar=… UTC` を指定しており、システムタイムゾーンとは独立しています。

## ロック競合

**同一ホスト上で**前回の学習実行がまだアクティブな状態で cron ジョブが起動した場合、2 回目の呼び出しはロックを取得できず、終了コード 0 (スキップ) で終了します。ロックは POSIX `flock` を使用しており、ホストローカルです — 複数のマシン間での実行を調整**しません**。また `s3://` / `gs://` の `output.path` では Pod 間の調整も行いません ([Kubernetes デプロイメント](./kubernetes) を参照)。

これはデフォルトの動作であり、標準的な cron 設定には安全ですが、**実際に何も学習されなかった場合でもスケジューラーは成功した実行として認識します** — 終了コードだけでなく、構造化ログの `recipe_lock_contended_skipping` イベントにアラートを設定するか、`--fail-on-busy` を渡してください。

```bash
recotem train --fail-on-busy /etc/recotem/recipes/my_recipe.yaml
```

ロックが保持されている場合は非ゼロで終了し、ほとんどのモニタリングシステムはこれを失敗として扱います。cron スケジュールのインターバルが p99 学習時間を十分上回るよう設定してください。`recotem train` のログには実行時間が含まれているため、サイジングの参考にできます。

::: tip ヒント — 単一ホストで実行
シングルライターのセマンティクスが必要な場合は、単一ホストから `recotem train` を実行してください (またはスケジューラーでホスト間の並列実行を制御してください)。出力がリモート URI の場合、Recotem は `recipe_lock_local_only` をログ出力します。
:::
