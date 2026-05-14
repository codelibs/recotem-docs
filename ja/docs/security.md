---
title: セキュリティ
---

# セキュリティ

## 信頼境界

```
                        ┌───────────────────────────────────────────┐
  Operator              │  RECOTEM_SIGNING_KEYS  RECOTEM_API_KEYS   │
  (trusted)             │  env vars, secrets manager                 │
                        └──────────────┬────────────────────────────┘
                                       │ configure
                        ┌──────────────▼────────────────────────────┐
                        │          recotem serve                     │
                        │  binds to RECOTEM_HOST:RECOTEM_PORT        │
  API clients           │                                            │
  (authenticated) ─────►│  POST /predict/{name}  X-API-Key header   │
                        │  GET  /health                              │
                        └──────────────┬────────────────────────────┘
                                       │ reads (signed)
                        ┌──────────────▼────────────────────────────┐
                        │         artifact files                     │
                        │  ./artifacts/*.recotem                     │
                        │  s3:// / gs:// / az://                     │
                        └──────────────┬────────────────────────────┘
                                       │ writes (signed)
                        ┌──────────────▼────────────────────────────┐
  Scheduler             │          recotem train                     │
  (trusted)             │  batch process; no inbound network         │
                        └───────────────────────────────────────────┘
```

インターネットに向いた境界は `recotem serve` です。`recotem train` は受信ネットワークのサーフェスを持ちません。

::: warning 注意 — fsspec の入力スキームはクラウド認証情報を継承する
`source.path` が `s3://`、`gs://`、`az://`、または `abfs(s)://` を使用する場合、Pod のアンビエント IAM またはサービスアカウントの認証情報が fsspec によって直接使用されます — Recotem 内部に追加の認証情報ゲートはありません。SSRF ガードは HTTP/HTTPS フェッチにのみ適用されます。レシピ作成者が完全に信頼されていない環境では、IAM ロールまたはサービスアカウントのスコープを、レシピで使用される特定のバケットとプレフィックスへの読み取り専用アクセスに限定してください。
:::

## 脅威モデルサマリー

