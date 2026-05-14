---
title: プラグインデータソース
---

# プラグインデータソース

プラグインは `source.type` 識別子を拡張し、組み込みの `csv`、`parquet`、`bigquery` 型を超えたカスタムデータソースをサポートします。`recotem.datasources` エントリポイントグループに登録されたインストール済みの Python パッケージは、起動時に自動的に検出されます — Recotem のコード変更は不要です。

プラグインのオーサリング契約の全詳細 (クラスの形状、`FetchContext`、テスト、パッケージング、互換性) については [Plugin Authoring](/docs/plugin-authoring) を参照してください。

## プラグインの検出方法

`recotem train` と `recotem serve` の起動時に、Recotem はアクティブな Python 環境の `recotem.datasources` エントリポイントグループをスキャンします。登録された各クラスがロードされ、`type_name` 属性が抽出され、ソース型レジストリに追加されます。レシピ内の不明な `source.type` は登録済みの全型名を列挙した `DataSourceError` を発生させます。

::: warning type_name の重複はハードな起動失敗を引き起こします
2 つのインストール済みプラグインが同じ `type_name` を宣言した場合、`recotem train` と `recotem serve` の両方が起動時に終了コード 3 で終了し、競合する完全修飾クラス名を列挙します。一方のプラグインをアンインストールするか、`type_name` を変更してください。
:::

## プラグイン契約のサマリー

プラグインクラスは以下の属性とメソッドを公開する必要があります:

| 属性 / メソッド | 種別 | 必須 | 説明 |
|-----------------|------|------|------|
| `type_name` | `ClassVar[str]` | yes | レシピの `source.type` と照合される識別子値。非空で、インストール済みの全プラグイン間でユニークである必要があります。 |
| `Config` | `pydantic.BaseModel` サブクラス | yes | このソースのレシピサブフィールドを記述します。全フィールドは YAML の `source:` 配下に `type:` と並んで表示されます。ローダーは `source:` マッピング全体を `Config.model_validate(...)` に渡します。 |
| `extras_required` | `ClassVar[list[str]]` | yes | オプションの依存関係が欠落している場合に提案する pip エクストラ。純粋にドキュメント目的です — Recotem はこれらを自動インストールしません。`__init__` でインストールヒント付きの `DataSourceError` を発生させてください。 |
| `no_expand_fields` | `ClassVar[frozenset[str]]` | yes | `Config` 内のフィールド名のうち、文字列値が `${RECOTEM_RECIPE_*}` 環境変数展開を**決して**受け取らないもの。保護が不要なフィールドには `frozenset()` を使用してください (常にガードされるグローバルベースライン `query`、`query_parameters` を超えて)。宣言が欠落または型が不正な場合、プラグイン検出時に `DataSourceError` が発生します。 |
| `__init__(config)` | メソッド | yes | `Config` のインスタンスを受け取ります。オプションの依存関係インポートはここで行い、インポートに失敗した場合はインストールヒント付きの `DataSourceError` を発生させてください。 |
| `fetch(ctx)` | メソッド | yes | `recipe.schema` で名前付けされたカラムを少なくとも含む `pandas.DataFrame` を返します。外部または一時的な失敗に対しては (ベアな例外ではなく) `DataSourceError` を発生させる必要があります — ベアな例外は終了コード 3 ではなく 1 になります。 |
| `probe()` | メソッド | 任意 | 軽量な接続 / 認証チェックのために `recotem validate` から呼び出されます。フルデータをロードしないでください。失敗時は `DataSourceError` を発生させてください。戻り値は無視されます。 |

## プラグインのインストール

```bash
# Install from PyPI
pip install recotem-my-source

# Install a local development plugin in editable mode
pip install -e ./my-source-plugin/
```

インストール後に検出を確認します:

```bash
recotem validate my_recipe.yaml
```

プラグインが見つからない場合、`validate` は `Unknown DataSource type 'my_type'` と全登録名を報告します。プラグインが `recotem` と**同じ Python 環境**にインストールされていることを確認してください。

## レシピでのプラグインの使用

プラグインを使用するレシピは、組み込みソースを使用するものと見た目が変わりません。`source.type` をプラグインの `type_name` に設定し、プラグインの `Config` が宣言するフィールドを追加します:

```yaml
name: echo_test

source:
  type: echo          # matches EchoSource.type_name
  n_users: 50
  n_items: 100
  n_rows: 500
  seed: 42

schema:
  user_column: user_id
  item_column: item_id
  time_column: timestamp   # EchoSource emits integer epoch-second timestamps

training:
  algorithms: [TopPop]
  metric: ndcg
  cutoff: 10
  n_trials: 1

output:
  path: ./artifacts/echo_test.recotem
```

通常通り学習します:

```bash
recotem train recipe.yaml
```

上記の `echo` プラグインは `examples/plugins/echo-source/` にある正規のリファレンス実装です。合成 DataFrame を生成し、実データなしで学習〜配信の全フローを実行する必要がある CI パイプラインに役立ちます。

## JSON Schema と IDE 連携

`recotem schema` は実行時に、登録された全 DataSource `Config` クラス (プラグインが提供するものを含む) の識別共用体を構築し、`Recipe` モデルに代入することで JSON Schema をビルドします。プラグインの `Config` スキーマが出力に含まれるため、`source.*` フィールドの IDE オートコンプリートが機能します。フィールドを表示するにはプラグインが `recotem` と同じ Python 環境にインストールされている必要があります。

## プラグインパッケージングリファレンス

プラグインパッケージの最小限の `pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "recotem-my-source"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["recotem>=2.0,<3", "pandas>=2.2,<4"]

[project.entry-points."recotem.datasources"]
my_source = "recotem_my_source:MySource"

[tool.hatch.build.targets.wheel]
packages = ["src/recotem_my_source"]
```

エントリポイントキー (`my_source`) はレジストリのログとエラーメッセージに使用されますが、識別子ではありません — Recotem はクラスの `type_name` 属性を使用します。慣例として両者は同じにしてください。

プラグインの依存関係に `recotem>=2.0,<3` をピン留めしてください。`type_name` / `Config` / `fetch(ctx)` 契約は 2.x メジャーバージョン内で安定しています。
