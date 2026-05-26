---
title: アーキテクチャ
---

# アーキテクチャ

Recotem はレシピ駆動の推薦システムです。単一の YAML ファイル (_レシピ_) がデータソース、学習設定、アーティファクトの出力先を定義します。1 つのレシピが 1 つの学習済みモデルと `/v1/recipes/{name}:<verb>` HTTP エンドポイント群を生成します。

## システム概要

```
  ┌─────────────────────────────────────┐
  │           Operator machine          │
  │                                     │
  │  recipe.yaml ──► recotem train      │
  │                       │             │
  │               fetch → tune → sign   │
  │                       │             │
  │               artifact.recotem      │
  └───────────────────────┼─────────────┘
                          │  (file copy / object storage)
  ┌───────────────────────▼─────────────┐
  │           Serving machine           │
  │                                     │
  │  recotem serve --recipes ./         │
  │       │                             │
  │       ├── HMAC verify               │
  │       ├── deserialize payload       │
  │       └── FastAPI /v1/recipes/{name}:recommend   │
  │                  │                               │
  │                  ▼                               │
  │          API client request                      │
  └─────────────────────────────────────┘
```

**学習と配信は異なるマシン上で動作し、署名済みアーティファクトファイルのみで通信します。** 学習プロセスはバイナリアーティファクトを書き出し、配信プロセスはそれを読み込みます。プロセス間の共有状態も、共有データベースも、RPC も存在しません。

## レシピ

レシピはモデルの唯一の情報源です。

```
1 recipe YAML  →  1 trained artifact  →  /v1/recipes/{name}:recommend
                                         /v1/recipes/{name}:recommend-related
                                         /v1/recipes/{name}:batch-recommend
                                         /v1/recipes/{name}:batch-recommend-related
```

レシピが記述する内容:
- **データの取得先** (`source` ブロック — CSV、Parquet、BigQuery、SQL、またはプラグイン)
- **カラムのマッピング** (`schema` ブロック — ユーザー ID、アイテム ID、任意のタイムスタンプ)
- **データ品質ゲート** (`cleansing` ブロック — null 除去、重複除去、最低閾値)
- **学習内容** (`training` ブロック — アルゴリズム、Optuna バジェット、分割方式)
- **書き出し先** (`output` ブロック — パスとバージョニングモード)

全フィールドのリファレンスは [レシピリファレンス](./recipe-reference) を参照してください。

## アーティファクト形式

アーティファクトは以下のレイアウトを持つバイナリコンテナです。

```
magic | version | reserved | kid | hmac | header_json | payload
```

- **HMAC スコープ**: `kid_bytes || header_json || payload`。これらのセクション内の任意のバイトを変更すると HMAC 検証が失敗します。
- **ヘッダー JSON** には `recipe_name`、`recipe_hash`、`best_class`、`best_params`、`best_score`、`metric`、`cutoff`、`tuning`、`data_stats`、`recotem_version`、`irspack_version`、`trained_at` が含まれます。`recotem inspect` でデシリアライズせずに参照できます。
- **ペイロード** はシリアライズされた `IDMappedRecommender` (scipy sparse 行列 + numpy 配列) を含みます。ペイロードの 1 バイトを解釈する前に HMAC が完全に検証されます。デシリアライザはアンピクリング時に FQCN 許可リストを強制します (多層防御)。
- **Key ID (`kid`)** はどの署名鍵が HMAC を生成したかを識別します。`KeyRing` (環境変数: `RECOTEM_SIGNING_KEYS=kid1:hex,kid2:hex`) は複数の鍵を保持し、ダウンタイムなしの鍵ローテーションを実現します。

::: warning アーティファクトの完全性は必須要件です
`recotem serve` は HMAC 検証に失敗したアーティファクトのロードを拒否します。本番環境でこれを回避するフラグは存在しません。`--dev-allow-unsigned` は `RECOTEM_ENV=development` の条件下でのみ使用可能であり、コンパニオンフラグ (`--i-understand-this-loads-arbitrary-code`) も必要です。これはシリアライゼーションの唯一の信頼境界を無効化するためです。
:::

## 信頼境界

| アクター | 制御対象 | 信頼レベル |
|----------|----------|------------|
| オペレーター | レシピ YAML、署名鍵、環境変数、`RECOTEM_SIGNING_KEYS` | 完全に信頼 |
| 学習ホスト | ソースデータの読み取り、署名済みアーティファクトの書き出し | 信頼 (オペレーター管理) |
| 配信ホスト | アーティファクトディレクトリの読み取り、`/v1/recipes/{name}:<verb>` の配信 | 信頼 (オペレーター管理) |
| API クライアント | API キーを使って `/v1/recipes/{name}:<verb>` リクエストを送信 | 信頼しないユーザー入力 |
| アーティファクトファイル | 変更不可の署名済みバイナリ。改ざんがあれば HMAC が失敗 | HMAC で認証済み |

レシピは動的な値のために環境変数を参照できます (`${RECOTEM_RECIPE_*}` 展開)。展開メカニズムはそのプレフィックスに限定されており、SQL インジェクションを防ぐために `source.query` や `source.query_parameters` の内部では決して適用されません。

