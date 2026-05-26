---
title: インストール
description: pip または Docker で Recotem をインストールし、鍵を生成してセットアップを確認します。
---

# インストール

Recotem には **Python 3.12 以上** が必要です。インストール方法は 2 つあります。Python パッケージとしてインストールする方法と、Docker イメージを使う方法です。どちらも同じ CLI と動作を提供します。

## オプション A — pip

```bash
pip install recotem
```

インストールが成功したか確認します。

```bash
recotem --help
```

`train`、`serve`、`inspect`、`validate`、`schema`、`keygen` の 6 つのコマンドの一覧が表示されるはずです。シェルが `recotem` を見つけられない場合、パッケージが `PATH` に含まれていない仮想環境にインストールされています。先に環境をアクティベートするか、`python -m recotem --help` で実行してください。

### オプションエクストラ

コアパッケージには CSV と Parquet のデータソースが含まれています。追加機能が必要な場合はエクストラをインストールしてください。

| エクストラ | コマンド | 追加される機能 |
|---|---|---|
| BigQuery データソース | `pip install "recotem[bigquery]"` | Google BigQuery からインタラクションデータを読み込む |
| PostgreSQL データソース | `pip install "recotem[postgres]"` | psycopg 経由で PostgreSQL からインタラクションデータを読み込む |
| MySQL / MariaDB データソース | `pip install "recotem[mysql]"` | PyMySQL 経由で MySQL または MariaDB からインタラクションデータを読み込む |
| SQLite データソース | `pip install "recotem[sqlite]"` | SQLite からインタラクションデータを読み込む (標準ライブラリの `sqlite3` を使用) |
| Amazon S3 | `pip install "recotem[s3]"` | S3 からアーティファクトとデータを読み書きする |
| Google Cloud Storage | `pip install "recotem[gcs]"` | GCS からアーティファクトとデータを読み書きする |
| Azure Blob Storage | `pip install "recotem[azure]"` | Azure からアーティファクトとデータを読み書きする |
| Prometheus メトリクス | `pip install "recotem[metrics]"` | モニタリング用のオプトイン `/metrics` エンドポイント |

エクストラは組み合わせて使えます: `pip install "recotem[s3,metrics]"`

## オプション B — Docker

公式イメージは GitHub Container Registry で公開されています。

```bash
docker pull ghcr.io/codelibs/recotem:latest
```

イメージは非 root ユーザー (UID 1000) で実行されます。学習や配信の際は、レシピディレクトリとアーティファクトディレクトリをボリュームとしてマウントしてください。チュートリアルの `compose.yaml` に完全な動作例があります。[チュートリアル](/ja/guide/tutorial/)を参照してください。

イメージが正常に動作するか確認します。

```bash
docker run --rm ghcr.io/codelibs/recotem:latest --help
```

## 鍵の生成

Recotem は 2 種類の鍵を使います。`train` や `serve` を実行する前に一度だけ生成する必要があります。

### 署名鍵

署名鍵は学習済みモデルのアーティファクトの完全性を保護します。`recotem train` がアーティファクトへの署名に使用し、`recotem serve` が読み込み前の検証に使用します。アーティファクトが改ざんされたり破損したりしていると検証に失敗し、モデルは読み込まれません。

```bash
recotem keygen --type signing --kid prod
```

出力例:

```
kid=prod
plaintext=<64 文字の hex 文字列>
fingerprint=<8 文字の hex>  # 参考情報のみ。サーバーログと照合できます
env_entry=RECOTEM_SIGNING_KEYS=prod:<64 文字の hex 文字列>
```

`env_entry` の行をコピーしてシェルでエクスポートするか、シークレットマネージャーに保存してください。

```bash
export RECOTEM_SIGNING_KEYS="prod:<64 文字の hex 文字列>"
```

### API キー

API キーは `/predict` を呼び出せるクライアントを制御します。クライアントは `X-API-Key` HTTP ヘッダーとして送信します。サーバーはキーのハッシュのみを保存し、平文は保存しません。

```bash
recotem keygen --type api --kid client-a
```

出力例:

```
kid=client-a
plaintext=<43 文字の base64url 文字列>  ← API クライアントに共有するキー
hash=sha256:<64 文字の hex>
env_entry=RECOTEM_API_KEYS=client-a:sha256:<64 文字の hex>
```

サーバー用に `env_entry` の行をエクスポートし、クライアントから `X-API-Key` ヘッダーとして渡すために `plaintext` の値を手元に保管してください。

```bash
export RECOTEM_API_KEYS="client-a:sha256:<64 文字の hex>"
export RECOTEM_API_PLAINTEXT="<43 文字の base64url 文字列>"
```

`RECOTEM_API_KEYS` が設定されていない場合、サーバーは `127.0.0.1` のみにバインドされます (ループバックのみ)。ネットワークインターフェースにサーバーを公開する前に API キーを設定してください。

## まとめ: 各変数の役割

| 変数 | 使用するコマンド | 目的 |
|---|---|---|
| `RECOTEM_SIGNING_KEYS` | `train` と `serve` | アーティファクトファイルの HMAC 署名と検証 |
| `RECOTEM_API_KEYS` | `serve` | `/predict` 呼び出し元の認証 (サーバーはハッシュのみ保存) |
| `X-API-Key: <plaintext>` | HTTP クライアント | すべての `/predict` リクエストに付加して送信 |

`RECOTEM_SIGNING_KEYS` と `RECOTEM_API_KEYS` はどちらも複数のエントリをカンマ区切りで指定できます (`kid1:value,kid2:value`)。これにより、ダウンタイムなしで鍵のローテーションが可能です。ローテーション手順については[オペレーション](/docs/operations)ガイドを参照してください。

## 次のステップ

[チュートリアル](/ja/guide/tutorial/)に従って、10 分以内に最初の推薦システムを学習・配信してみましょう。
