---
title: Kubernetes デプロイメント
description: "Recotem の Kubernetes デプロイガイド。学習用 CronJob と配信用 Deployment、レシピ配布、Helm チャート、Pod セキュリティ、鍵ローテーションを解説します。"
---

# Kubernetes デプロイメント

## 概要

Recotem のライフサイクルは 2 つの Kubernetes オブジェクトでカバーされます。

- **CronJob** — スケジュールに従って `recotem train` を実行する。
- **Deployment** — `recotem serve` を継続的に実行し、共有ストアからアーティファクトを読み取る。

レシピは ConfigMap (小規模・静的なレシピ)、PVC (読み書きボリューム)、またはオブジェクトストレージ (S3/GCS — レシピとアーティファクトの両方をリモートに格納) を通じて両オブジェクトに配布できます。

## CronJob (train)

```yaml
# examples/k8s/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: recotem-train
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid          # 前回の実行がまだ進行中の場合はスキップ
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

重複する実行がアーティファクトを破損させないよう `concurrencyPolicy: Forbid` を設定してください。Recotem 独自のファイルロックも二次的なガードを提供しますが、K8s のポリシーの方が軽量です。

`restartPolicy: OnFailure` に対する終了コードのマッピング:

| コード | 意味 | K8s の動作 |
|------|---------|-----------|
| 0 | 成功またはスキップ (`--fail-on-busy` なしでロック競合) | ジョブ完了 |
| 2 | RecipeError | リトライなし (設定バグ; ConfigMap を修正すること) |
| 3 | DataSourceError | 通常リトライなし (CSV/Parquet フォーマットエラー、必須列の欠落、ローカル FS パスが見つからない — 永続的) |
| 4 | TrainingError | `backoffLimit` までリトライ |
| 5 | ArtifactError | リトライなし (署名鍵の設定問題; Secret を修正すること) |
| 6 | LockContestedError (`--fail-on-busy` 設定時) | リトライまたはオーケストレーターに委任 |
| 7 | HttpFetchError | リトライ (ネットワークフェッチにおける一時的な HTTP/SSRF/タイムアウト/sha256 不一致/バイト上限超過) |
| 8 | 設定エラー | リトライなし (署名鍵の欠落、不正な環境変数) |
| 1 | 予期しないエラー | リトライ |

::: tip ヒント
永続的なデータ問題でのリトライループを防ぐため、本番 CronJob では `backoffLimit: 2` を設定してください — バンドルされた Helm CronJob テンプレートは `backoffLimit` を設定しないため、values オーバーレイ (またはプレーンマニフェスト) で追加してください。バンドルされた Helm CronJob は `activeDeadlineSeconds: 3600` (1 時間ハードキル) を設定しています; Optuna の探索予算やデータソースが遅い場合は値を上げてください。
:::

`failOnBusy: false` (チャートのデフォルト) の場合、`concurrencyPolicy: Forbid` からのロック競合は K8s レイヤーでは発生しませんが、`concurrencyPolicy: Allow` に設定すると、2 回目の呼び出しでプロセス内ファイルロックが終了コード 0 で終了します。CronJob は成功としてマークされます — 重複した実行をアラートで検知したい場合は `failOnBusy: true` (これにより `--fail-on-busy` が追加される) を設定してください。

完全な終了コードリファレンスについては [終了コードとエラー](../exit-codes) を参照してください。

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
      # terminationGracePeriodSeconds >= RECOTEM_DRAIN_SECONDS + 5 (デフォルト 30+5=35)。
      # バンドルされた Helm チャートは 5 秒の preStop スリープを追加するため、デフォルトは 5+30+5=40。
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
          readinessProbe:
            httpGet:
              path: /v1/health
              port: 8080
              httpHeaders:
                - name: Host
                  value: localhost
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          # /v1/health への httpGet にはしないこと: このエンドポイントは
          # レシピが 1 つでも未ロードなら 503 を返すため、未学習のレシピが
          # 1 つあるだけで全 Pod が再起動ループに入り、再起動では直らない。
          # TCP プローブは「プロセスがまだ listen しているか」だけを問う。
          # これが liveness の意味である。(Host ヘッダを送らないため
          # TrustedHostMiddleware も関与しない。)
          livenessProbe:
            tcpSocket:
              port: 8080
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

複数レプリカについての注意: 各 Pod はすべてのモデルの独自のインメモリコピーを保持し、独自のウォッチャースレッドを実行します。これは意図的な設計であり、共有キャッシュはありません。レシピあたりアーティファクトサイズの 1 倍ではなく、おおよそ **4.8 倍** を見積もってください: ロード時にはファイルのバイト列とそのペイロード部分が同時に保持され、さらにデシリアライズ済みのモデルが上乗せされます。644.5 MiB のアーティファクトで実測 3,292 MiB が常駐しました。したがって `RECOTEM_MAX_PAYLOAD_BYTES` のデフォルト 512 MiB で 10 レシピなら Pod あたり 25 GiB 程度、`RECOTEM_MAX_ARTIFACT_BYTES` のデフォルト 2 GiB まで許すなら 96 GiB 程度になります — レプリカを割り当てる前の値です。

### Pod セキュリティコンテキスト

Helm チャートはデフォルトで強化されたセキュリティコンテキストを適用します。

```yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
securityContext:                 # コンテナレベル
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
```

`readOnlyRootFilesystem: true` はすべての書き込み可能パスが tmpfs またはボリュームマウントである必要があります。チャートは `/tmp` に `emptyDir` をマウントします。プラグインや fsspec バックエンドが他の場所 (例: GCS FUSE キャッシュ) に書き込む場合は同様のマウントを追加してください。

### ローリングアップデートとウォームアップ

各新しい Pod は、readinessProbe が通過する前 (デフォルト `initialDelaySeconds: 10`) に、起動時にすべてのアーティファクトを再フェッチして HMAC 検証します。レシピ数が多い場合や大きなアーティファクトがある場合は、`initialDelaySeconds` を増やし、ロールアウトが希望のレプリカ数を下回らないように `maxSurge` / `maxUnavailable` を調整してください。ウォッチャーは各 Pod 内で共有インターバルでポーリングします — `train` が新しいアーティファクトを書き込むと、すべてのレプリカは `RECOTEM_WATCH_INTERVAL` 秒以内にそれを検知します。ホットスワップにロールアウトは不要です。

### Secret のローテーション

`recotem-auth` Secret のデータを変更しても Pod のロールアウトは**トリガーされません** — 環境変数はプロセス開始時に一度だけ評価されます。どちらかの鍵をローテーションした後は以下を実行してください。

```bash
kubectl rollout restart deployment/recotem-serve -n recotem
```

ロールアウトウィンドウ中に新旧両方の鍵をアクティブに保つには、[オペレーションランブック](../operations) のマルチ kid パターンを使用してください。

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

Ingress または LoadBalancer を通じて外部に公開してください。TLS を終端するプロキシなしで Pod ポートを直接公開しないでください。

::: warning 注意 — RECOTEM_ALLOWED_HOSTS と Ingress
`TrustedHostMiddleware` は `RECOTEM_ALLOWED_HOSTS` が空の場合、デフォルトで `127.0.0.1,localhost` に設定されます — これは Pod 内の readiness プローブ (`Host: localhost` ヘッダーを使用) には十分です (`tcpSocket` の liveness プローブは HTTP リクエストを送りません)。ただし、異なるホスト名 (通常は Ingress ホスト) で Pod に届くリクエストは **400 Bad Request** を返します。

バンドルされた Helm チャート (`helm/recotem/templates/deployment.yaml`) は `ingress.enabled=true` のとき `ingress.hosts[*].host` から `RECOTEM_ALLOWED_HOSTS` を自動導出し、レンダリングしたリストの先頭に `localhost` を付加します — `env.RECOTEM_ALLOWED_HOSTS` による明示的な上書きに対しても同様です。

**チャートの外で自分で環境変数を書く場合、`localhost` を含めるのはあなたの責任です。** HTTP プローブはいずれも `Host: localhost` を送るため、`localhost` を含まないリストにすると readiness チェックが 400 を返し、Deployment は永久に Ready になりません。`TrustedHostMiddleware` の 400 は通常の拒否リクエストと区別がつかないため、アプリケーションログには手がかりが残らないまま CrashLoop します。

```yaml
- name: RECOTEM_ALLOWED_HOSTS
  value: "localhost,api.example.com,api-internal.svc.cluster.local"
