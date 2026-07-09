---
title: Learn Recotem
description: Hands-on guides to building recommendation systems with Recotem — from GA4 and purchase logs to comparisons with AWS Personalize and Python recommender libraries.
faq:
  - q: "What is Recotem?"
    a: "Recotem is an open-source, recipe-driven recommender system for Python. A single YAML recipe describes the data, the training search, and the output; recotem train produces a signed model artifact and recotem serve mounts it as a /v1/recipes/{name}:recommend HTTP API. It is built on the irspack recommender library."
  - q: "Is Recotem free and open source?"
    a: "Yes. Recotem is released under the Apache 2.0 license and runs entirely on your own infrastructure. There are no per-request fees and no managed-service subscription."
  - q: "What recommendation algorithms does Recotem support?"
    a: "IALS, RP3beta, CosineKNN, DenseSLIM, TruncatedSVD, BPRFM, and a TopPop popularity baseline. You list the algorithms to try in the recipe and an Optuna hyperparameter search keeps the best-scoring model."
  - q: "Does Recotem need a database or message broker?"
    a: "No. Training and serving communicate only through a signed artifact file, so there is no database, no message queue, and no admin UI to run. recotem serve hot-swaps the model when a new artifact appears."
  - q: "What data does Recotem need to train a model?"
    a: "Interaction rows — one (user, item) event per row, optionally with a timestamp. Recotem models implicit feedback such as clicks, plays, and purchases; explicit star ratings are not required. Data can come from CSV, Parquet, BigQuery, or a SQL database."
  - q: "Is Recotem an alternative to AWS Personalize?"
    a: "Yes. Recotem is a self-hostable, open-source alternative to managed recommendation services like AWS Personalize — you keep the data and the model, with no per-request pricing."
---

# Learn Recotem

Task-focused guides for building real recommendation systems with Recotem. Each
guide is self-contained and grounded in a runnable recipe — pick the one that
matches the data you already have, or the decision you are trying to make.

## Concepts

Understand the ideas behind recommender systems.

- [What Is a Recommendation System?](/learn/concepts/recommendation-system) —
  the big picture and where recommenders are used.
- [Collaborative Filtering Explained](/learn/concepts/collaborative-filtering) —
  the workhorse behind "users like you".
- [Implicit vs Explicit Feedback](/learn/concepts/implicit-explicit-feedback) —
  clicks and purchases vs star ratings.
- [Recommender Metrics: nDCG, MAP, Recall@K](/learn/concepts/evaluation-metrics) —
  how to measure ranking quality.

## How-to

Step-by-step tutorials.

- [How to Build a Recommendation System in Python](/learn/how-to/build-in-python) —
  from raw interactions to a live API.
- [How to Evaluate a Recommender](/learn/how-to/evaluate) —
  offline evaluation done right.
- [Implicit-Feedback Recommendations, Step by Step](/learn/how-to/implicit-feedback) —
  from event logs to ranked items.

## Use cases

Build a working recommender from the data you already have.

- [Product Recommendations from GA4 + BigQuery](/learn/use-cases/ga4-bigquery) —
  turn Google Analytics 4 events into a live recommendation API.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) —
  "customers who bought this" from an e-commerce order history.
- [Recommendations from a SQL Database](/learn/use-cases/sql-database) —
  train directly from PostgreSQL, MySQL, or SQLite.
- [Add a Self-Hosted Recommendation API](/learn/use-cases/recommendation-api) —
  serve recommendations over HTTP from your own infrastructure.

## Compare

Where Recotem fits relative to the alternatives.

- [AWS Personalize Alternative](/learn/compare/aws-personalize-alternative) —
  a self-hosted, open-source option.
- [Recotem vs LightFM vs implicit](/learn/compare/python-libraries) —
  framework vs library for Python recommenders.
- [Open-Source Recommendation Systems Compared](/learn/compare/open-source) —
  Gorse, RecBole, Merlin, and Recotem.

## Frequently asked questions

### What is Recotem?

Recotem is an open-source, recipe-driven recommender system for Python. A single
YAML recipe describes the data, the training search, and the output;
`recotem train` produces a signed model artifact and `recotem serve` mounts it as
a `/v1/recipes/{name}:recommend` HTTP API. It is built on the
[irspack](https://github.com/tohtsky/irspack) recommender library.

### Is Recotem free and open source?

Yes. Recotem is released under the Apache 2.0 license and runs entirely on your
own infrastructure. There are no per-request fees and no managed-service
subscription.

### What recommendation algorithms does Recotem support?

IALS, RP3beta, CosineKNN, DenseSLIM, TruncatedSVD, BPRFM, and a TopPop
popularity baseline. You list the algorithms to try in the recipe and an
[Optuna](/docs/recipe-reference#training) hyperparameter search keeps the
best-scoring model.

### Does Recotem need a database or message broker?

No. Training and serving communicate only through a signed artifact file, so
there is no database, no message queue, and no admin UI to run. `recotem serve`
hot-swaps the model when a new artifact appears.

### What data does Recotem need to train a model?

Interaction rows — one (user, item) event per row, optionally with a timestamp.
Recotem models [implicit feedback](/learn/concepts/implicit-explicit-feedback)
such as clicks, plays, and purchases; explicit star ratings are not required.
Data can come from CSV, Parquet, BigQuery, or a SQL database.

### Is Recotem an alternative to AWS Personalize?

Yes. Recotem is a self-hostable, open-source alternative to managed
recommendation services like
[AWS Personalize](/learn/compare/aws-personalize-alternative) — you keep the
data and the model, with no per-request pricing.

## Next steps

- New to Recotem? Start with the [Guide](/guide/).
- Need field-level details? See the [Recipe Reference](/docs/recipe-reference).
