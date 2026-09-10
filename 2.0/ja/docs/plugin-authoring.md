---
title: プラグイン開発
description: "Recotem のデータソースプラグイン開発ガイド。type_name / Config / fetch のコントラクト、パッケージング、FetchContext、テスト、互換性を解説します。"
---

# プラグイン開発

Recotem は Python エントリーポイントを通じて DataSource プラグインを検出します。プラグインは `recotem.datasources` グループに登録されたインストール済みパッケージです。

このリポジトリの `examples/plugins/echo-source/` ディレクトリは最小限の動作する参考実装です。

## プラグインコントラクト

プラグインは 3 つのクラスレベル属性と 1 つの必須メソッド (`fetch`) を持つクラスを提供しなければなりません。`__init__` とオプションの `probe` については以下に説明します。

```python
from __future__ import annotations

import random
from typing import ClassVar, Literal

import pandas as pd
from pydantic import BaseModel, Field
from recotem.datasource.base import DataSourceError, FetchContext


class EchoSource:
    """Returns a synthetic DataFrame — useful for testing and CI."""

    # 1. type_name: discriminator value matched against the recipe YAML
    #    `source.type` field.  Must be a non-empty string and unique across
    #    all installed plugins.  By convention use a short lower-case slug.
    type_name: ClassVar[str] = "echo"

    # 2. Config: pydantic BaseModel describing the recipe sub-fields for this
    #    source.  All fields appear under `source:` in the YAML alongside the
    #    `type:` discriminator.  Config MUST declare `type` as a Literal field
    #    whose single value equals type_name — recotem builds a pydantic
    #    discriminated union keyed on `type` across every registered plugin,
    #    and the training pipeline reads the field back to resolve the source
    #    class.  Omitting it is not an option: pydantic's default
    #    `extra="ignore"` would silently drop the YAML `type:` key and training
    #    would fail with "Recipe source has no discriminator 'type' field."
    #    `validate_plugin_contract` rejects a Config that omits it, types it as
    #    anything other than `Literal`, or whose Literal disagrees with
    #    type_name.
    class Config(BaseModel):
        type: Literal["echo"] = "echo"
        n_users: int = Field(default=10, ge=1)
        n_items: int = Field(default=20, ge=1)
        n_rows: int = Field(default=100, ge=1)
        seed: int = Field(default=42)

    # 3. extras_required: pip extras to suggest when optional dependencies
    #    are missing.  Leave empty if the plugin has no optional deps.
    extras_required: ClassVar[list[str]] = []

    # 4. no_expand_fields: frozenset of field names inside the source config
    #    whose string values must NEVER receive ${RECOTEM_RECIPE_*} env-var
    #    expansion.  List any fields that carry raw SQL, query parameters, or
    #    other content where ${} should be treated as literals.
    #    Use frozenset() (empty) when no fields need protection beyond the
    #    global baseline (query, query_parameters) that is always guarded.
    #    This attribute is REQUIRED — validate_plugin_contract enforces its
    #    presence and its type (frozenset).  A missing or wrong-type attribute
    #    raises DataSourceError at plugin discovery with a pointer to this doc.
    no_expand_fields: ClassVar[frozenset[str]] = frozenset()

    def __init__(self, config: "EchoSource.Config") -> None:
        self._config = config

    def fetch(self, ctx: FetchContext) -> pd.DataFrame:
        """Return a DataFrame whose columns include those named in
        the recipe `schema` block (user_column, item_column, optional
        time_column).

        Returns a DataFrame with columns: user_id (str), item_id (str),
        timestamp (int epoch seconds).
        """
        cfg = self._config
        max_possible = cfg.n_users * cfg.n_items
        if cfg.n_rows > max_possible:
            raise DataSourceError(
                f"EchoSource: n_rows ({cfg.n_rows}) exceeds n_users * n_items "
                f"({max_possible}).  Reduce n_rows or increase n_users/n_items."
            )
        rng = random.Random(cfg.seed)
        users = [f"user_{i}" for i in range(cfg.n_users)]
        items = [f"item_{j}" for j in range(cfg.n_items)]
        all_pairs = [(u, v) for u in users for v in items]
        sampled = rng.sample(all_pairs, cfg.n_rows)
        base_ts = 1_700_000_000
        rows = [
            {"user_id": u, "item_id": v, "timestamp": base_ts + idx}
            for idx, (u, v) in enumerate(sampled)
        ]
        return pd.DataFrame(rows, columns=["user_id", "item_id", "timestamp"])

    def probe(self) -> None:
        """Optional. Called by recotem validate to test connectivity.

        Should be cheap — never load full data.
        Raise DataSourceError on failure.
        Return value is ignored by recotem (Protocol declares -> None).
        """
        cfg = self._config
        max_possible = cfg.n_users * cfg.n_items
        if cfg.n_rows > max_possible:
            raise DataSourceError(
                f"EchoSource: n_rows ({cfg.n_rows}) exceeds n_users * n_items "
                f"({max_possible})."
            )
        # discarded by recotem validate — kept here for illustration only
        return {"status": "ok", "rows_to_emit": cfg.n_rows, "items": cfg.n_items}  # type: ignore[return-value]
```

