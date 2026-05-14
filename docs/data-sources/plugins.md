---
title: Plugin Data Sources
---

# Plugin Data Sources

Plugins extend the `source.type` discriminator to support custom data sources beyond the builtin `csv`, `parquet`, and `bigquery` types. Any installed Python package that registers in the `recotem.datasources` entry-point group is automatically discovered at startup — no code changes to Recotem are required.

For the full plugin authoring contract (class shape, `FetchContext`, testing, packaging, compatibility), see [Plugin Authoring](/docs/plugin-authoring).

## How plugins are discovered

At both `recotem train` and `recotem serve` startup, Recotem scans the `recotem.datasources` entry-point group in the active Python environment. Each registered class is loaded, its `type_name` attribute is extracted, and it is added to the source type registry. An unknown `source.type` in a recipe raises `DataSourceError` listing all registered type names.

::: warning Duplicate type_name values cause hard startup failures
If two installed plugins both declare the same `type_name`, both `recotem train` and `recotem serve` exit with code 3 at startup, listing the conflicting fully-qualified class names. Uninstall one plugin or rename its `type_name`.
:::

## Plugin contract summary

A plugin class must expose the following attributes and methods:

| Attribute / Method | Kind | Required | Description |
|--------------------|------|----------|-------------|
| `type_name` | `ClassVar[str]` | yes | Discriminator value matched against `source.type` in the recipe. Must be non-empty and unique across all installed plugins. |
| `Config` | `pydantic.BaseModel` subclass | yes | Describes the recipe sub-fields for this source. All fields appear under `source:` in the YAML alongside `type:`. The loader passes the entire `source:` mapping to `Config.model_validate(...)`. |
| `extras_required` | `ClassVar[list[str]]` | yes | Pip extras to suggest when optional dependencies are missing. Purely documentation — Recotem never auto-installs these. Surface a `DataSourceError` with the install hint in `__init__`. |
| `no_expand_fields` | `ClassVar[frozenset[str]]` | yes | Field names inside `Config` whose string values must **never** receive `${RECOTEM_RECIPE_*}` env-var expansion. Use `frozenset()` when no fields need protection beyond the global baseline (`query`, `query_parameters`, which are always guarded). Missing or wrong-type declaration raises `DataSourceError` at plugin-discovery time. |
| `__init__(config)` | method | yes | Receives an instance of `Config`. Defer optional dependency imports here; raise `DataSourceError` with an install hint if imports fail. |
| `fetch(ctx)` | method | yes | Returns a `pandas.DataFrame` containing at least the columns named in `recipe.schema`. Must raise `DataSourceError` (not a bare exception) for external or transient failures — bare exceptions become exit 1 instead of exit 3. |
| `probe()` | method | optional | Called by `recotem validate` for a lightweight connectivity / auth check. Should never load full data. Raise `DataSourceError` on failure. Return value is ignored. |

## Installing a plugin

```bash
# Install from PyPI
pip install recotem-my-source

# Install a local development plugin in editable mode
pip install -e ./my-source-plugin/
```

Verify discovery after install:

```bash
recotem validate my_recipe.yaml
```

If the plugin is not found, `validate` reports `Unknown DataSource type 'my_type'` listing all registered names. Confirm the plugin is installed in the **same Python environment** as `recotem`.

## Using a plugin in a recipe

A recipe using a plugin looks no different from one using a builtin source. Set `source.type` to the plugin's `type_name` and add whichever fields the plugin's `Config` declares:

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

Train as normal:

```bash
recotem train recipe.yaml
```

The `echo` plugin above is the canonical reference implementation from `examples/plugins/echo-source/`. It generates a synthetic DataFrame and is useful for CI pipelines that need to exercise the full train-serve path without real data.

## JSON Schema and IDE integration

`recotem schema` builds the JSON Schema at runtime by constructing a discriminated union of every registered DataSource `Config` class — including plugin-provided ones — and substituting it into the `Recipe` model. Plugin `Config` schemas appear in the output, which makes IDE autocompletion work for `source.*` fields. The plugin must be installed in the same Python environment as `recotem` for its fields to appear.

## Plugin packaging reference

A minimal `pyproject.toml` for a plugin package:

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

The entry-point key (`my_source`) is used in registry log and error messages but is **not** the discriminator — Recotem uses the class's `type_name` attribute. By convention, keep them the same.

Pin `recotem>=2.0,<3` in your plugin's dependencies. The `type_name` / `Config` / `fetch(ctx)` contract is stable within the 2.x major version.
