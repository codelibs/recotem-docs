---
title: Kubernetes Deployment
description: "Deploy Recotem on Kubernetes with a CronJob for recotem train and a Deployment for recotem serve, sharing signed recommendation artifacts."
---

# Kubernetes Deployment

## Overview

Two Kubernetes objects cover the Recotem lifecycle:

- **CronJob** — runs `recotem train` on a schedule.
- **Deployment** — runs `recotem serve` continuously, reading artifacts from a shared store.

Recipes can be delivered to both objects via ConfigMap (small, static recipes), PVC (read-write volume), or object storage (S3/GCS — recipes and artifacts both live remotely).

## CronJob (train)

```yaml
# examples/k8s/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: recotem-train
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid          # skip if a previous run is still active
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: train
              image: ghcr.io/codelibs/recotem:2.0.0
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

Set `concurrencyPolicy: Forbid` so overlapping runs skip rather than corrupt the artifact. Recotem's own file lock provides a secondary guard, but the K8s policy is cheaper.

Exit code mapping for `restartPolicy: OnFailure`:

| Code | Meaning | K8s action |
|------|---------|-----------|
| 0 | Success or skip (lock contended without `--fail-on-busy`) | Job completes |
| 2 | RecipeError | No retry (config bug; fix the ConfigMap) |
| 3 | DataSourceError | No retry typically (CSV/Parquet format error, missing required column, local-FS path not found — persistent) |
| 4 | TrainingError | Retry up to `backoffLimit` |
| 5 | ArtifactError | No retry (signing key config issue; fix Secret) |
| 6 | LockContestedError (`--fail-on-busy` set) | Retry or let orchestrator route |
| 7 | HttpFetchError | Retry (transient HTTP/SSRF/timeout/sha256 mismatch/body cap on network fetch) |
| 8 | Configuration error | No retry (missing signing keys, bad env) |
| 1 | Unexpected error | Retry |

::: tip
Set `backoffLimit: 2` for production CronJobs to avoid runaway retry loops on persistent data issues — the bundled Helm CronJob template does not set `backoffLimit`, so add it via your values overlay (or on plain manifests). The bundled Helm CronJob does set `activeDeadlineSeconds: 3600` (1 h hard kill); raise it for slow Optuna budgets or data sources.
:::

`concurrencyPolicy: Forbid` stops the CronJob overlapping *itself*, and only that. It says nothing about any other process holding the same recipe's lock, and the chart's own first-install procedure creates one — the bootstrap Job in `values.yaml` is `kubectl create job bootstrap-0 --from=cronjob/<release>-train`, a second trainer on the same recipe and the same `<output.path>.lock`. An out-of-cluster cron, a manual `recotem train`, or a second cluster sharing the artifact store are the same shape.

When that happens with `failOnBusy: false` (the chart default), the losing run does **not** fail. It logs `recipe_lock_contended_skipping` at INFO, exits 0, and the Job is marked `Complete` with `succeeded: 1` — while the artifact it was scheduled to produce is not written:

```console
$ kubectl -n recotem create job scheduled-run --from=cronjob/recotem-train
$ kubectl -n recotem get job scheduled-run \
    -o custom-columns='COND:.status.conditions[*].type,SUCCEEDED:.status.succeeded'