| 脅威 | 緩和策 |
|--------|-----------|
| 悪意のあるアーティファクトファイル (シリアライゼーション RCE) | デシリアライズ前の HMAC-SHA256 検証; 署名鍵が必要; レガシーな未署名フォールバックなし |
| HMAC バイパスによる任意クラスの構築 | 二次的な保護として手動列挙の FQCN 許可リスト (以下を参照) |
| アーティファクトサイズ DoS | `RECOTEM_MAX_ARTIFACT_BYTES` 上限 (デフォルト 2 GiB); ヘッダー長上限 (64 KiB); 両方ともデシリアライズ前に適用 |
| アーティファクトの Stat-then-read TOCTOU | 読み取り一回プロトコル: バイトを一度メモリに読み込み、sha256 を計算し、同じバッファから HMAC を検証 |
| ログへの鍵情報流出 | structlog リダクションプロセッサーがチェーンの先頭で実行される; ユニットテストがすべてのログレベルで鍵情報がないことを確認 |
| API キーのブルートフォース / タイミング攻撃 | `hmac.compare_digest` 定数時間比較; プレーンテキストやハッシュをログに記録しない |
| レシピの環境変数展開を通じた認証情報注入 | `RECOTEM_SIGNING_KEYS`、`RECOTEM_API_KEYS`、`*_SECRET*`、`*_PASSWORD*`、`*_TOKEN*`、`*_KEY*`、`AWS_*`、`GOOGLE_*`、`GCP_*` は `${...}` 展開のブラックリストに登録済み |
| レシピを通じた SQL インジェクション | 環境変数展開は `source.query` 内では実行されない; 動的な値は BigQuery の `@param` プレースホルダーを使用すること |
| レシピを通じたパストラバーサル | `name` は読み込み時およびすべてのファイルシステム使用前に `^[A-Za-z0-9_-]{1,64}$` で検証される; `RECOTEM_ARTIFACT_ROOT` によるアーティファクトルート制限 |
| ネットワークフェッチデータの改ざんまたはローテーション | スキームが `http://` または `https://` の場合、`source.path` / `item_metadata.path` に sha256 整合性ピンが**必須**; 不一致はバイトがパーサーに到達する前に `DataSourceError` (終了コード 3) を発生させる |
| 巨大なネットワークフェッチによるリソース枯渇 | `RECOTEM_MAX_DOWNLOAD_BYTES` (デフォルト 256 MiB) がフェッチ中の生 I/O ボディをキャップ; 超過 → ストリーム途中で `DataSourceError`。解凍後の DataFrame はキャップしない — [解凍後サイズ上限の未適用](#解凍後サイズ上限の未適用medium-5) を参照 |
| 公衆インターネット上のプレーンテキスト HTTP ソース | オペレーターの判断。`http://` は (信頼されたネットワーク内では正当な) 許可されているが、オペレーターは公衆インターネット上ではプレーンテキストを使用してはならない; sha256 は到達可能なレスポンスのコンテンツ改ざんを緩和する |
| 任意コードを読み込む未認識プラグイン | 競合するプラグインの `type_name` は起動に失敗する; インストールされたプラグインは信頼されたコードとして扱われる (バージョンをピン留めすること) |
| 未認証の外部アクセス | デフォルトのバインド `127.0.0.1`; `--insecure-no-auth` は `RECOTEM_ENV` が `{development, dev, test}` の場合のみ許可; `TrustedHostMiddleware` が未認識のホストをブロック |

## 解凍後サイズ上限の未適用 (MEDIUM-5)

`RECOTEM_MAX_DOWNLOAD_BYTES` は任意のソースパス (HTTP/HTTPS ボディ、ローカルファイル I/O、オブジェクトストアストリーム) から読み取られる生バイト数をキャップします。解凍とパース後に Pandas が構築する pandas DataFrame のサイズはキャップ**しません**。

### ギャップが生じる仕組み

圧縮 CSV ファイル (`.gz`、`.bz2`、`.zip`、`.xz`) と積極的な圧縮を使用した Parquet ファイルは、解凍時に 1 桁以上展開されることがあります。20:1 で圧縮される 256 MiB の `.csv.gz` は、生 I/O バイトが上限に拒否されることなく、約 5 GiB のインメモリ DataFrame を生成します。`item_metadata.path` も同じギャップの影響を受けます。

### 攻撃シナリオ

レシピを作成または変更する権限を持つレシピ作成者が、高度に圧縮された CSV を `source.path` に指定して `recotem train` に送信できます。学習プロセスは生バイトを受け入れ (上限以下)、ファイルを解凍し、利用可能なプロセスメモリを超えた DataFrame を構築しようとし、OOM キラーによって学習プロセスが強制終了されます。署名鍵は不要です。レシピ作成権限が唯一の前提条件です。

### 現在の緩和策 (不完全)

生 I/O 上限 (`RECOTEM_MAX_DOWNLOAD_BYTES`) は無制限のネットワークダウンロードを防ぎますが、解凍後のサイズを制限しません。現在の実装には DataFrame レベルのメモリキャップはありません。

### 推奨されるオペレーター側の緩和策

将来のリリースで DataFrame レベルのキャップが実装されるまで、オペレーターは以下のコントロールの 1 つ以上を適用してください。

| コントロール | 適用方法 |
|---------|-------------|
| レシピ作成権限の制限 | レシピの作成と変更を特権的な操作として扱う。`recotem train` に新しいレシピを送信できるのは、レシピディレクトリへの書き込みアクセスを持つオペレーターまたは CI パイプラインのみとする。 |
| cgroup メモリ制限 | `recotem train` をハードメモリ制限のある cgroup 内で実行する (systemd ユニットの `MemoryMax=`、`docker run --memory`、または同等のもの)。OOM キルは発生するが、ホストではなく学習コンテナにスコープされる。 |
| `RLIMIT_AS` | 学習バイナリを呼び出す前にラッパーで `resource.setrlimit(resource.RLIMIT_AS, (limit, limit))` を設定するか、ラッパーシェルで `ulimit -v` を使用する。これでプロセスの仮想アドレス空間をキャップできる。 |
| Kubernetes の `resources.limits.memory` | 学習 Pod または CronJob にメモリ制限を設定する。Pod はノードを不安定にするのではなく退避される。例: `resources: { limits: { memory: "4Gi" } }`。デプロイメント/k8s ガイドを参照。 |

::: warning 注意
cgroup / RLIMIT コントロールは OOM イベントを防ぐのではなく — 封じ込めます。意図的に悪意のあるレシピは現在の学習実行を中断させます。真の防止策はレシピを作成できる人を制限することです。
:::

## ネットワークソースのフェッチ動作

`recotem train` は `http://` および `https://` のソースパスを stdlib の `urllib` を通じてフェッチします。フェッチパスは以下を強制します:

- **リダイレクト上限**: 最大 5 リダイレクト (urllib のデフォルト 10 を上書き); 訪問済み URL セットがリダイレクトループを検知; 非 `http`/`https` スキームへのリダイレクトは拒否 (例: `file://`、`gopher://`)。
- **証明書検証**: stdlib `urllib` のデフォルト — システムトラストストア、オプトアウト不可。
- **プロキシ自動検出の上書きなし**: `HTTP(S)_PROXY` 環境変数は尊重するが、他の自動検出は使用しない。
- **User-Agent ヘッダー**: オリジンサーバーがクライアントを識別できるよう Recotem 固定の文字列に設定。
- **URL ユーザー情報のリダクション**: `https://user:pass@host/...` 形式は `csv_source_*` イベントで `https://[REDACTED]@host/...` としてログに記録される。レシピローダーはユーザー情報を含む URL をパース時に拒否する。
- **ボディ上限**: ストリーム読み取りで `RECOTEM_MAX_DOWNLOAD_BYTES` を超えると拒否。
- **タイムアウト**: リクエストごとに `RECOTEM_HTTP_TIMEOUT_SECONDS` (1〜600 にクランプ)。
- **sha256 必須**: スキームがネットワークで `sha256` が未設定の場合、レシピロード時に拒否される; フェッチ後に `hmac.compare_digest` で検証される。

## ネットワークソースに対するオペレーターの責任

レシピはオペレーターが作成し、Recotem の信頼境界内に存在します。つまり、どの URL を指定するか、`http://` URL が安全かどうかの判断はオペレーターの決定であり、Recotem の決定ではありません。

オペレーターの具体的な責任:

- **公衆インターネット上では `https://` を `http://` より優先すること。** TLS はネットワーク攻撃者によるバイトスワップを防ぎます。`sha256` はスワップを検知しますが、TLS は最初からそれを防止します。
- **メタデータサービスとプライベートネットワークはデフォルトでブロックされています。** `recotem train` はすべての HTTP/HTTPS ソース URL のホストを解決し、プライベート (RFC1918)、ループバック、リンクローカル (`169.254.0.0/16` は AWS IMDSv1 と GCP の `metadata.google.internal` をカバー)、予約済み、マルチキャスト、または未指定のアドレスに到達した場合は接続を拒否します。チェックはリダイレクトごとに再実行されるため、CNAME を内部に向けるトリックも拒否されます。正当な内部 HTTP オリジン (ラボの CI ミラー、イントラネットのアーティファクトサーバー) を持つオペレーターは `RECOTEM_HTTP_ALLOW_PRIVATE=1` を設定してオプトインします。本番デプロイメントはこれを未設定のままにしてください。
- **DNS リバインディングは IP ピンニングによって緩和されています。** 追加の対策なしでは、SSRF ガードの `getaddrinfo()` と `urllib` の接続時 `getaddrinfo()` は独立したルックアップになります: 攻撃者がホスト名の権威 DNS を制御することで、最初の呼び出し (SSRF チェック) にはパブリック IP を返し、2 回目 (実際の TCP 接続) にはプライベート IP を返すことで、ガードを完全にバイパスできます。Recotem はこのウィンドウを、SSRF チェック時に解決した IP をカスタム `HTTPConnection` / `HTTPSConnection` の `connect()` メソッドに直接渡すことで閉じています。元のホスト名は `Host:` ヘッダー、(HTTPS の場合) SNI と証明書検証のために保持されるため、正当なトラフィックには影響しません。ピンニングはリクエストごとで、リダイレクトホップごとに再適用されます。敵対的なネットワークでの二次的な保護として、オペレーターはネットワーク層でアウトバウンド DNS も制限すべきです。
- **IPv4 マップ済み IPv6 入力は明示的にアンラップされます。** 一部の Python リリースは `::ffff:169.254.169.254` を `is_link_local=False` と分類します。SSRF ガードはそのため、IPv4 アドレスが埋め込まれている場合はそちらに対しても `is_private` / `is_loopback` / `is_link_local` を追加評価します。`::ffff:127.0.0.1`、`::ffff:169.254.169.254`、および任意の `::ffff:rfc1918` リテラルは stdlib のセマンティクスに関わらず拒否されます。
- **sha256 を一度計算してピン留めし、変更時はアラートを出すこと。** 不一致がシグナルです。CI での再生成によってサイレントにバイパスしないでください。

## アーティファクトペイロードと FQCN 許可リスト

irspack の `IDMappedRecommender` は scipy のスパース行列と numpy 配列に依存しています。これらは構造を失わずに JSON で表現することはできません。irspack ネイティブのバイナリシリアライゼーション形式が必要であり、これは回避できません。

### 主要ゲート: HMAC-before-deserialize

**HMAC-SHA256 検証が主要なセキュリティコントロールです。** バイトシーケンスは 1 バイトたりともデシリアライザーに到達する前に `RECOTEM_SIGNING_KEYS` に対して検証されます。有効な HMAC は、アーティファクトが署名鍵を保持するプロセスによって生成されたことを意味します — 鍵なしの攻撃者は検証を通過するペイロードを構築できません。以下の 4 つのコントロールはすべて順番に適用されます。ステップ 3 と 4 は多層防御であり、HMAC の代替ではありません。

4 つの階層的コントロール:

1. デシリアライズ前のマジックバイト、フォーマットバージョン、サイズチェック。
2. マルチ kid サポートと定数時間比較による **HMAC-SHA256 署名検証**; 署名鍵はログに記録されない (kid のみが表示される)。レガシーな未署名フォールバックなし — 設定ミスまたは欠落した `RECOTEM_SIGNING_KEYS` はフェールクローズ。
3. 手動列挙の FQCN 許可リスト + 狭いモジュールプレフィックス許可リスト (多層防御、主要ゲートではない — 以下を参照)。
4. 環境変数のデフォルトなしで、train と serve の両方に署名鍵が必要。

### 多層防御: FQCN 許可リスト

`SafeUnpickler.find_class` の FQCN 許可リストは、HMAC とは独立して動作する二次的な層です。その目的は、HMAC がバイパスされた場合の爆発半径を制限することです。それ自体で安全を保証するものでは**ありません**: 十分に広い許可リストは、許可されたライブラリが公開する任意の API サーフェスを依然として露出します。

FQCN 許可リストは irspack 0.4.x ごとに凍結されています。irspack がレコメンダークラスを追加または名前変更した場合、リストと CHANGELOG エントリが一緒に更新されます。

FQCN 許可リストはこれらのクラスのみを許可します。このリストとモジュールプレフィックス許可リストの両方の外にあるクラスは、構築前に `ArtifactError` をトリガーします:

```
recotem._idmap.IDMappedRecommender
irspack.utils.id_mapping.IDMapper
irspack.recommenders.ials.IALSRecommender
irspack.recommenders.knn.CosineKNNRecommender
irspack.recommenders.toppop.TopPopRecommender
irspack.recommenders.rp3.RP3betaRecommender
irspack.recommenders.dense_slim.DenseSLIMRecommender
irspack.recommenders.truncsvd.TruncatedSVDRecommender
irspack.recommenders.bpr.BPRFMRecommender
numpy.ndarray
numpy.dtype
numpy.core.multiarray._reconstruct
numpy.core.multiarray.scalar
numpy._core.multiarray._reconstruct
numpy._core.multiarray.scalar
scipy.sparse._csr.csr_matrix
scipy.sparse._csc.csc_matrix
scipy.sparse._coo.coo_matrix
builtins.int
builtins.float
builtins.bool
builtins.list
builtins.tuple
builtins.dict
builtins.str
builtins.bytes
builtins.complex
builtins.set
builtins.frozenset
collections.OrderedDict
```

このリストは Recotem リリースごとに凍結されます。変更は CHANGELOG エントリとともに配布されます。

FQCN リストに加えて、定義モジュールが以下の狭いプレフィックスの 1 つにあるクラスはプレフィックス許可リストを通じて許可されます (numpy と scipy はリリース間で内部レイアウトを再編成します):

```
numpy._core.       numpy 2.x 再構築ヘルパー + スカラー / dtype 機構
numpy.core.        numpy 1.x 同等物 (2.x 以前のアーティファクトとの前方互換)
numpy.dtypes.      numpy 2.x パラメトリック dtype クラス (Float64DType、BoolDType、...)
scipy.sparse._csr. CSR 行列再構築器 + ヘルパー
scipy.sparse._csc. CSC 同等物
scipy.sparse._coo. COO 同等物
```

トップレベルのベアモジュール (`numpy`、`scipy.sparse`) は意図的にプレフィックスリストに**含まれていません**。正当なトップレベル FQCN (`numpy.ndarray`、`numpy.dtype`) は手動列挙リストによってピン留めされているため、`numpy.frompyfunc`、`numpy.vectorize`、`numpy.piecewise`、`scipy.sparse.load_npz` などの呼び出し可能/ファイル I/O ガジェットは、同じパッケージ「配下」に存在してもブロックされます。

拒否リストは、許可されたプレフィックス配下にあるが、コード実行ガジェットを公開するリスクの高いサブモジュールを除外します。以下のモジュールは明示的に拒否リストに登録されています:

- `numpy.testing`, `numpy.distutils`, `numpy.f2py`, `numpy.ctypeslib`, `numpy.lib`, `numpy.compat`, `numpy.random`, `numpy._core._exceptions`
- `scipy.sparse.linalg`, `scipy.sparse.tests`, `scipy.sparse.csgraph`

`numpy.random` は防御的に拒否されています。将来の irspack バージョンで必要になった正当な RNG クラスは、拒否リストを広げるのではなく、正確な FQCN を手動列挙許可リストに追加してください。`numpy._core._exceptions` は広い `numpy._core.*` プレフィックス許可リストを通じて露出する内部攻撃サーフェスを縮小するために拒否されています。

いずれのプレフィックスにも含まれないサブモジュール (例: `numpy.linalg`、`numpy.fft`、`numpy.polynomial`) は暗黙的にブロックされます。

HMAC 検証が主要な防御です。プレフィックス許可リストは科学的スタックにのみスコープされた二次的な層です。

`recotem inspect <artifact>` は完全な HMAC 検証パスを実行し、デシリアライザーを呼び出さずにヘッダー JSON を表示します。信頼されていないアーティファクトに対して安全に実行できます。引数はローカルパスと fsspec URI の両方を受け付けます (`s3://bucket/key.recotem`、`gs://bucket/key.recotem`、`az://container/key.recotem`、`https://host/key.recotem`、`file:///abs/path.recotem`)。

## BigQuery の IAM スコープ

`recotem train` が使用するサービスアカウントに推奨される最小 IAM:

| ロール | スコープ |
|------|-------|
| `roles/bigquery.jobUser` | プロジェクト |
| `roles/bigquery.dataViewer` | クエリ対象のデータセット |
| `roles/bigquery.readSessionUser` | プロジェクト (Storage Read API) |

`roles/bigquery.admin` または `roles/bigquery.dataEditor` を付与しないでください。Recotem は読み取りのみ行います。

GCS アーティファクトストレージの場合:

| ロール | スコープ |
|------|-------|
| `roles/storage.objectCreator` | アーティファクトバケット (train サービスアカウントのみ) |
| `roles/storage.objectViewer` | アーティファクトバケット (serve サービスアカウントのみ) |

S3 の場合:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
  "Resource": "arn:aws:s3:::my-bucket/artifacts/*"
}
```

`s3:PutObject` は train ロールにのみ付与し、serve ロールには付与しないでください。

## レシピの環境変数展開ブラックリスト

`RECOTEM_RECIPE_` プレフィックスを持つ変数のみが `${...}` 展開の候補です。二次的なブラックリストがプレフィックスを満たす場合でも機密名をブロックします。ルールは順番にチェックされ — 最初の一致が優先されます:

| ルール | パターン (大文字小文字を区別しない) |
|------|----------------------------|
| 完全一致 | `RECOTEM_SIGNING_KEYS`, `RECOTEM_API_KEYS` |
| プレフィックス一致 | `AWS_*`, `GCP_*`, `GOOGLE_*`, `AZURE_*` |
| 部分文字列一致 | `*SECRET*`, `*PASSWORD*`, `*PASSWD*`, `*TOKEN*`, `*KEY*`, `*AUTH*`, `*BEARER*`, `*CRED*`, `*PRIVATE*` |

`*KEY*` 部分文字列は意図的に広く設定されています。大文字化した名前に部分文字列 `KEY` を含む任意の `RECOTEM_RECIPE_*` 変数は拒否されます — これには `RECOTEM_RECIPE_PARTITION_KEY`、`RECOTEM_RECIPE_APIKEY`、`RECOTEM_RECIPE_KEYBOARD` が含まれます。`KEY` を含まない名前を使用してください (例: `RECOTEM_RECIPE_PARTITION_COLUMN`)。ブラックリストに登録された参照は `RecipeError` (終了コード 2) を発生させます。

::: tip ヒント — RECOTEM_RECIPE_GCP_PROJECT は許可される
`GCP_*` プレフィックスブラックリストは `GCP_` で*始まる*名前のみに一致します — `RECOTEM_RECIPE_` で始まる `RECOTEM_RECIPE_GCP_PROJECT` には一致しません。`examples/ga4-bigquery/` レシピはこの変数を GCP プロジェクト ID の受け渡しに使用しています。`RECOTEM_RECIPE_*` 変数名の末尾部分にブラックリストの部分文字列を誤って含めないよう注意してください。
:::

::: warning 注意 — 運用上のセキュリティ強化
ブラックリストは偶発的な名前の衝突をキャッチする*二次的*な防御です。*主要な*安全特性は運用上のものです: **`RECOTEM_RECIPE_*` 環境変数にシークレットを格納しないでください。** プレフィックスをレシピのパラメーター化の名前空間として扱い、シークレットの名前空間としては扱わないでください。
:::

## シークレットの取り扱い

**秘密にしなければならないもの:**

- `RECOTEM_SIGNING_KEYS` — アーティファクトの署名と検証のための HMAC 鍵。
- `RECOTEM_API_KEYS` — API キープレーンテキストの scrypt ダイジェストを含む (`hashlib.scrypt` でソルト `b"recotem.api-key.v1"`、n=2、r=8、p=1、dklen=32)。ダイジェストの露出はオフラインの pre-image 攻撃を可能にします。シークレットとして扱ってください。
- API キープレーンテキスト — `recotem keygen` 時に一度だけ表示されます。パスワードマネージャーまたはシークレットマネージャーに保管してください。

**保管の推奨事項:**

| 環境 | 推奨事項 |
|-------------|----------------|
| ローカル開発 | シェル環境またはモード 600 の `.env` ファイル |
| Docker | Docker secrets または compose の `--env-file` でモード 600 |
| Kubernetes | `Secret` オブジェクト; 本番環境では External Secrets Operator を使用 |
| systemd | モード 600、サービスユーザー所有の `EnvironmentFile` |
| CI/CD | リポジトリシークレット (GitHub Actions の `secrets.*`); YAML ファイルには絶対に記述しない |

署名鍵、API キーハッシュ、API キープレーンテキストをバージョン管理にコミットしないでください。

## API キーの最小長

Recotem は `X-API-Key` ヘッダー値に 32 文字の最小長を強制します。32 文字未満のプレーンテキストキーは、ダイジスト比較が試みられる前に 401 (`invalid_api_key`) で拒否されます。

推奨されるワークフローは `recotem keygen --type api` です。これは 43 文字の base64url プレーンテキスト (`os.urandom` の 32 生バイト) を生成します。

## `recotem keygen` 出力フォーマット

2 種類の鍵は異なる出力を生成するため、混同しないようにしてください。

**署名鍵** (`--type signing`):

```
kid=prod-2026-q3
plaintext=<64 hex chars>        # 32 生バイト; これが署名鍵
fingerprint=ddeeff00            # sha256(key_bytes)[:8]; /security.posture ログと一致
env_entry=RECOTEM_SIGNING_KEYS=prod-2026-q3:<64 hex chars>
```

- `env_entry=` の値を `RECOTEM_SIGNING_KEYS` にコピーしてください。
- `fingerprint=` 行は情報提供のみです。`RECOTEM_SIGNING_KEYS` や任意の設定値に使用**してはいけません**。

**API キー** (`--type api`):

```
kid=client-a
plaintext=<43-char base64url>   # API クライアントと共有する (一度だけ表示)
hash=sha256:<64 hex chars>      # RECOTEM_API_KEYS に入れる
env_entry=RECOTEM_API_KEYS=client-a:sha256:<64 hex chars>
```

- `env_entry=` の値を `RECOTEM_API_KEYS` にコピーしてください。
- `hash=sha256:<hex>` 行の `sha256:` プレフィックスはダイジェストファミリーラベルであり、アルゴリズム名ではありません — 実際のダイジェストは `hashlib.scrypt` を使用します。
- `plaintext` は生成時に一度だけ表示されます。リカバリの手段はありません。

2 種類の鍵タイプは互換性のないフォーマットを使用します。混同すると起動時に設定エラーで失敗します。

## ログのリダクション

structlog プロセッサーは以下のキー (大文字小文字を区別しない) をすべてのログイベントから出力前に除去します:

```
x-api-key
authorization
cookie
recotem_signing_key
recotem_signing_keys
recotem_api_keys
*secret*
*password*
*passwd*
*token*
*key*  (ただし *keys* は除く — 複数形はリストフィールドでの誤検知を避ける)
*auth*
*bearer*
*cred*
*private*
aws_*
gcp_*
google_*
azure_*
```

リダクションプロセッサーはチェーンの先頭にあり、トレースを含むすべてのログレベルで実行されます。

デバッグ中のログ行で値が `[REDACTED]` に置き換えられている場合、フィールド名が上記のパターンの 1 つに一致しています。これは意図的です。

**URL ユーザー情報のリダクション。** 埋め込まれた認証情報を含む URL は HTTP フェッチャー境界で `https://[REDACTED]@host/path` としてログに記録されます。独自のアプリケーションコードでユーザー情報を含む生の URL をログに記録しないでください。

