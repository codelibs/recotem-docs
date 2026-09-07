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

## First install: seed an artifact before serve starts

**Read this before your first `helm install` or `kubectl apply`.** Train and serve are ordered: serve cannot become healthy until train has produced at least one artifact, and **nothing in the chart or the example manifests runs train for you at install time**.

`recotem serve` loads one artifact per recipe at startup. Until at least one recipe has one, `/v1/health/ready` answers **503** with `{"status":"unready","total":1,"loaded":0}`. On an empty artifact store that means:

```
Warning  Unhealthy  kubelet  Startup probe failed: HTTP probe failed with statuscode: 503
```

repeatedly, until the startup probe's `failureThreshold` is reached and the container is restarted — a crash loop that looks like a bug but is only a missing artifact. `helm install --wait` fails with a rollout timeout, and the CronJob's default `schedule: "0 2 * * *"` means nothing produces the artifact for up to a day.

**Always train before serving.** Pick whichever fits your setup.

**A. Helm — install with training enabled, seed, then verify.** Install *without* `--wait` (the serve pods will not be Ready yet), kick off the CronJob immediately as a one-off Job, then wait:

```bash
helm upgrade --install recotem ./helm/recotem -n recotem \
  -f values-prod.yaml --set train.enabled=true      # no --wait

kubectl -n recotem create job bootstrap-0 --from=cronjob/recotem-train
kubectl -n recotem wait --for=condition=complete job/bootstrap-0 --timeout=30m

kubectl -n recotem rollout status deployment/recotem --timeout=10m
```

**B. Raw manifests — apply the bundled bootstrap Job.** `examples/k8s/bootstrap-job.yaml` is a one-shot `recotem train` Job with the same container spec as the CronJob; `kubectl apply -f examples/k8s/` creates it alongside the Deployment.

**C. Train out-of-cluster.** Run `recotem train` anywhere that can write the recipe's `output.path` (an `s3://` / `gs://` URI, or the PVC mounted on a workstation) before creating the Deployment at all. The signing keys must match the ones serve is configured with.

In every case the serve pods recover on their own once an artifact appears — the watcher picks it up within `RECOTEM_WATCH_INTERVAL` seconds and the next probe succeeds. No rollout restart is needed.

::: tip Why the chart has no post-install hook
Training is an unbounded operation — the CronJob allows it an hour (`activeDeadlineSeconds: 3600`). Wiring it into `helm install` would make every first install block on it and fail against Helm's `--timeout` (5 minutes by default), trading a legible "no artifact yet" crash loop for an opaque failed release. Seeding is kept as an explicit step for that reason.
:::

### Adding a recipe later is not a first install

All three probes read the same "at least one recipe loaded" state, so a valid recipe whose artifact has not been trained yet leaves the running fleet in the Service **and** lets new pods start. Only that one recipe's verbs answer `503 RECIPE_UNAVAILABLE`, until the next train run; every other recipe keeps serving.

::: danger Point a probe at `/v1/health` and you get the opposite
`/v1/health` is the strict "is *every* recipe present?" endpoint. A startup probe reading it **restarts the container**, so one untrained recipe stops every new pod — and a rolling update or an HPA scale-out never converges, while the already-running replicas serve happily. Use `/v1/health` for alerting, not for probes.
:::

### `recipes_directory_empty` is a different failure that looks identical

If the recipes directory holds no `*.yaml` file — a ConfigMap whose keys are not `*.yaml`, an `objectStore` init container that exited 0 having copied nothing, an empty PVC — `serve` has nothing to register. `/v1/health/ready` answers **503** with `{"status":"unready","total":0,"loaded":0}` for that, exactly as it does for an untrained artifact store.

**The log line is the only discriminator:**

| `recipes_directory_empty` warning at startup | Meaning | Fix |
|---|---|---|
| present (names the directory) | the **delivery** is wrong | fix the ConfigMap / sync / PVC |
| absent | the artifact store is simply **cold** | run train |

Check the mount before re-running train:

```bash
kubectl -n recotem exec deploy/recotem -- ls -la /recipes
```

### Recovering an install that is already crash-looping

The same fix — the pods need no intervention beyond producing the artifact:

```bash
kubectl -n recotem create job recover-0 --from=cronjob/recotem-train
kubectl -n recotem logs -f job/recover-0
```

If `train.enabled=false` (the chart default) there is no CronJob to copy from; either enable it, or apply `examples/k8s/bootstrap-job.yaml` with the image, Secret and volume names adjusted to your release.

## Verify the install with one request

Nothing above proves the API answers. Two of this page's warnings only show up here, so make the request before you call the install done.

