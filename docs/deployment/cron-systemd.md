---
title: cron / systemd Deployment
---

# cron / systemd Deployment

`recotem train` is a plain process with a well-defined exit code contract. Any scheduler that can run a command on a schedule works.

## Linux cron

Add to `/etc/cron.d/recotem` using the system crontab format (the 6-field form includes a username column). Source a secrets file so plaintext keys never appear in the crontab itself:

```cron
# /etc/cron.d/recotem — run as the `recotem` user
0 3 * * * recotem . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

For a user crontab managed via `crontab -e`, drop the `recotem` username — user crontabs use the 5-field form and run as the invoking user:

```cron
0 3 * * * . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

```bash
# /etc/recotem/secrets — mode 600, owned by the cron user
export RECOTEM_SIGNING_KEYS="prod-2026-q2:aabbcc..."
```

Secure both the crontab and the secrets file:

```bash
chmod 600 /etc/cron.d/recotem
chown root:root /etc/cron.d/recotem
chmod 600 /etc/recotem/secrets
chown recotem:recotem /etc/recotem/secrets
```

::: danger Do not embed secrets directly in the crontab
`/etc/cron.d/` files may be world-readable on some distributions:

```cron
# BAD — exposes the key to any local user who can read /etc/cron.d/recotem
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
0 3 * * * recotem /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```
:::

## Wrapper script

For more control over retries, alerting, and log rotation, use a wrapper script:

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

See [Exit Codes & Errors](../exit-codes) for the full exit code reference and recommended retry policy per code.

## systemd timer

A systemd timer gives better logging (journald), dependency handling, and restart control.

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
Persistent=true          # run on next boot if the last run was missed

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now recotem-train.timer
```

Check status:

```bash
systemctl status recotem-train.timer
journalctl -u recotem-train.service -n 50
```

## Environment file

`EnvironmentFile` (systemd) or the secrets-sourcing pattern (cron) should be mode `600`, owned by the service user, and excluded from version control.

```bash
# /etc/recotem/secrets — mode 600, owner recotem
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
```

::: tip
For systemd `EnvironmentFile`, do not use `export` — systemd reads the file as `KEY=VALUE` pairs directly, not as shell syntax.
:::

## serve as a systemd service

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

When `recotem train` writes a new artifact, the serve process detects it at the next poll and hot-swaps — no service restart needed.

## Timezone

`cron` uses the system timezone (`/etc/localtime`); set `CRON_TZ=UTC` at the top of the crontab if you want explicit UTC. The systemd timer above pins `OnCalendar=… UTC` which is independent of system timezone.

## Lock contention

If a cron job fires while a previous training run is still active **on the same host**, the second invocation acquires no lock and exits 0 (skip). The lock uses POSIX `flock`, which is host-local — it does **not** coordinate runs across multiple machines, and with an `s3://` / `gs://` `output.path` it does not coordinate across pods either (see [Kubernetes Deployment](./kubernetes)).

This is the default and is safe for standard cron setups but means **the scheduler sees a successful run when nothing was actually trained** — point alerting at the structured `recipe_lock_contended_skipping` log line, not just the exit code, or pass `--fail-on-busy`:

```bash
recotem train --fail-on-busy /etc/recotem/recipes/my_recipe.yaml
```

Exit will be non-zero when the lock is held, which most monitoring systems treat as a failure. Pair this with a cron schedule whose interval comfortably exceeds the p99 training duration; `recotem train` log lines include the run duration for sizing.

::: tip Run at a single host
Run `recotem train` from a single host (or guard cross-host concurrency in your scheduler) when you need single-writer semantics. Recotem logs `recipe_lock_local_only` whenever the output is a remote URI.
:::
