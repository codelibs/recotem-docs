---
title: Data Sources
---

# Data Sources

Recotem reads interaction data through pluggable **data sources**, selected by the
`source.type` discriminator in your recipe. Each source has its own connection options,
authentication model, and optional install extras. The pages below cover every builtin
source plus the plugin mechanism for adding your own.

## Builtin sources

| Source | `source.type` | Use it for |
|--------|---------------|------------|
| [CSV / Parquet](./csv) | `csv`, `parquet` | Tabular files on local disk or cloud storage (`s3://`, `gs://`, `az://`). No extra install for local files. |
| [BigQuery](./bigquery) | `bigquery` | Reading interactions straight from a BigQuery table or query. Requires the `recotem[bigquery]` extra. |
| [SQL](./sql) | `sql` | Relational databases via SQLAlchemy 2 (PostgreSQL, MySQL/MariaDB, SQLite). |

## Extending Recotem

| Topic | Description |
|-------|-------------|
| [Plugins](./plugins) | Register a custom source in the `recotem.datasources` entry-point group — discovered automatically at startup, no changes to Recotem required. |

## Related reference

- [Environment Variables](../environment-variables) — runtime knobs that tune individual data sources (e.g. `RECOTEM_MAX_SQL_ROWS`).