```
:::

## レシピ配布パターン

### ConfigMap (静的レシピ)

変更頻度が低いレシピに最適です。ConfigMap を更新して Deployment をロールアウトしてください。

```bash
kubectl create configmap recotem-recipes \
  --from-file=./recipes/my_recipe.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

ConfigMap を更新した後、新しいレシピファイルを反映させるため Deployment を再起動してください。

```bash
kubectl rollout restart deployment/recotem-serve
```

### PVC

`ReadWriteMany` PVC (例: NFS、EFS、GCS FUSE) を CronJob と Deployment の両方にマウントします。新しいレシピファイルは次のポーリングインターバルでウォッチャーに検知されます — 再起動は不要です。

PVC が `ReadWriteMany` をサポートしない場合は、Deployment に `ReadWriteOnce` を使用し、CronJob との同時マウントができないことを受け入れてください。その場合は代わりにオブジェクトストレージにアーティファクトを書き込んでください (以下を参照)。

### オブジェクトストレージ (S3 / GCS)

レシピの `output.path` を `s3://` または `gs://` URI に設定します。CronJob と Deployment は共有ボリュームを必要とせず、fsspec を通じてアーティファクトに直接アクセスします。

```yaml
output:
  path: s3://my-bucket/artifacts/my_recipe.recotem
  versioning: append_sha
```

