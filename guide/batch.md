---
title: Batch and Scheduling
description: Retrain on a schedule using cron, Docker Compose, or Kubernetes CronJob.
---

# Batch and Scheduling

Recommendation models drift over time as user behavior and your item catalog change. Running `recotem train` on a schedule — nightly, weekly, or after each data refresh — keeps predictions fresh without manual intervention.

The train-then-serve flow is straightforward:

1. A scheduler runs `recotem train` on a recipe.
2. `recotem train` writes a new artifact (the trained model file) to disk or cloud storage.
3. `recotem serve` detects the new artifact at the next poll (default every 5 seconds) and hot-swaps the in-memory model — no server restart needed.

Clients see no downtime. The old model keeps serving until the new one is fully loaded and verified.

---

## Pattern 1 — Linux cron or systemd timer

The simplest setup: a cron job on the same host where the artifact is stored.

### cron

Add an entry to `/etc/cron.d/recotem`. Load secrets from a separate file so signing keys never appear in the crontab itself (some systems make `/etc/cron.d/` world-readable):

```bash
# /etc/recotem/secrets — mode 600, owned by the service user
RECOTEM_SIGNING_KEYS=prod-2026-q2:aabbcc...
```

```cron
# /etc/cron.d/recotem — system crontab format (includes the user field).
# Run training daily at 03:00 as the `recotem` user. Source secrets, then train.
0 3 * * * recotem . /etc/recotem/secrets && /usr/local/bin/recotem train /etc/recotem/recipes/my_recipe.yaml >> /var/log/recotem/train.log 2>&1
```

For a user crontab (`crontab -e`), omit the `recotem` username column — user crontabs run as the invoking user and use the 5-field format.

Secure the secrets file:

```bash
chmod 600 /etc/recotem/secrets
chown recotem:recotem /etc/recotem/secrets
```

### systemd timer

A systemd timer gives better logging (via journald) and handles missed runs cleanly:

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
Persistent=true   # run on next boot if the scheduled run was missed

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now recotem-train.timer
```

Check status and recent logs:

```bash
systemctl status recotem-train.timer
journalctl -u recotem-train.service -n 50
```

The `recotem serve` process can run as a companion systemd service. When `recotem train` writes a new artifact, the watcher in `recotem serve` detects it and hot-swaps the model — the serve service does not need to be restarted.

---

## Pattern 2 — Docker Compose

The tutorial's `compose.yaml` ships a `train` service (one-shot) and a `serve` service (long-running). The same pattern scales to production by running train on a cron schedule while serve stays up continuously:

```bash
# Run training on a schedule (e.g. from the host crontab or a CI trigger)
RECOTEM_SIGNING_KEYS="prod:..." \
RECOTEM_API_KEYS="client:sha256:..." \
docker compose run --rm train
```

The `train` service writes to the `artifacts` volume, and the `serve` service reads from the same volume. Because the serve container mounts it read-only, no file-locking coordination between containers is needed at the volume level.

---

## Pattern 3 — Kubernetes CronJob

For teams already running on Kubernetes, the natural approach is a `CronJob` for training and a `Deployment` for serving. Both access the artifact via a shared PersistentVolumeClaim or object storage (S3, GCS).

### CronJob (training)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: recotem-train
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid      # skip if a previous run is still active
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

Set `concurrencyPolicy: Forbid` so overlapping runs are skipped rather than running in parallel. Recotem's per-recipe file lock provides a secondary guard on a single host, but the Kubernetes policy is cheaper and more reliable across pods.

**Recommended restart behavior by exit code:**

| Exit code | Meaning | Action |
|---|---|---|
| 0 | Success (or lock skipped — see below) | Job completes normally |
| 2 | Recipe error (bad YAML, schema violation) | Do not retry — fix the ConfigMap |
| 3 | Data source error | Usually do not retry (persistent issue) |
| 4 | Training error | Retry up to `backoffLimit` |
| 5 | Artifact error (corrupt file, HMAC verification failed) | Do not retry — investigate the artifact file or the signing key used to produce it |
| 6 | Lock contested (`--fail-on-busy` set) | Retry or route elsewhere |
| 7 | HTTP fetch error (transient) | Retry |
| 8 | Configuration error (missing env vars) | Do not retry — fix the Secret |

### Handling overlapping runs

By default, when the lock is already held by another process, `recotem train` exits 0 with a log event called `recipe_lock_contended_skipping`. The Kubernetes Job sees a successful exit — which is correct behavior for cron (a slow run should not pile up duplicate jobs). If you need visibility into skipped runs, point your alerting at the structured log event rather than the exit code, or pass `--fail-on-busy` to make lock contention exit 6 instead.

**Important:** Recotem's file lock is host-local. With an `s3://` or `gs://` artifact path, it does not prevent concurrent writes from a second pod. Use `concurrencyPolicy: Forbid` (already set in the example above) to enforce single-writer semantics at the Kubernetes layer.

---

## Keeping serve up to date automatically

Once `recotem serve` is running, it polls for new artifacts every `RECOTEM_WATCH_INTERVAL` seconds (default 5, configurable up to 30). When training writes a new artifact, the watcher:

1. Detects the changed file via mtime or ETag.
2. Reads the full artifact bytes.
3. Verifies the HMAC signature against the configured signing keys.
4. If verification passes, atomically swaps the in-memory model.
5. If verification fails (wrong key, corrupt file), keeps the previous good model and records the error in the structured log and on `/v1/health/details` (per-recipe `last_load_error`).

No requests are dropped during the swap. The previous model continues to serve until the new one is ready.

You can check current model state at any time:

```bash
curl http://localhost:8080/v1/health
# {"status":"ok","total":1,"loaded":1}
```

---

## Further reading

- [Deployment: Docker](/docs/deployment/docker) — production Docker patterns
- [Deployment: Kubernetes](/docs/deployment/kubernetes) — full Helm chart reference and rolling update guidance
- [Deployment: cron / systemd](/docs/deployment/cron-systemd) — detailed cron and wrapper-script patterns
- [Operations](/docs/operations) — key rotation, memory sizing, troubleshooting