COND                          SUCCEEDED
SuccessCriteriaMet,Complete   1
$ kubectl -n recotem logs job/scheduled-run | tail -1
{"recipe": "slow_recipe", "event": "recipe_lock_contended_skipping", "level": "info", ...}
# the artifact pointer is byte-for-byte what it was before the run
```

::: danger Alerting on Job success cannot see a model going stale
Set `failOnBusy: true` (which appends `--fail-on-busy`) so the losing run exits **6** and the Job fails, or alert on the artifact's `trained_at` rather than on Job status. Setting `concurrencyPolicy: Allow` adds the CronJob's own overlapping runs to the same silent-skip path.
:::

See [Exit Codes & Errors](../exit-codes) for the full exit code reference.

## Deployment (serve)

```yaml
# examples/k8s/serve-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: recotem-serve
  labels:
    app.kubernetes.io/name: recotem
    app.kubernetes.io/component: serve
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: recotem
      app.kubernetes.io/component: serve
  template:
    metadata:
      labels:
        app.kubernetes.io/name: recotem
        app.kubernetes.io/component: serve
    spec:
      # terminationGracePeriodSeconds >= RECOTEM_DRAIN_SECONDS + 5 (default 30+5=35).
      # The bundled Helm chart adds a 5 s preStop sleep so its default is 5+30+5=40.
      terminationGracePeriodSeconds: 35
      containers:
        - name: serve
          image: ghcr.io/codelibs/recotem:2.0.0
          command: ["recotem", "serve", "--recipes", "/recipes/"]
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: recipes
              mountPath: /recipes
              readOnly: true
            - name: artifacts
              mountPath: /artifacts
              readOnly: true
          env:
            - name: RECOTEM_HOST
              value: "0.0.0.0"
            - name: RECOTEM_PORT
              value: "8080"
            - name: RECOTEM_LOG_FORMAT
              value: "json"
            - name: RECOTEM_WATCH_INTERVAL
              value: "10"
            - name: RECOTEM_DRAIN_SECONDS
              value: "30"
            - name: RECOTEM_SIGNING_KEYS
              valueFrom:
                secretKeyRef:
                  name: recotem-auth
                  key: RECOTEM_SIGNING_KEYS
            - name: RECOTEM_API_KEYS
              valueFrom:
                secretKeyRef:
                  name: recotem-auth
                  key: RECOTEM_API_KEYS
          # Startup asks readiness' question, not /v1/health's stricter one.
          # A startupProbe is not a gate that withholds traffic -- a failing
          # one RESTARTS the container.  Pointed at the strict, count-based
          # /v1/health it turned one untrained recipe into a restart loop for
          # every NEW pod, so a rolling update or an HPA scale-out could not
          # converge while the running replicas served happily.
          # /v1/health/ready still answers 503 on a cold store (nothing
          # loaded), which is what keeps the first-install guarantee: serve
          # does not enter the Service before train has produced something.
          # Readiness and liveness must NOT use /v1/health either -- it
          # answers 503 whenever any one recipe is unloaded, so adding an
          # untrained recipe to a running fleet would pull every replica out
          # of the Service and then CrashLoop it.
          startupProbe:
            httpGet:
              path: /v1/health/ready
              port: 8080
              httpHeaders:
                - name: Host
                  value: localhost
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: /v1/health/ready
              port: 8080
              httpHeaders:
                - name: Host
                  value: localhost
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /v1/health/live
              port: 8080
              httpHeaders:
                - name: Host
                  value: localhost
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 3
      volumes:
        - name: recipes
          configMap:
            name: recotem-recipes
        - name: artifacts
          persistentVolumeClaim:
            claimName: recotem-artifacts
```

::: warning Never point `livenessProbe` or `readinessProbe` at `/v1/health`
`/v1/health` counts recipes, not loadable models: it answers **503** as soon as *any one* recipe in the directory has no artifact, even while every other recipe serves normally. Adding a new, not-yet-trained recipe to a running fleet is enough. On `readinessProbe` that removes every replica from the Service at once — they all read the same recipes directory. On `livenessProbe` the kubelet restarts the pod; the replacement reads the same directory, fails identically, and CrashLoopBackOffs, dropping the models that *were* loaded on every restart. A restart cannot conjure a missing artifact.

Use the three endpoints for the three questions:

| Probe | Endpoint | Question |
|---|---|---|
| `startupProbe` | `/v1/health/ready` | Has this new pod finished loading? (`200` once ≥ 1 recipe is loaded) |
| `readinessProbe` | `/v1/health/ready` | Can this replica serve anything? (`200` while ≥ 1 recipe is loaded) |
| `livenessProbe` | `/v1/health/live` | Is the process still answering? (never reads artifact state) |

No probe reads `/v1/health`. A failing `startupProbe` **restarts** the container rather than merely withholding traffic, so pointing one at the strict, count-based `/v1/health` turns a single untrained recipe into a restart loop for every new pod. `/v1/health` is the right endpoint for dashboards and alerting — it is the only one that tells you a recipe is missing — but not for a probe. The bundled Helm chart renders exactly this split. See [Serving API — Health](../serving-api#health-and-metrics).
:::

Note on multiple replicas: each pod holds its own in-memory copy of every model and runs its own watcher thread. This is intentional — there is no shared cache. Budget roughly **4.8x the artifact size** per recipe, not 1x: loading holds the file bytes and the payload slice of them at the same time, and the deserialized model on top. A 644.5 MiB artifact measured 3,292 MiB resident. So 10 recipes at the 512 MiB `RECOTEM_MAX_PAYLOAD_BYTES` default is on the order of 25 GiB per pod, and 10 recipes allowed to reach the 2 GiB `RECOTEM_MAX_ARTIFACT_BYTES` default is on the order of 96 GiB — before allocating replicas.

### Pod security context

The Helm chart applies a hardened security context by default:

```yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
securityContext:                 # container-level
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
```

`readOnlyRootFilesystem: true` requires every writable path to be a tmpfs or volume mount; the chart mounts an `emptyDir` at `/tmp`. Add similar mounts if a plugin or fsspec backend writes elsewhere (e.g. GCS FUSE cache).

### Rolling updates and warm-up

Each new pod re-fetches and HMAC-verifies every artifact at startup before the `startupProbe` clears (`periodSeconds: 5`, `failureThreshold: 60` — a 5-minute budget) and the readinessProbe passes. With many recipes or large artifacts, raise the `startupProbe` `failureThreshold` and the readiness `initialDelaySeconds` and tune `maxSurge` / `maxUnavailable` so the rollout does not run below the desired-replica count. The watcher polls on a shared interval inside each pod — when `train` writes a new artifact, all replicas pick it up within `RECOTEM_WATCH_INTERVAL` seconds; no rollout is needed for hot-swap.

### Secret rotation

Changing data in the `recotem-auth` Secret does **not** trigger a pod rollout — the env vars are evaluated once at process start. After rotating either key, run:

```bash
kubectl rollout restart deployment/recotem-serve -n recotem
```

Use the multi-kid pattern from the [Operations Runbook](../operations) to keep both old and new keys active during the rollout window.

## Service

```yaml
# examples/k8s/serve-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: recotem-serve
spec:
  selector:
    app.kubernetes.io/name: recotem
    app.kubernetes.io/component: serve
  ports:
    - name: http
      port: 8080
      targetPort: 8080
  type: ClusterIP