### ルール

1. **`type_name`** はディスクリミネーター値です。レシピ内では `source.type: echo` として現れます。レジストリはこれが非空の文字列であり、ロードされたすべてのプラグイン間でユニークであることを検証します。`type_name` が重複していると、競合する完全修飾クラス名の両方が報告されます。`recotem train` と `recotem validate` は終了コード **2** で終了します — 3 ではありません。プラグイン検出はレシピロードの内側で走るため、レジストリの `DataSourceError` は `RecipeError` として再送出されるからです。`recotem serve` は**終了しません**: `recipe_load_error_skipped` を記録し、該当レシピをロードしないまま稼働を続けます。

2. **`Config`** は pydantic の `BaseModel` です。フィールドはレシピロード時に検証されます。制約には pydantic バリデーターを使用してください。デフォルト値なしの必須フィールドがレシピから欠落すると `RecipeError` が発生します。

   `Config` はディスクリミネーターフィールド `type: Literal["<type_name>"] = "<type_name>"` を**必ず**宣言しなければならず、その値はクラスの `type_name` と完全に一致する必要があります。recotem は登録されたすべての `Config` を `type` をキーとする pydantic の判別可能ユニオンに組み立て (`build_source_config_union`)、`recotem.training.pipeline` がこのフィールドを読み戻してソースクラスを解決します。フィールドが欠落している場合、`typing.Literal` でない場合、または値が `type_name` と食い違う場合、`validate_plugin_contract` はプラグイン検出時に `DataSourceError` を発生させます。検出がレシピロードの内側で起きるため、このエラーは `RecipeError` にラップされ、プロセスは終了コード **2** で終了します — 下記の `extra="ignore"` の誤りと同じコードであり、データソースの失敗が返す 3 ではありません。

   代わりに pydantic のデフォルトである `extra="ignore"` に YAML の `type:` キーを吸収させることに**依存しないでください**。その組み合わせではレシピのロードは成功しますが、ディスクリミネーターが失われ、学習時に `Recipe source has no discriminator 'type' field.` (終了コード 2) で失敗します。