Deployment はバケットからの読み取りに IAM アクセスが必要です。IRSA (EKS) または Workload Identity (GKE) を使用してください。

```yaml
serviceAccountName: recotem-serve-sa   # IAM ロール ARN / GCP SA のアノテーション付き
```

レシピ自体もオブジェクトストレージに配置できます。init コンテナでマウントするか、ラッパースクリプト内で URL として参照してください。

::: warning 注意 — レシピごとのロックはホストローカル
Recotem の `<output.path>.lock` は POSIX `flock` を使用し、同一ホスト上の書き込みプロセスのみを調整します。`s3://` または `gs://` の `output.path` では、ロックファイルは `$RECOTEM_LOCK_DIR` (または `<tempdir>/recotem-locks/<sha256-of-output-path>.lock`) 配下の安定したホストローカルパスに作成され、別の Pod からの同時書き込みを防ぎません。シングルライターの保証にはスケジューラーを使用してください。

- バンドルされた CronJob は `concurrencyPolicy: Forbid` (values.yaml のデフォルト) を設定しています。これを維持してください。
- Kubernetes 外部からトレーニングをトリガーする場合 (Argo Workflows、Airflow、カスタムコントローラー)、そちら側で並列度 = 1 を強制してください (Argo の `synchronization.mutex`、Airflow の `max_active_runs=1` など)。
- `recotem train --fail-on-busy` は同一ホスト内のロック競合のみに効果があります。オブジェクトストレージ出力の Pod 間の安全性に依存しないでください。

Recotem はロックパスごとの最初の発生時に WARNING レベルで `recipe_lock_local_only` をログ出力します。同じパスでの以降の発生は DEBUG レベルで記録されます。
:::

## Helm チャートの values

`helm/recotem/` の Helm チャートは `serve` Deployment、オプションの `CronJob` テンプレート、`NetworkPolicy`、`PodDisruptionBudget`、`ServiceAccount`、およびオプションの `HorizontalPodAutoscaler` を提供します。

主要な values (`helm/recotem/values.yaml` からの抜粋):

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

# train CronJob (デフォルトで無効 — スケジュールするには enabled: true を設定)
train:
  enabled: false
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  failOnBusy: false

# RECOTEM_SIGNING_KEYS と RECOTEM_API_KEYS の両方をデータキーとして含む
# 既存の Kubernetes Secret を参照する。
secrets:
  secretName: recotem-auth

recipes:
  mountPath: /recipes
  source: configMap   # configMap | pvc | objectStore
  configMap:
    name: recotem-recipes
    managed: false    # チャートが .data から ConfigMap を管理する場合は true に設定
    data: {}
  pvc:
    claimName: recotem-recipes
    readOnly: true
  objectStore:
    initContainer: {} # 同期 init コンテナの仕様を提供する

networkPolicy:
  enabled: true
  # ingressFromPodSelector はどの Pod が recotem-serve に到達できるかを制限する。
  # これ単体では「すべての受信を拒否」するスイッチではない。allowKubeletProbes が
  # デフォルトで true であり、`from:` を持たない ingress ルールが生成される —
  # NetworkPolicy の仕様ではこれは「すべての送信元」に一致し、deny-all の正反対になる。
  # チャートのデフォルトでは、serve ポートへの受信はすべての送信元に開かれている。
  # 特定のスクレーパーや Ingress コントローラーを許可するにはラベルセレクターを設定する:
  #   ingressFromPodSelector:
  #     app.kubernetes.io/name: ingress-nginx
  ingressFromPodSelector: {}
  # kubelet のプローブは Pod ではなくノードネットワークから発信されるため、
  # podSelector では一致させられない。これは true のままにすること: false にして
  # ingressFromPodSelector を空のままにすると本当の `ingress: []` (deny-all) が
  # 生成され、NetworkPolicy を実際に適用する CNI のクラスターでは全面的かつ
  # サイレントな障害になる — 各レプリカは 1/1 Ready・restartCount 0 のまま
  # Service のエンドポイントに残り続け、クライアントのリクエストは 100% タイムアウトする。
  allowKubeletProbes: true
  # その障害を起こさずに受信を絞る方法: プローブの受信元をすべての送信元ではなく
  # ノードの CIDR に限定する。allowKubeletProbes が true のときだけ参照される。
  kubeletCIDRs: []

hpa:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

チャートをインストールする前に auth Secret を作成してください。

```bash
kubectl create secret generic recotem-auth \
  --from-literal=RECOTEM_SIGNING_KEYS='prod-2026-q2:<hex64>' \
  --from-literal=RECOTEM_API_KEYS='client-a:sha256:<hex64>'
```

適用前にレンダリングして確認してください。

```bash
helm template recotem ./helm/recotem -f values-prod.yaml | less
helm upgrade --install recotem ./helm/recotem -f values-prod.yaml -n recotem
```