## アーティファクトセキュリティポスチャーフラグ

`recotem serve` は起動時に毎回 `security.posture` 構造化ログ行を出力します:

```json
{
  "event": "security.posture",
  "auth_enabled": true,
  "bind_host": "0.0.0.0",
  "signing_keys": [{"kid": "prod-2026-q3", "fingerprint": "ddeeff00"}],
  "signing_kids": ["prod-2026-q3"],
  "signing_key_status": "configured",
  "env": "production",
  "allowed_hosts": ["api.example.com"],
  "allowed_origins": ["https://app.example.com"],
  "unsafe_mode": false
}
```

この行を SIEM に送信してください。非開発環境で `auth_enabled: false` または `unsafe_mode: true` にアラートを設定してください。

`signing_key_status` フィールドは 3 つの値のいずれかをとります:

| 値 | 意味 |
|-------|---------|
| `configured` | 署名鍵が存在し、KeyRing が正常に構築された。 |
| `dev_allow_unsigned` | 開発用未署名モードで実行中。鍵は不要でロードされない。 |
| `missing` | 署名鍵が設定されておらず、`--dev-allow-unsigned` も設定されていない。このログ行の直後に起動が失敗する。 |

`signing_key_status: missing` にアラートを設定してください。

2 つの安全でないフラグが存在し、`RECOTEM_ENV` によってゲートされています:

| フラグ | 要件 | 効果 |
|------|-------------|--------|
| `--insecure-no-auth` | `RECOTEM_ENV` が `development`、`dev`、`test` | API キーチェックを無効化する; `RECOTEM_HOST` が有効になる; 60 秒ごとに繰り返し警告バナーを表示 |
| `--dev-allow-unsigned` | `RECOTEM_ENV=development` かつ `--i-understand-this-loads-arbitrary-code` | HMAC 検証をスキップする; 管理されたテスト環境以外では絶対に使用しないこと |

::: warning 注意 — 本番環境の OpenAPI スキーマ
`RECOTEM_ENV` が `production`、`prod`、または `staging` に設定されている場合、`/docs`、`/redoc`、`/openapi.json` エンドポイントはアプリ構築時に無効化されます。これらのパスへのリクエストは 404 を返します。
:::

両フラグとも、要件に一致しない環境では起動時に明示的なエラーメッセージとともに拒否されます。

`--dev-allow-unsigned` は `--insecure-no-auth` より厳密に危険です: train 側では決定論的なインメモリ開発鍵 (`dev:0000...`) でアーティファクトに署名します; serve 側では任意のアーティファクトをロードします。このフラグで書き込まれたアーティファクトは信頼されていないものとして扱い、本番環境にコピーしないでください。