3. **`extras_required`** は**純粋にドキュメント目的**です。レジストリはこれが `list[str]` であることのみを検証します。recotem はこれらのエクストラを自動インストールまたは自動チェックしません。`__init__` 内で役立つメッセージを自ら表示してください (以下の [遅延インポート](#ルール) を参照) — 属性の値がそこで引用するものです。

4. **`no_expand_fields`** は**必須**であり、`frozenset[str]` でなければなりません。これはソース `Config` 内のすべてのフィールドのうち、文字列値が `${RECOTEM_RECIPE_*}` 環境変数展開を**絶対に**受けてはならないフィールドを命名します。`validate_plugin_contract` はこの属性が存在し `frozenset` であることを確認します。宣言が欠落または型が間違っている場合、プラグイン検出時にこのドキュメントへのポインターとともに `DataSourceError` が発生します。

   - ほとんどのプラグインでは `no_expand_fields: ClassVar[frozenset[str]] = frozenset()` を宣言してください — グローバルベースライン (`query`、`query_parameters`) はレシピローダーによって常に保護されています。
   - SQL またはパラメーター化クエリフィールドを持つプラグインでは明示的にリストしてください: `no_expand_fields: ClassVar[frozenset[str]] = frozenset({"sql", "bind_params"})`。これにより多層防御が提供され、将来のメンテナーに対してセキュリティの意図が文書化されます。

5. **`fetch(ctx)`** は `pandas.DataFrame` を返さなければなりません。DataFrame には `recipe.schema` で参照される列 (`user_column`、`item_column`、オプションで `time_column`) が少なくとも含まれている必要があります。学習パイプラインはフェッチ直後にそれらの列に名前でアクセスします — 列が欠落すると `KeyError` として表面化し、学習実行が終了します。

6. **`fetch()` は外部または一時的な失敗 (認証エラー、ネットワークエラー、クエリエラー、空の結果) に対して `DataSourceError` を発生させなければなりません。** `DataSourceError` は終了コード 3 にマップされます。`__init__` または `fetch()` から送出されたそれ以外の例外も Recotem がラップし、**同じく**終了コード 3 として報告されます — `train` では `Data fetch failed: <exc>` として (インスタンス化は fetch ステップの内側で行われるため、`__init__` の失敗もこの文面で報告されます)、`__init__` に限っては `validate` でも `DataSource probe failed [source]: DataSource construction failed: <exc>` として報告されます。両方のコマンドが呼び出すフックは `__init__` だけです。`validate` は `fetch()` を呼ばず、**`train` は `probe()` を呼びません**。したがってこの 2 つのどちらかで失敗しても、片方のコマンドにしか届きません。とくに、`probe()` が例外を送出しても `fetch()` が動作するプラグインは、学習が終了コード 0 で完了し署名済みアーティファクトを書き出します。一方、同一のレシピに対する `recotem validate` は 3 を報告します。つまり `probe()` にだけ実装した事前条件は、学習実行のゲートには**なりません**。したがってラップは終了コードではなく*メッセージ*のためのものです: ラップしない例外は、欠けているエクストラも認証情報も示さないサードパーティライブラリ自身の文面でオペレーターに届きます。サードパーティの例外を明示的にラップしてください。

   ```python
   def fetch(self, ctx: FetchContext) -> pd.DataFrame:
       try:
           return self._do_fetch()
       except SomeLibraryError as exc:
           raise DataSourceError(str(exc)) from exc
   ```

7. **遅延インポート。** オプションの依存関係をモジュールのトップレベルでインポートしないでください。`__init__` または `fetch()` に遅延させてください。

   ```python
   def __init__(self, config: "MySource.Config") -> None:
       try:
           import my_optional_dep  # noqa: F401
       except ImportError as exc:
           raise DataSourceError(
               "MySource requires 'recotem[myextra]'. "
               "Install with: pip install 'recotem[myextra]'"
           ) from exc
       self.config = config
   ```

   これにより、欠落したエクストラは必要なエクストラ名を記載した明確な `DataSourceError` を生成します。ラップしない `ImportError` も同じ終了コード 3 を返しますが、オペレーターには `No module named 'my_optional_dep'` として届き、エクストラ名も対処方法も示しません。

## パッケージ構成

`examples/plugins/echo-source/` 配下の参考プラグインはこのレイアウトを使用しています:

```
recotem-echo-source/
├── pyproject.toml
└── src/
    └── recotem_echo/
        ├── __init__.py     # re-exports EchoSource so "recotem_echo:EchoSource" resolves
        └── source.py       # EchoSource class definition
```

クラスを直接含むフラットな `recotem_echo/__init__.py` も動作します — 重要なのはエントリーポイント文字列 `<module>:<class>` が解決できることです。

`pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "recotem-echo-source"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["recotem>=2.0,<3", "pandas>=2.2,<4"]

[project.entry-points."recotem.datasources"]
echo = "recotem_echo:EchoSource"

[tool.hatch.build.targets.wheel]
packages = ["src/recotem_echo"]
```

エントリーポイントキー (`echo`) はレジストリのログ/エラーメッセージで報告される名前ですが、ディスクリミネーターとしては使用**されません** — Recotem はロードされたクラスの `type_name` 属性を使用します。慣例として、両者を同じにしてください。

## インストールと使用

```bash
uv pip install -e examples/plugins/echo-source/
```

プラグインを使用するレシピに対して `recotem validate` を実行して検出を確認してください — ローダーはエントリーポイントレジストリを通じて `source.type` を解決し、プラグインが recotem と同じ環境にインストールされていない場合は `Unknown DataSource type 'echo'` を報告します。

::: tip ヒント — recotem schema にはプラグイン設定が含まれる
`recotem schema` は実行時に、登録されたすべての DataSource `Config` クラス (プラグインが提供するものを含む) の判別ユニオンを構築し、それを `Recipe` モデルに代入することで JSON Schema を生成します。プラグインの `Config` スキーマは**出力に含まれます** — これが `source.*` フィールドの IDE オートコンプリートを機能させる仕組みです。ユニオンは呼び出し時に `build_source_config_union()` を通じて組み立てられるため、プラグインは recotem と同じ Python 環境にインストールされている必要があります。
:::

レシピ:

```yaml
name: echo_test

source:
  type: echo
  n_users: 200
  n_items: 100
  n_rows: 6000    # see the note below before shrinking these
  seed: 42        # optional; omit to use the default seed

schema:
  user_column: user_id
  item_column: item_id
  time_column: timestamp   # EchoSource emits integer epoch-second timestamps
  time_unit: s             # required: a numeric time_column has no implied unit

training:
  algorithms: [TopPop]
  metric: ndcg
  cutoff: 10
  n_trials: 1

output:
  path: ./artifacts/echo_test.recotem
```

学習:

```bash
recotem train recipe.yaml
```

::: warning 注意 — 数値の time_column には time_unit が必須
`schema.time_column` が指す列が文字列や datetime ではなく数値を保持している場合、`time_unit` は必須です — 省略すると `code: time_unit_required` で終了コード 4 になります。`recotem validate` はこれを**検出しません**: レシピスキーマの検査とソースへのプローブは行いますが、単位が必要になるのは行がパースされた後だからです。そのため `time_unit` を欠いたレシピは validate をきれいに通過し、`recotem train` で失敗します。ソースがエポック整数を出力する場合は、レシピ作成者が最初から単位を設定できるよう、プラグインの README にその旨を記載してください。
:::

::: tip ヒント — 行数がこれほど大きい理由
EchoSource はユーザーとアイテムのペアを一様ランダムにサンプリングするため、データにはレコメンダーが見つけられる信号がありません。報告される `best_score` はゼロ付近のノイズであり、モデルの品質については何も語りません。これは運用上の問題になります。最良トライアルのスコアが**ちょうど** 0.0 のとき、学習は `code: zero_score` で終了コード 4 になるためです。小さな合成データセットではこれは現実に起こり得ます — `n_users: 50` / `n_rows: 500` ではおよそ 30 回に 1 回が 0.0 になり、同一条件の実行どうしでも結果が食い違いました。`split.seed` は irspack がホールドアウト集合を導出する ID の順序を制御しないためです。ホールドアウト集合の*サイズ*は固定でも、*どの*インタラクションがそこに入るかは固定されません。上記の行数はホールドアウト集合のインタラクションを 31 件ではなく 511 件にするため、全件ミスの評価はほぼ起こり得なくなります。行数を減らすと、このウォークスルーはプラグインとは無関係の理由で断続的に失敗するようになります。
:::

## FetchContext

`FetchContext` は `fetch()` がオプションで使用できるメタデータを保持します:

```python
@dataclass
class FetchContext:
    recipe_name: str                            # the recipe's name field
    run_id: str                                 # unique ID for this training run (UUID)
    extra: dict[str, Any] = field(default_factory=dict)  # reserved for future use
```

ほとんどのプラグインは `ctx` を無視します。書き込みが多いソースからのフェッチにおけるロギングと冪等性キーに有用です。

## `fetch()` の制約

- **同期的**で、単一の `pandas.DataFrame` を返すこと。ジェネレーター、`Iterator[DataFrame]`、`async def` はサポートされていません — 学習パイプラインは `fetch(ctx)` を直接呼び出し、すぐに `.columns` を読み取ります。
- **DataFrame 全体をメモリに。** Recotem は全結果セットで学習します (irspack はそこからスパース行列を構築します)。メモリより大きいソースの場合は `fetch()` 内でチャンク処理と集計を行い、事前集計済みの DataFrame を返してください (例: `(user, item)` ペアのカウント)。
- **認証情報は `FetchContext.extra` を通じて提供されません** (予約済みです)。環境変数 (推奨 — K8s Secrets、systemd の `EnvironmentFile`、Docker の `--env-file` と連携) またはレシピで宣言した `Config` フィールド (ただし YAML にシークレットを記述しないこと — 代わりに `${RECOTEM_RECIPE_*}` で環境変数を参照すること) から読み取ってください。

## アイテムメタデータの読み込み

プラグインのレシピが `item_metadata` を使用する場合、メタデータは `recotem.metadata.loader.load_item_metadata` によってロードされます。失敗はソースフェッチの失敗と区別できるよう `DataSourceError` ではなく `MetadataError` として表面化します。例外には失敗の起点を示す `.cause` 属性があります:

| `.cause` | 意味 |
|---------|---------|
| `"http_fetch"` | HTTP/HTTPS フェッチが失敗した (SSRF ガード、バイト上限、sha256 不一致)。`__cause__` は `HttpFetchError`。 |
| `"parse"` | ファイルが宣言された型 (CSV/Parquet) としてパースできなかった。 |
| `"field_missing"` | 必須フィールドが存在せず `on_field_missing="error"` が設定されている。 |
| `"io"` | ローカルまたはオブジェクトストアの読み取りが失敗した。 |
| `"unknown"` | 予期しない失敗のキャッチオール。 |

ローダーはオプションの `recipe_name=` キーワード引数を受け付けます。指定すると、レシピ名が HTTP フェッチャーのログコンテキストに組み込まれ、リダイレクトおよびバイト上限のログイベント (例: `metadata_source_redirect`) がトリガーしたレシピと関連付けられます。これはウォッチャーによって自動的に設定されます。`load_item_metadata` を直接呼び出す場合 (例: テスト内) のみ必要です。

## 互換性

プラグインコントラクトは recotem 2.x の公開サーフェスの一部です。プラグインの `pyproject.toml` に `recotem>=2.0,<3` をピン留めしてください — `type_name` / `Config` / `fetch(ctx)` の形状はメジャーバージョン内で安定しています。`probe()` フックは将来のマイナーリリースでオプションのパラメーターが追加される可能性があります。将来対応したい場合は `**kwargs: Any` を使用してください。

`[project.entry-points."recotem.datasources"]` のエントリーポイントキーは情報提供のみです (エラーメッセージで使用される)。ディスクリミネーターはクラスの `type_name` です。2 つのインストール済みプラグインが両方とも `type_name = "csv"` を宣言すると、`recotem train` と `recotem validate` は両方の完全修飾クラス名を示して終了コード **2** で終了し、`recotem serve` は該当レシピをスキップしたまま稼働を続けます — どちらかをアンインストールするか `type_name` を変更してください。

## `recotem validate` でのバリデーション

`recotem validate recipes/my_recipe.yaml` はソースクラスをインスタンス化し (`__init__` の遅延インポート/エクストラチェックを実行)、`fetch()` は**呼び出しません**。ソースにオプションの `probe()` メソッドが定義されている場合、`recotem validate` は軽量な接続/認証チェックのためにそれを呼び出します:

```python
def probe(self) -> dict:
    """Optional. Called by recotem validate to test connectivity.

    Should be cheap (LIMIT 1, dry-run, fs.exists, ...) — never load full data.
    Raise DataSourceError on failure.  Return a small status dict that
    recotem validate logs (e.g. {"status": "ok", "rows_to_emit": n_rows}).
    """
    ...
```

`probe()` が定義されている場合、`recotem validate` は `DataSource: probe OK (<type_name>)` を報告します。定義されていない場合は `DataSource: extras OK (<type_name>, no probe defined)` を報告します。ビルトインの `CSVSource` / `ParquetSource` は fsspec の `exists()` を使用し、`BigQuerySource` はドライランクエリジョブを使用します。

## テスト

CLI を使用せずに `fetch()` を直接テストしてください:

```python
from recotem_echo import EchoSource
from recotem.datasource.base import FetchContext

source = EchoSource(EchoSource.Config(n_users=20, n_items=50, n_rows=200))
ctx = FetchContext(recipe_name="test", run_id="abc")
df = source.fetch(ctx)
assert {"user_id", "item_id", "timestamp"}.issubset(df.columns)
assert len(df) == 200
```

完全な YAML → Recipe → DataSource パスを確認するには `recotem.recipe.load_recipe` を統合テストで使用してください。`recipe.source` はプラグインの `Config` モデルのインスタンスです:

```python
from recotem.recipe import load_recipe
from recotem_echo import EchoSource

recipe = load_recipe("tests/fixtures/echo_recipe.yaml")
assert isinstance(recipe.source, EchoSource.Config)
```

## プラグインの信頼

::: danger 警告
サードパーティの DataSource プラグインは完全なプロセス権限で実行されます。悪意のあるプラグインは `RECOTEM_SIGNING_KEYS` と `RECOTEM_API_KEYS` を含む環境変数を読み取れます。プラグインのバージョンをピン留めし、ロックファイルでハッシュピン留めし、デプロイ前にソースコードをレビューしてください。[セキュリティ — プラグインの信頼](./security#プラグインの信頼) を参照してください。
:::