```

Expose externally via an Ingress or a LoadBalancer. Do not expose the pod port directly without a TLS-terminating proxy in front.

::: warning RECOTEM_ALLOWED_HOSTS and Ingress
`TrustedHostMiddleware` defaults to `127.0.0.1,localhost` when `RECOTEM_ALLOWED_HOSTS` is empty — that is just enough for the in-pod liveness/readiness probes (which use a `Host: localhost` header). Any request reaching the pod under a different hostname — typically the Ingress host — will return **400 Bad Request**.

The bundled Helm chart (`helm/recotem/templates/deployment.yaml`) renders `RECOTEM_ALLOWED_HOSTS` as the **union** of `localhost`, your own `env.RECOTEM_ALLOWED_HOSTS` (if set), and `ingress.hosts[*].host` (when `ingress.enabled=true`). An explicit override no longer replaces the Ingress hosts, so you do not have to restate them:

```console
$ helm template recotem ./helm/recotem --set ingress.enabled=true \
    --set 'ingress.hosts[0].host=api.example.com' \
    --set 'env.RECOTEM_ALLOWED_HOSTS=recotem.internal.svc.cluster.local'
            - name: RECOTEM_ALLOWED_HOSTS
              value: "localhost,recotem.internal.svc.cluster.local,api.example.com"
```

Because it is a union, setting this variable does **not** narrow the list to what you named — it can only add. To actually restrict which Host headers are accepted, remove hosts from `ingress.hosts` as well.

**If you write the env var yourself, outside the chart, `localhost` is yours to include.** The three probes send `Host: localhost`, so a list without it makes every readiness and liveness check return 400 and the Deployment never becomes ready. It CrashLoops with no clue in the application log, because a 400 from `TrustedHostMiddleware` looks like an ordinary rejected request:

```yaml
- name: RECOTEM_ALLOWED_HOSTS
  value: "localhost,api.example.com,api-internal.svc.cluster.local"
```
:::

## Recipe delivery patterns

### ConfigMap (static recipes)

Best for recipes that change infrequently. Update the ConfigMap and roll the Deployment.

```bash
kubectl create configmap recotem-recipes \
  --from-file=./recipes/my_recipe.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

After updating the ConfigMap, restart the Deployment to pick up new recipe files:

```bash
kubectl rollout restart deployment/recotem-serve
```

### PVC

Mount a `ReadWriteMany` PVC (e.g. NFS, EFS, GCS FUSE) to both the CronJob and the Deployment. New recipe files are picked up by the watcher at the next poll interval — no restart needed.

If the PVC does not support `ReadWriteMany`, use `ReadWriteOnce` for the Deployment and accept that you cannot mount it to the CronJob simultaneously. In that case, write artifacts to object storage instead (see below).