## 認証失敗イベント

| イベント | レベル | トリガー | ステータス |
|-------|-------|---------|--------|
| `auth_missing_header` | WARN | `X-API-Key` ヘッダーのないリクエスト (`RECOTEM_API_KEYS` が非空) | 401、コード `missing_api_key` |
| `auth_invalid_key` | WARN | ヘッダーが存在するが kid ハッシュが一致しない | 401、コード `invalid_api_key` |
| `auth_anonymous_bypass` | DEBUG | `RECOTEM_API_KEYS` が空 (no-auth モード) のときのすべてのリクエスト | — |
| `auth_anonymous_bypass_first_seen` | INFO | no-auth モードでの特定の `client_host` からの最初のリクエスト | — |

## predict レスポンスの情報漏洩

`POST /predict/{name}` は以下を返します:

- 503 (`recipe_unavailable`) — レシピスタブまたは陳腐化したエントリ。
- 404 (`user_not_found`) — `user_id` が学習データにいなかった。ユーザーの存在がアプリケーションで機密な場合、リバースプロキシで 404 レスポンスをマスクしてください。
- 200 — レコメンデーション、オプションでアイテムメタデータと結合。`RECOTEM_METADATA_FIELD_DENY` で PII 列を除外できます。

`cutoff` はリクエストスキーマによって `[1, 1000]` に制限されます。