## ホットスワップ

配信プロセスはレシピディレクトリのアーティファクトファイルの変更をポーリングします。ロード済みアーティファクトのファイルの mtime が変化した場合 (学習が新バージョンを書き出した場合)、ウォッチャーはそのモデルをバックグラウンドで再ロードします。

1. 新しいアーティファクトの HMAC を検証します。
2. ペイロードをデシリアライズします。
3. インメモリのモデル参照をアトミックに置き換えます。
4. 旧モデルは破棄され、以降のすべてのリクエストは新しいモデルを使用します。

ホットスワップは**レシピスコープ**です。アーティファクト `A` を更新しても、レシピ `B` の処理中モデルには影響しません。配信プロセスは再起動しません。新しいアーティファクトの HMAC 検証またはデシリアライズが失敗した場合、旧モデルが引き続き配信され、障害は `/v1/health` および `recotem_artifact_load_failures_total` Prometheus メトリクス (メトリクスが有効な場合) に記録されます。

ウォッチャーのポーリング間隔は `RECOTEM_WATCH_INTERVAL` で設定します (デフォルト 5 秒、1〜30 秒にクランプ)。

### バージョニングとポインタファイル

デフォルトの `output.versioning: append_sha` モードはアーティファクトを以下のように書き出します。

```
artifacts/news_articles.<sha8>.recotem
```

そして `artifacts/news_articles.recotem` にポインタファイルをアトミックに更新します (`output.path` の末尾の `.recotem` は sha サフィックス付与前に除去されます)。サーバーはポインタを経由して読み込みます。これにより:
- アーティファクトがその場で上書きされることはありません。
- ポインタの更新が OS が保証すべき唯一のアトミック操作となります。
- 古いアーティファクトのバージョンはオペレーターが削除するまでディスクに残ります。

`always_overwrite` はポインタをスキップして `output.path` に直接書き込みます。アトミックなリネームが使えないオブジェクトストレージバックエンドに適しています。

## 学習と配信の分離

`recotem.training` パッケージと `recotem.serving` パッケージは**互いにインポートしません**。共有型 (`IDMappedRecommender` など) は中立のトップレベルモジュール (`recotem._idmap`) に配置されています。CLI (`cli.py`) は両方をインポートしますが、関数ローカルの遅延インポートとして実装されているため、CLI モジュールのインポート時にいずれのサブパッケージもロードされません。

この分離により:
- `recotem train` のみに使用するコンテナイメージに配信の依存関係は不要です。
- 配信コンテナに学習の依存関係 (Optuna、irspack の学習エクストラ) は不要です。
- 各ホストの攻撃対象領域はその役割に限定されます。

## CLI サマリー

| コマンド | 用途 |
|----------|------|
| `recotem train <recipe.yaml>` | データ取得、Optuna 探索、最良モデルの学習、アーティファクト署名 |
| `recotem serve --recipes <dir>` | ホットスワップ付き FastAPI `/v1/recipes` サーバーの起動 |
| `recotem inspect <artifact>` | アーティファクトヘッダーの読み取りと検証 (ペイロードのデシリアライズなし) |
| `recotem validate <recipe.yaml>` | レシピスキーマの検証とデータソース接続確認 |
| `recotem schema` | レシピモデルの JSON Schema を出力 (IDE 連携) |
| `recotem keygen --type signing\|api` | 署名鍵または API キーの生成 |

## 終了コード

| コード | 意味 |
|--------|------|
| 0 | 成功 |
| 1 | 未処理 / 未マッピングの例外 |
| 2 | `RecipeError` — スキーマ、環境変数展開、パススキーム |
| 3 | `DataSourceError` — CSV パース、カラム不在、BigQuery アクセス |
| 4 | `TrainingError` — 全トライアル失敗、最低データ量違反 |
| 5 | `ArtifactError` — マジックバイト / バージョン / HMAC 検証 |
| 6 | `LockContestedError` — 別プロセスによるレシピ単位の学習ロック |
| 7 | `HttpFetchError` — SSRF ガード / sha256 不一致 / リダイレクト違反 / バイト上限 |
| 8 | 設定エラー — `--dev-allow-unsigned` なしで署名鍵が未設定など |

## 次のステップ

- [レシピリファレンス](./recipe-reference) — レシピの全フィールド、型、デフォルト値、バリデーションルール
- [CSV / Parquet ソース](./data-sources/csv) — ローカル、オブジェクトストレージ、HTTP ソースのオプション
- [BigQuery ソース](./data-sources/bigquery) — 認証、パラメータバインド、GA4 パターン
- [SQL ソース](./data-sources/sql) — SQLAlchemy 2 経由の PostgreSQL / MySQL / MariaDB / SQLite
- [プラグインデータソース](./data-sources/plugins) — カスタムプラグインによる `source.type` の拡張
- デプロイガイド — Docker、Kubernetes、cron スケジューリング
- 運用ガイド — 鍵ローテーション、リカバリ、サイジング、トラブルシューティング
- セキュリティモデル — 信頼境界、FQCN 許可リスト、脅威モデル