#### A network-filesystem outage stalls `train`, and says nothing

Serve and train do not degrade the same way when the file server behind an RWX PVC stops answering. Measured on a live 3-node cluster with an NFS-backed RWX PVC, by scaling the NFS server to zero replicas mid-run:

| | What happens | What the operator sees |
|---|---|---|
| `serve`, already running | keeps answering `:recommend` (10/10 `200`), stays `1/1` Ready, 0 restarts, 2–3 millicores | `artifact_stat_timeout` (WARN, per recipe, one scan every ~20 s) for as long as the mount merely hangs; if its file handles do not survive the outage, `artifact_stat_failed` naming `OSError [Errno 116] Stale file handle` as well. A 403 s outage never got past the timeout stage |
| `serve`, new pod | never starts | `FailedMount ... exit status 32` on the pod; the rollout stalls |
| `train`, mid-run | **blocks in the artifact write for as long as the outage lasts** — measured 23 min 19 s at 1 millicore, and 6 min 52 s in a second run — then completes when storage returns | nothing at all while blocked: the last log line is `final_model_trained`, no error, no progress |

The asymmetry is deliberate on one side only. The watcher stats artifacts on a worker thread under a wall-clock timeout and reports the ones that hang, so a wedged mount costs the scan loop a timeout rather than the process. The artifact write is a plain `makedirs` → `mkstemp` → `write` → `fsync` → `os.replace`; on a hard NFS mount whose server is gone, every one of those blocks in the kernel, uninterruptibly, for as long as the server stays away.

**What the run does when storage comes back depends on the mount, and used to decide the run.** If the file server returns with the same export identity, the client's handle survives and the blocked write simply finishes. If it does not — the server was rebuilt, or failed over, so the export's `fsid` changed — the node's mount answers the next metadata call with `ESTALE`. That used to end the run:

```console
Training failed: [Errno 17] File exists: '/artifacts'
RECOTEM_EXIT=1
```

`os.makedirs(dir, exist_ok=True)` suppresses the `FileExistsError` from its `mkdir` only when the *single* `os.path.isdir()` call that follows returns True, and `os.path.isdir` reports False for any `OSError`. One stale `stat` was therefore enough to discard a completed training run — and because the artifact write is the first metadata access after minutes of pure-CPU tuning, that call is exactly where a handle idled through the search goes stale. With the chart's `restartPolicy: OnFailure` the Job retried, and each retry paid a full data fetch, Optuna search and final refit before dying on the same line: five consecutive runs discarded.

Since 2.1.0 Recotem re-checks that path once before giving up, so a stale `stat` costs one syscall rather than a training run. A destination that is genuinely not a directory still fails, because the re-check fails too. What remains is the stall: nothing in the process bounds it, and a write that returns a real I/O error still surfaces as **exit 1** (`internal_error`) with a traceback through the artifact writer and nothing naming the file server.

::: warning Do not build the alert on the Job's outcome
The same injection that used to end at `exit 1` now ends at `exit 0`, `artifact_written`, and a Job marked `SuccessCriteriaMet,Complete` — after 397 s in which the run produced no log line at all and the file server was absent for five minutes of it. A completed Job is therefore not evidence that no outage occurred, and a failed one names a directory rather than the file server.

What is common to every ending is the **stall**: `train` runs for minutes to tens of minutes producing nothing after `final_model_trained`, at ~1 millicore, holding the recipe lock. Alert on training-run duration, or on the artifact's `trained_at` age.
:::

Consequences on the shipped chart:

- Nothing inside the process ends the stall. The chart's `activeDeadlineSeconds: 3600` on the train Job is the only bound, so an outage longer than that costs the run its whole slot.
- It is then killed as `DeadlineExceeded` — `Job was active longer than specified deadline` — which names the deadline, not the storage. Nothing in the Job's status or events mentions the file server.
- With `concurrencyPolicy: Forbid` (the chart default) that one stalled run suppresses every scheduled run behind it for the same window, each skipped with `JobAlreadyActive`.
- The per-recipe lock is held for the whole stall, on a file the process can no longer reach.

If your artifact store is a network filesystem, either mount it `soft` with a bounded `timeo`/`retrans` so the write fails instead of parking (accepting that a soft mount can surface a short write as an error), lower `activeDeadlineSeconds` to something you are willing to wait, or put artifacts in object storage (next section), where a stalled request fails on the HTTP timeout instead of in the kernel.

### Object storage (S3 / GCS)