## レート制限と DoS

Recotem 自体はリクエストレート制限を実装していません。オペレーターは**必ず** `recotem serve` の前段にリバースプロキシを配置し、`/predict/*` にクォータを適用してください。本番環境ではこれは任意ではありません。

すべての認証試行は保存されている API キーごとに scrypt 鍵導出チェックを実行します。未認証の攻撃者は CPU バインドの scrypt 処理をトリガーできます。Recotem は独自のレートリミッターを実装しません。それはプロキシの責任です。

**推奨される nginx 設定:**

```nginx
# IP アドレスをキーとするレート制限ゾーンを定義する (必要に応じて burst/rate を調整)。
limit_req_zone $binary_remote_addr zone=recotem_predict:10m rate=20r/s;

server {
    # ... TLS とアップストリームの設定 ...

    location /predict/ {
        limit_req zone=recotem_predict burst=40 nodelay;
        limit_req_status 429;
        proxy_pass http://recotem_backend;
    }
}
```

## 署名鍵のエントロピーと保管

- **生成**: `recotem keygen --type signing` は `os.urandom(32)` から鍵を導出します (256 ビットの OS エントロピー)。`KeyRing` は hex デコード後に正確に 32 バイトを強制します。
- **保管**: `RECOTEM_API_KEYS` と同じコントロール (上記の [シークレットの取り扱い](#シークレットの取り扱い) を参照)。
- **鍵の侵害**: 即座にローテーションしてください。手順は [オペレーションガイド — 署名鍵のローテーション](./operations#署名鍵のローテーション) にあります。

## プラグインの信頼

サードパーティの DataSource プラグインはインストールされた Python パッケージです。プラグインのインストールは同じソースから `pip install` を実行することと同等です — プラグインのコードは完全なプロセス権限で実行されます。

オペレーターは以下を行うべきです:

- `pyproject.toml` または `uv.lock` でプラグインのバージョンをピン留めする。
- pip-tools / uv ロックファイルでハッシュピン留めし、CI でロックファイルを検証する。
- デプロイ前にサードパーティプラグインのソースコードをレビューする。

::: danger 警告
Recotem はプラグインをサンドボックス化しません。悪意のあるプラグインは `RECOTEM_SIGNING_KEYS` と `RECOTEM_API_KEYS` を含む環境変数を読み取れます。プラグインを十分に審査してください。
:::

## ネットワーク露出

デフォルトでは `recotem serve` は `127.0.0.1` にバインドします。`RECOTEM_API_KEYS` が空の場合、バインドは強制的に `127.0.0.1` になります。外部に公開するには:

1. `RECOTEM_API_KEYS` を設定する。
2. `RECOTEM_HOST=0.0.0.0` を設定する。
3. `RECOTEM_ALLOWED_HOSTS` にクライアントが使用する正確なホスト名を設定する。
4. ブラウザクライアントが CORS リクエストを送信する場合は `RECOTEM_ALLOWED_ORIGINS` を設定する。
5. TLS を終端するリバースプロキシを前段に配置する。

`recotem serve` は TLS を終端しません。TLS プロキシなしでパブリックポートに直接公開しないでください。

`TrustedHostMiddleware` は未認識の `Host` ヘッダーを持つリクエストをブロックします。本番環境では `RECOTEM_ALLOWED_HOSTS` を明示的に設定してください。
