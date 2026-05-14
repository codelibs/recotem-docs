---
title: CSV / Parquet ソース
---

# CSV / Parquet ソース

組み込みの `csv` および `parquet` ソースは、pandas と fsspec を経由してテーブル形式のインタラクションデータを読み込みます。ローカルファイルには追加のインストールは不要です。クラウドストレージには適切な fsspec バックエンドが必要です。

## クラウドストレージのエクストラ

| スキーム | インストール |
|----------|------------|
| `s3://` | `pip install "recotem[s3]"` |
| `gs://` | `pip install "recotem[gcs]"` |
| `az://` / `abfs(s)://` | `pip install "recotem[azure]"` |

::: warning Azure エクストラと公式 Docker イメージ
公式 Docker イメージには Azure エクストラが含まれていません。`az://` または `abfs(s)://` サポートが必要な場合は、`recotem[azure]` をインストールする派生イメージをビルドしてください (例: `FROM ghcr.io/codelibs/recotem:latest` の後に `RUN pip install "recotem[azure]"`)。
:::

`http://` および `https://` URI は追加のインストールなしで使用できます。ネットワークスキームのパスには `sha256` 整合性ピンが**必須**であり、ボディは `RECOTEM_MAX_DOWNLOAD_BYTES` (デフォルト 256 MiB) で上限が設定されます。下記の [ネットワークスキームの整合性](#ネットワークスキームの整合性-http-https) を参照してください。`file://` はベアローカルパスとして扱われ、追加のインストールは不要です。

## CSV ソース

```yaml
source:
  type: csv
  path: ./data/interactions.csv
  delimiter: ","          # default ","
  encoding: utf-8         # default utf-8
  header: 0               # row index of the header, default 0
  dtype:
    user_id: str
    item_id: str
```

| フィールド | 型 | デフォルト | 備考 |
|------------|-----|-----------|------|
| `path` | string | required | ローカルパス、`file://`、`s3://`、`gs://`、`az://`、`abfs(s)://`、`http://`、または `https://` URI。HTTP/HTTPS には `sha256` 整合性ピンが必要であり、ボディサイズ上限が適用されます。下記の [パススキーム](#パススキーム) を参照してください。 |
| `delimiter` | string | `","` | pandas の `sep=` にそのまま渡されます。複数文字の値は pandas の低速な Python パーサーに切り替えます。 |
| `encoding` | string | `"utf-8"` | pandas が受け付けるエンコーディング。 |
| `header` | int | `0` | カラム名を含む行番号。 |
| `dtype` | map | `null` | 明示的なカラム型の上書き。 |

圧縮ファイル (`.gz`、`.bz2`、`.zip`、`.xz`) は透過的に解凍されます。

::: warning 展開後サイズの上限は強制されません
`RECOTEM_MAX_DOWNLOAD_BYTES` は `source.path` から読み込まれた生バイト数を上限とします。解凍後に生成される pandas DataFrame のサイズは制限**しません**。生の上限に収まる高圧縮の CSV はメモリ上でその何倍ものサイズに展開される可能性があります。学習プロセスを制御するには、`recotem train` を cgroup、`MemoryMax=` を設定した systemd ユニット、または `resources.limits.memory` を設定した Kubernetes Pod 内で実行してください。[security — Decompressed-size cap not enforced](../security#decompressed-size-cap-not-enforced-medium-5) を参照してください。
:::

## Parquet ソース

```yaml
source:
  type: parquet
  path: s3://my-bucket/interactions.parquet
```

Parquet ソースは `path` と任意の `sha256` 整合性ピンのみ受け付けます。`delimiter`、`encoding`、`header`、`dtype` は Parquet ソースの有効なキーではなく、レシピのロードが失敗します。

## パススキーム

`source.path` および `item_metadata.path` のパススキームは明示的な許可リストに限定されます: ベアローカルパス、`file://`、`s3://`、`gs://`、`az://`、`abfs(s)://`、`http://`、`https://`。チェーンされた fsspec プロトコル (`::` を含む) は拒否されます。この許可リストにない新規またはベンダー固有のスキームは、見落としによって許可されるのではなくデフォルトで拒否されます。

```yaml
# Local (relative or absolute)
path: ./data/interactions.csv
path: /mnt/data/interactions.csv

# Object storage (uses cloud SDK auth — instance profile / ADC / env vars)
path: s3://my-bucket/data/interactions.csv.gz
path: gs://my-bucket/data/interactions.parquet
path: az://my-container/interactions.parquet

# HTTP / HTTPS — `sha256` integrity pin is REQUIRED
path: https://files.example.com/2025-01/interactions.csv
sha256: 945fc769205a5976d38c5783500ae473afbb04608043b703951a699993c8f8be

# file:// is treated as a bare local path
path: file:///mnt/data/interactions.csv
```

URI 内の埋め込まれた認証情報 (例: `https://user:pass@host/file.csv`、`s3://AKID:SECRET@bucket/key`) はレシピロード時に拒否されます。認証情報は環境から提供する必要があります (インスタンスプロファイル、ADC、`AWS_*` 環境変数など)。

userinfo チェックはスキームによって選択的に適用されます:

- **拒否** (`http`、`https`、`ftp`、`ftps`、`s3`、`abfs`、`abfss`): `username` または `password` コンポーネントを持つ URI は `RecipeError` を発生させます。これらのスキームは標準のアドレス構文に `@` を使用しないため、`user:pass@host` パターンはプレーンテキストの埋め込み認証情報を意味します。
- **許可** (`gs`、`az`、ベアパス、`file`): `@` 文字は正規の URI 構文の一部である可能性があります。GCS では `gs://project@bucket/key` は gcsfs が受け付ける有効な課金プロジェクトの上書きです。認証は常に ADC / `GOOGLE_APPLICATION_CREDENTIALS` 経由であり、URI の userinfo ではありません。

`${RECOTEM_RECIPE_*}` 環境変数展開は `path` フィールドの内部で**行われます** (バケット名、日付、実行時固有のパスコンポーネントを注入する推奨の方法です)。展開が抑制されるのは `query` / `query_parameters` の内部のみです。

`output.path` はより制限が厳しく、書き込みがサポートされていないスキームとして `http://`、`https://`、`ftp://`、`ftps://`、`memory://` が拒否されます。ベアローカルパス、`file://`、または書き込み可能なオブジェクトストアスキームを使用してください。

## ネットワークスキームの整合性 (HTTP / HTTPS)

`source.path` (または `item_metadata.path`) が `http://` または `https://` を使用する場合:

- `sha256` は同じ設定ブロックで**必須**です。欠落している場合はレシピロードが `RecipeError` で失敗します。
- 取得は stdlib の `urllib.request` 経由で行われます — 追加のランタイム依存関係は不要です。最大 5 リダイレクトが追跡されます (urllib のデフォルトリダイレクトハンドラーをバイパスするカスタムオープナーを使用)。`https://` では TLS 検証は常に有効です。`http(s)://` 以外のスキームへのリダイレクトは拒否され、リダイレクトループ (訪問済み URL を追跡) も拒否されます。
- ダウンロードされたペイロードは `RECOTEM_MAX_DOWNLOAD_BYTES` (デフォルト 256 MiB、[1 MiB, 16 GiB] にクランプ) で上限が設定されます。上限は読み取り後ではなく読み取り*中*にチェックされます。上限を超えると接続が切断され `DataSourceError` が発生し、部分的なバイトはパースされません。同じ上限はローカルおよびオブジェクトストアのソースの読み取りにも適用されます (下記参照)。
- 接続 / 読み取りタイムアウトは `RECOTEM_HTTP_TIMEOUT_SECONDS` (デフォルト 30、[1, 600] にクランプ)。
- 宛先ホストは各リクエスト前 (およびリダイレクトごと) に解決されます。いずれかのアドレスがプライベート (RFC1918)、ループバック、リンクローカル (`169.254.0.0/16`、AWS IMDSv1 / GCP メタデータサーバー)、予約済み、マルチキャスト、または未指定のアドレスに解決された場合、`DataSourceError` でフェッチが拒否されます。内部 HTTP オリジンを持つオペレーターは `RECOTEM_HTTP_ALLOW_PRIVATE=1` でオプトインします (`true` / `yes` / `on` も受け付けます)。本番クラスターではこれを未設定のままにすることで、オペレーターがレシピディレクトリをキュレーションしていなくても、SSRF ガードが悪意あるレシピからクラウドメタデータサービスへのアクセスをブロックします。
- `recotem validate` は非ネットワークスキーム (`fsspec` 経由の `fs.exists()`) の接続確認を行います。HTTP(S) ソースでは DNS 解決と SSRF ガード (`assert_host_public`) を実行します。つまり到達不能またはプライベートホスト名に対する validate は HTTP ではなく DNS で失敗します。validate 中に実際の HTTP リクエストは発行されません。sha256 整合性チェックは validate 時ではなく取得時に行われます。
- sha256 不一致の場合、エラーメッセージには各ダイジェストの最初の 8 桁の hex 文字のみが表示されます (`got 1a2b3c4d…, expected 5e6f7a8b…`)。期待されるグラウンドトゥルースが共有ログに漏洩するのを防ぐためです。

レシピを作成する際に sha256 を一度計算します:

```bash
curl -sL <url> | shasum -a 256
```

上流のファイルがローテーションされた場合は値を再生成してレシピを更新してください。不一致がアラートとなります。

## 非ネットワークパスの sha256

`sha256` はローカル、`file://`、オブジェクトストアのパスでも有効 (任意) です。設定されている場合、バイト列がハッシュ化されて読み取り後に比較されます。ネットワークが関与しない場合でも内部の再現性監査に役立ちます。非ネットワークパスで `sha256` が未設定の場合、pandas は fsspec 経由でストリーミングし、ファイル全体をバッファリングしません (大容量ファイルのパフォーマンスを維持します)。

`RECOTEM_MAX_DOWNLOAD_BYTES` は HTTP/HTTPS だけでなく**すべての**ソース読み取りに適用されます。ローカルファイルの場合、I/O の前に `Path.stat().st_size` がチェックされます。オブジェクトストアのパスの場合は `fsspec.info()["size"]` がチェックされます。報告されたサイズが上限を超えると、ファイルを開く前に `DataSourceError` が発生します。学習データに合わせて `RECOTEM_MAX_DOWNLOAD_BYTES` を十分大きく設定するか、全ソースが合理的なサイズであればデフォルトの 256 MiB のままにしてください。

`source.path` のシンボリックリンクは暗黙的に追跡されます (解決チェックなし。シンボリックリンクエスケープガードは `RECOTEM_ARTIFACT_ROOT` 配下の `output.path` にのみ適用されます)。`recotem validate` と `recotem train` の間に基底のファイルが置き換えられた場合、学習は取得時に単純に新しいファイルを再読み込みします — キャッシュはありません。一方、実行中の `recotem serve` プロセスは `source.path` を再読み込みしません。アーティファクトのみを読み込むため、ソースファイルの変更は次の学習実行まで配信モデルに影響しません。

## dtype の上書き

デフォルトでは、ユーザーとアイテムの ID カラムは pandas が推論した型で読み込まれます。ID が整数のように見える場合 (`1234`、`5678`) でも文字列として扱いたい場合は、明示的な上書きを追加してください:

```yaml
dtype:
  user_id: str
  item_id: str
```

これにより学習と配信の間で一貫した文字列への型変換が保証されます。Recotem はロード後に両カラムを内部的に文字列に型変換しますが、`dtype: str` を設定することで `"0042"` のような先頭ゼロの ID の pandas による誤パースを防ぎます。

CSV のカラムと一致しない `dtype` キーは pandas によって暗黙的に無視されます — タイプミスはエラーになりません。パースが不正に見える場合は、数行を手動で再読み込みして dtype を確認してください。

## エラーと終了コード

CSV パース失敗、ファイル不在、カラム不在は終了コード 3 (`DataSourceError`) または 2 (`RecipeError`) にマッピングされます。HTTP/HTTPS 取得失敗 (リダイレクト違反、sha256 不一致、バイト上限超過を含む) は終了コード 7 (`HttpFetchError`) にマッピングされ、終了コードチェーンで `DataSourceError` より優先されます。

| エラー | 終了コード | メッセージパターン |
|--------|-----------|------------------|
| ファイル不在 | 3 | `DataSourceError: No such file or path: ./data/interactions.csv` |
| カラム不在 | 2 | `RecipeError: column 'user_id' not found` |
| 空ファイル (ヘッダー後) | 3 | `DataSourceError: file has no data rows` |
| パースエラー | 3 | `DataSourceError: ParserError: Error tokenizing data...` |
| 破損した Parquet | 3 | `DataSourceError: ArrowInvalid: ...` |
| 拒否されたスキーム | 2 | `RecipeError: path scheme 'http' is not allowed` |
| 埋め込まれた認証情報 | 2 | `RecipeError: 'source.path' contains embedded credentials in the URI. Use environment-based authentication instead.` |
| sha256 不一致 | 7 | `HttpFetchError: sha256 mismatch: got <8 hex>…, expected <8 hex>…` |
| ダウンロード上限超過 | 7 | `HttpFetchError: Download size cap exceeded fetching <url>: > <bytes> bytes (RECOTEM_MAX_DOWNLOAD_BYTES).` |
| 許可されていないスキームへの HTTP リダイレクト | 7 | `HttpFetchError: Refusing redirect from <url> to disallowed scheme '<scheme>://'` |
| HTTP リダイレクトループ / 上限超過 | 7 | `HttpFetchError: Redirect loop detected …` / `Too many redirects (>5) …` |

## エンコーディングのヒント

CSV が非 UTF-8 エンコーディングを使用している場合 (Windows や Excel からエクスポートされたデータによく見られます)、`encoding` を明示的に設定してください:

```yaml
source:
  type: csv
  path: ./data/interactions.csv
  encoding: cp932       # Shift-JIS (Windows Japanese)
```

指定できる値は Python の `codecs` モジュールが認識するエンコーディング名です: `utf-8`、`utf-8-sig` (BOM 付き UTF-8)、`latin-1`、`cp932`、`iso-8859-1` など。