Set `output.path` in the recipe to an `s3://` or `gs://` URI. The CronJob and Deployment need no shared volume; they access the artifact directly via fsspec.

```yaml
output:
  path: s3://my-bucket/artifacts/my_recipe.recotem
  versioning: append_sha
```

The Deployment needs IAM access to read from the bucket. Use IRSA (EKS) or Workload Identity (GKE):

```yaml
serviceAccountName: recotem-serve-sa   # annotated with IAM role ARN / GCP SA
```

Recipes themselves can also live in object storage; mount them via an init container or reference them by URL in a wrapper script.

::: warning Per-recipe lock is host-local
Recotem's `<output.path>.lock` uses POSIX `flock` and only coordinates writers on the same host. With an `s3://` or `gs://` `output.path` the lock file is created at a stable host-local path under `$RECOTEM_LOCK_DIR` (or `<tempdir>/recotem-locks/<sha256-of-output-path>.lock`) and does not prevent concurrent writes from a second pod. Rely on the scheduler for single-writer guarantees:

- The bundled CronJob sets `concurrencyPolicy: Forbid` (default in `values.yaml`); keep it.
- When triggering training from outside Kubernetes (Argo Workflows, Airflow, custom controllers), enforce parallelism = 1 there (Argo `synchronization.mutex`, Airflow `max_active_runs=1`, etc.).
- `recotem train --fail-on-busy` only helps for same-host contention; do not depend on it for cross-pod safety with object storage outputs.

Recotem logs `recipe_lock_local_only` at WARNING on the first occurrence per lock path; subsequent occurrences for the same path are logged at DEBUG.
:::

## Helm chart values

The Helm chart in `helm/recotem/` provides a `serve` Deployment, optional `CronJob` template, `NetworkPolicy`, `PodDisruptionBudget`, `ServiceAccount`, and optional `HorizontalPodAutoscaler`.

Key values (excerpt from `helm/recotem/values.yaml`):

```yaml
image:
  repository: ghcr.io/codelibs/recotem
  tag: "2.0.0"
  pullPolicy: IfNotPresent

# serve Deployment
replicaCount: 2

resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 4Gi

# train CronJob (disabled by default — set enabled: true to schedule it)
train:
  enabled: false
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  failOnBusy: false

# Reference an existing Kubernetes Secret containing both
#   RECOTEM_SIGNING_KEYS and RECOTEM_API_KEYS as data keys.
secrets:
  secretName: recotem-auth

recipes:
  mountPath: /recipes
  source: configMap   # configMap | pvc | objectStore
  configMap:
    name: recotem-recipes
    managed: false    # set true to let the chart manage the ConfigMap from .data
    data: {}
  pvc:
    claimName: recotem-recipes
    readOnly: true
  objectStore:
    initContainer: {} # provide a sync init container spec

networkPolicy:
  enabled: true
  # ingressFromPodSelector restricts which pods may reach recotem-serve.
  # It is NOT a deny-all switch on its own.  allowKubeletProbes defaults to
  # true, which renders an ingress rule with no `from:` — and in the
  # NetworkPolicy spec that matches EVERY source, the opposite of deny-all.
  # With chart defaults, inbound to the serve port is open to all sources.
  # Set a label selector to allow specific scrapers or ingress controllers:
  #   ingressFromPodSelector:
  #     app.kubernetes.io/name: ingress-nginx
  ingressFromPodSelector: {}
  # Kubelet probes originate from the node network, not from a pod, so no
  # podSelector can match them.  Leave this true: setting it false with an
  # empty ingressFromPodSelector renders a real `ingress: []` deny-all, and
  # on a cluster whose CNI enforces NetworkPolicy that is a total, silent
  # outage — every replica stays 1/1 Ready with restartCount 0 and stays in
  # the Service endpoints while 100% of client requests time out.
  allowKubeletProbes: true
  # The way to narrow inbound without that outage: restrict probe ingress to
  # the node CIDRs instead of any source.  Read only while
  # allowKubeletProbes is true.
  kubeletCIDRs: []

hpa:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

Create the auth Secret before installing the chart:

```bash
kubectl create secret generic recotem-auth \
  --from-literal=RECOTEM_SIGNING_KEYS='prod-2026-q2:<hex64>' \
  --from-literal=RECOTEM_API_KEYS='client-a:sha256:<hex64>'
```

Render and inspect before applying:

```bash
helm template recotem ./helm/recotem -f values-prod.yaml | less
helm upgrade --install recotem ./helm/recotem -f values-prod.yaml -n recotem
```