```bash
NS=recotem
POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=recotem \
        -o jsonpath='{.items[0].metadata.name}')

# 1. probes, from inside the pod (Host: localhost always passes)
kubectl -n "$NS" exec "$POD" -- \
  python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/v1/health/ready').read())"

# 2. a real recommendation, through the Service
kubectl -n "$NS" port-forward svc/recotem 8080:8080 &
PF=$!
RECIPE=news_articles          # your recipe's `name:`, case-sensitive
curl -sS -X POST \
  -H 'Host: localhost' \
  -H "X-API-Key: <the plaintext key, not the sha256 hash>" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u1","limit":3}' \
  "http://127.0.0.1:8080/v1/recipes/${RECIPE}:recommend"
kill "$PF"
```

Two traps this catches:

- **`-H 'Host: localhost'` is not optional.** Without it the request carries `Host: 127.0.0.1:8080` (or the Service DNS name) and `TrustedHostMiddleware` answers **400** unless `RECOTEM_ALLOWED_HOSTS` lists that name. With chart defaults and no Ingress, an in-cluster request to `http://recotem:8080/v1/health` returns 400 — the chart only widens the list when `ingress.enabled=true`. See the `RECOTEM_ALLOWED_HOSTS` warning under [Service](#service).
- **`${RECIPE}` must be brace-quoted.** In zsh, `$RECIPE:recommend` is the `:r` history modifier, not a variable followed by a literal colon — the URL silently becomes `/v1/recipes/RECIPEecommend` and the POST lands on the GET route as a **405**, which reads exactly like a missing endpoint.

How to read the result:

| Response | Meaning |
|---|---|
| `200` with an `items` array | train, signing keys, the artifact store, the probes and the host allow-list are all wired correctly |
| `401` | the API key is wrong — the Secret holds `<kid>:sha256:<hex>`; clients send the **plaintext** |
| `503 RECIPE_UNAVAILABLE` | that one recipe has no artifact yet |

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
| 5 | ArtifactError | No retry (artifact corrupt or unverifiable — HMAC mismatch, unknown kid, truncated payload; retrain). A malformed `RECOTEM_SIGNING_KEYS` entry exits 8, not 5. |
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

Note on multiple replicas: each pod holds its own in-memory copy of every model and runs its own watcher thread. This is intentional — there is no shared cache. Budget roughly **4.8x the artifact size** per recipe, not 1x: loading holds the file bytes and the payload slice of them at the same time, and the deserialized model on top. A 644.5 MiB artifact measured 3,292 MiB resident. So 10 recipes at the 512 MiB `RECOTEM_MAX_PAYLOAD_BYTES` default is on the order of 24 GiB per pod, and 10 recipes allowed to reach the 2 GiB `RECOTEM_MAX_ARTIFACT_BYTES` default is on the order of 96 GiB — before allocating replicas. See [Operations — Sizing recotem serve memory](../operations#sizing-recotem-serve-memory).

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

::: warning On a network filesystem the attribute cache adds to the hot-swap time
`RECOTEM_WATCH_INTERVAL` is not the whole latency when artifacts live on an NFS-backed `ReadWriteMany` PVC: the client's attribute cache has to expire before the watcher's `stat` can see the new mtime. Measured at a 10 s interval — **25.5 s** on a default-mounted volume, **8.2 s** on the same volume mounted `noac`. Budget the sum, or mount `noac` and accept the extra metadata round-trips.

**Cross-replica agreement during a swap is not guaranteed.** Replicas swap independently, so one `user_id` can get two different models until the last replica has swapped — measured **21.8 s** of divergence with 3 replicas on the same PVC. `model_version` in the response (and the `X-Recotem-Model-Version` header) identifies which model answered, so a client that needs a consistent view within a session can pin on it.
:::

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
| `train`, mid-run | **blocks in the artifact write for as long as the outage lasts** — measured 23 min 19 s at 1 millicore, and 6 min 52 s in a second run — and then either finishes or is discarded, depending on whether the mount's file handles are still valid | nothing at all while blocked: the last log line is `final_model_trained`, no error, no progress. On recovery, `exit 0` when the export identity survived and `exit 1` when it did not |

The asymmetry is deliberate on one side only. The watcher stats artifacts on a worker thread under a wall-clock timeout and reports the ones that hang, so a wedged mount costs the scan loop a timeout rather than the process. The artifact write is a plain `makedirs` → `mkstemp` → `write` → `fsync` → `os.replace`; on a hard NFS mount whose server is gone, every one of those blocks in the kernel, uninterruptibly, for as long as the server stays away.

**What the run does when storage comes back depends on the mount, and it can decide the run.** If the file server returns with the same export identity, the client's handle survives and the blocked write simply finishes. If it does not — the server was rebuilt, or failed over, so the export's `fsid` changed — the node's mount answers the next metadata call with `ESTALE`, and that ends the run:

```console
Training failed: [Errno 17] File exists: '/artifacts'
RECOTEM_EXIT=1
```

`os.makedirs(dir, exist_ok=True)` suppresses the `FileExistsError` from its `mkdir` only when the *single* `os.path.isdir()` call that follows returns True, and `os.path.isdir` reports False for any `OSError`. One stale `stat` is therefore enough to discard a completed training run — and because the artifact write is the first metadata access after minutes of pure-CPU tuning, that call is exactly where a handle idled through the search goes stale. With the chart's `restartPolicy: OnFailure` the Job retried, and each retry paid a full data fetch, Optuna search and final refit before dying on the same line: five consecutive runs discarded.

Since 2.1.0 Recotem re-checks that path once before giving up, and a destination that is genuinely not a directory still fails because the re-check fails too. **The re-check only rescues a momentary stale answer, and an export whose identity changed does not give one.** Measured with the file server taken away mid-search and returned as a new pod with a different export `fsid`:

| `output.path`'s directory | what `os.makedirs(dir, exist_ok=True)` raises | what the re-check answers |
|---|---|---|
| the mount point itself (`/artifacts`, the chart's `artifacts.mountPath`) | `FileExistsError` — `mkdir` gets `EEXIST` from the directory entry underneath the mount, without reaching the server | `os.path.isdir('/artifacts')` → `False`, and stays False |
| a directory below the mount (`/artifacts/models`) | `OSError [Errno 116] Stale file handle` — the `mkdir` itself crosses into the export | never consulted: only `FileExistsError` is caught |

Probed every 3 s for the life of one pod, `os.path.isdir` on the mount point answered `False` on all 80 calls after the export changed identity and never once answered `True`. The re-check needs two `os.path.isdir` calls **microseconds apart** to disagree, and `os.makedirs(..., exist_ok=True)` already made the first one: hammering that sequence at ~45 calls/second across a real momentary stale window produced **1,130 consecutive re-raises and not one rescue**. Two training Jobs under one injection, one image with the re-check and one with the plain `os.makedirs`, therefore end identically:

```console
Training failed: [Errno 116] Stale file handle: '/artifacts/<recipe>.recotem'
RECOTEM_EXIT=1
```

A run that survives an outage says nothing about the re-check either: when the export identity survives, the write finishes and the run reaches `exit 0` **without** it. What remains in every case is the stall: nothing in the process bounds it, and a write that returns a real I/O error surfaces as **exit 1** (`internal_error`) with a traceback through the artifact writer and nothing naming the file server.

Recovery on the stale path is **pod-level, not container-level**: delete the pod (or the Job) so the volume is mounted afresh. A `kubectl rollout restart` or a plain retry inside the same pod cannot clear it.

::: warning Do not build the alert on the Job's outcome
No single ending is characteristic. When the export identity survives the outage the write finishes, the run exits 0 and the Job is marked `SuccessCriteriaMet,Complete` — after 397 s in which it produced no log line at all and the file server was absent for five minutes of it. A completed Job is therefore not evidence that no outage occurred, and not evidence of which code path ran. When the identity does not survive, the run exits 1 — and the Job does not necessarily fail either: with the chart's `restartPolicy: OnFailure` the container is restarted **into the same pod**, and therefore onto the same stale mount. Measured, the kubelet could not create the container a second time at all (`CreateContainerError: ... failed to stat ...: stale file handle`), so `restartCount` stayed `0`, the `backoffLimit` was never consumed, and `kubectl get job` reported `Running 0/1` with `active: 1` indefinitely: no `Complete`, no `Failed`, no event naming the file server.

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

### PodDisruptionBudget covers serve only

The serve pods carry `app.kubernetes.io/component: serve`, and the PDB selects on it. That matters because a PDB's allowed-disruption count is `currentHealthy − minAvailable` computed over **the pods its selector matches** — so an unscoped selector would let a train CronJob pod count as healthy:

| Serve replicas | Training running? | `currentHealthy` | `minAvailable: 1` allows |
|---|---|---|---|
| 1 | no | 1 | 0 disruptions — serve is protected |
| 1 | yes | 2 | 1 disruption — **a drain may evict the only serve pod** |

The protection would otherwise lapse exactly while a training job happened to be running, which is schedule-dependent and easy to miss.

The Service selector is deliberately **not** scoped the same way. Train pods stay out of its Endpoints because `targetPort` is the *name* `http`, which the train container does not declare; narrowing the selector instead would empty the Endpoints for the length of the rollout that adds the matching pod label. If you add a port named `http` to the train container, revisit this.

### NetworkPolicy: the defaults are not deny-all inbound

::: danger With chart defaults, inbound to port 8080 is open to every source
`ingressFromPodSelector: {}` on its own would render no ingress rule, but the default `allowKubeletProbes: true` renders a rule with **no `from:` field** — and in the Kubernetes NetworkPolicy API an ingress rule with no `from:` matches **all** sources, the opposite of deny-all. The canonical deny-all-inbound form is `ingress: []` with `policyTypes` including `Ingress`.
:::

Verify what you actually got — and **ask for `policyTypes` as well as `ingress`, not `ingress` alone**:

```console
$ kubectl get networkpolicy recotem -o jsonpath='{.spec.policyTypes} {.spec.ingress}'
["Ingress","Egress"] [{"ports":[{"port":8080,"protocol":"TCP"}]}]
```

The API server drops an empty `ingress` list on write, so a working deny-all has no `ingress` key in the stored object at all. A bare `{.spec.ingress}` therefore prints nothing for a deny-all *and* nothing when the policy does not exist (that failure goes to stderr). The two-field form separates all three states without reading stderr:

| Policy | `{.spec.ingress}` | `{.spec.policyTypes} {.spec.ingress}` |
|---|---|---|
| not present | *(empty)* | *(empty)* |
| deny-all | *(empty)* | `["Ingress","Egress"] ` |
| chart default | `[{"ports":[{"port":8080,"protocol":"TCP"}]}]` | `["Ingress","Egress"] [{"ports":[{"port":8080,"protocol":"TCP"}]}]` |

`allowKubeletProbes` defaults to `true` for a reason: kubelet health checks originate from the **node** network rather than from a pod, so no `podSelector` rule can match them.

::: danger Setting `allowKubeletProbes: false` is worse than a failed rollout
With `ingressFromPodSelector` also empty the chart renders `ingress: []`, a true deny-all-inbound. Measured on a live 3-node cluster whose CNI enforces NetworkPolicy, three minutes after applying it:

| | Observed |
|---|---|
| pods | `1/1 Ready`, `restartCount 0` |
| Service endpoints | `ready=true` for every replica |
| in-cluster client → Service | connection timeout |
| external client → Ingress → Service | connection timeout |

Many CNIs exempt node-originating traffic from pod NetworkPolicies, so the probes keep passing. Kubernetes therefore reports a perfectly healthy fleet while **100% of client traffic is blackholed** — with no pod restart, no endpoint change and no event pointing at the cause. Whether probes survive is CNI-specific; the loss of client traffic is not.
:::

To narrow inbound while keeping probes working, **do not** set `allowKubeletProbes: false` — list your node CIDRs instead, which converts the probe rule from "any source" to an `ipBlock` match:

```yaml
networkPolicy:
  enabled: true
  ingressFromPodSelector:
    app.kubernetes.io/name: ingress-nginx   # who may call the API
  allowKubeletProbes: true
  kubeletCIDRs:                             # where probes may come from
    - "10.0.0.0/8"
```

Only set `allowKubeletProbes: false` when a separate NetworkPolicy already admits **both** node-originating probe traffic and your clients — `ingress: []` denies everything, and additive policies are the only way back. `kubeletCIDRs` does not help there: the template reads it only while `allowKubeletProbes` is `true`. Verify with a request, not with `kubectl get pods`; the pods look healthy either way.

### NetworkPolicy: egress also gates the train CronJob

::: warning The policy selects the train pods too, and its egress rules do not cover SQL or plain HTTP
`podSelector` matches on `app.kubernetes.io/name` + `app.kubernetes.io/instance`, which the train CronJob's pods carry as well as the serve pods. The built-in egress rules are serve-shaped — DNS plus HTTPS for object storage — so with chart defaults a training run whose recipe uses `source.type: sql`, or a plain-`http://` `source.path`, is dropped by this policy. **There is no NetworkPolicy-shaped error**: the job just times out connecting, which sends you looking at the database instead of at the policy.
:::

Ports the built-in rules do **not** open, and that you must add for the matching data source:

| Port | Protocol | Needed by |
|---|---|---|
| 5432 | TCP | `source.type: sql` against PostgreSQL |
| 3306 | TCP | `source.type: sql` against MySQL / MariaDB |
| 1433 | TCP | `source.type: sql` against SQL Server |
| 80 | TCP | `source.path` on plain `http://` |

BigQuery, object-store paths (`s3://`, `gs://`, `az://`) and `https://` URLs already work: they go over 443.

Use `networkPolicy.extraEgress` to append rules; entries are the Kubernetes `NetworkPolicyEgressRule` schema and are emitted verbatim:

```yaml
networkPolicy:
  enabled: true
  extraEgress:
    - to:
        - ipBlock:
            cidr: "10.0.0.0/8"     # the subnet your database lives on
      ports:
        - port: 5432
          protocol: TCP
```

Because serve and train share the one policy, **anything opened here is reachable from the serve pods as well** — scope each rule with `to:` when that matters. Confirm what you got with `kubectl get networkpolicy recotem -o jsonpath='{.spec.egress}'`.

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
