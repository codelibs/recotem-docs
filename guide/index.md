---
title: Overview
description: What Recotem is, how it works, and when to use it.
---

# Overview

Recotem trains and serves a recommender model from a single small YAML configuration file. No machine-learning expertise required.

You describe your data source, a few training preferences, and where to save the result. Recotem handles the rest: fetching the data, finding the best algorithm, training the model, and answering recommendation requests over HTTP.

We call that configuration file a **recipe** — it describes what data to use, how to train, and where to serve. One recipe produces one model and one API endpoint.

No database, no message broker, no administration interface. A recipe file, two commands, and an HTTP endpoint.

## How it works

Recotem is built around two processes that communicate only through a signed binary file called an **artifact** (the trained model):

1. **`recotem train`** reads your recipe, fetches the interaction data (purchases, clicks, reads), searches for the best algorithm and settings, trains the final model, and writes a signed artifact to disk or cloud storage.

2. **`recotem serve`** watches the artifact directory and loads each model as a REST endpoint at `/predict/{name}`. When `recotem train` produces a new artifact, the server picks it up automatically — no restart needed.

Because the two processes share nothing except the artifact file, they can run on different machines. A nightly batch job can write to an S3 bucket while a long-running server reads from the same bucket, hot-swapping the model as soon as a fresh one appears.

```
recipe.yaml  →  recotem train  →  artifact.recotem  →  recotem serve
                (batch job)        (HMAC-signed)        (FastAPI, hot-swap)

any scheduler      local FS / S3 / GCS          POST /predict/{name}
```

The artifact is protected by an HMAC signature (a tamper-detection code). The serving process verifies the signature before loading any model, so a corrupt or altered file is rejected rather than used.

## Who Recotem is for

Recotem is built for teams that want to add recommendations to their product without a dedicated machine-learning team or a complex data infrastructure. If you can export interaction data to a CSV or a BigQuery table, Recotem can turn it into a working recommendation API.

It is a good fit when:

- Your team does not include ML engineers but you still need recommendations in your app or service.
- You want a working recommendation endpoint running in under an hour, not weeks.
- You want to retrain on a schedule (nightly, weekly) with minimal operational overhead.
- Your data lives in CSV files, Parquet files, or BigQuery — and you want to serve predictions over HTTP without managing a separate database or message queue.

## The three-step mental model

1. **Write a recipe.** A small YAML file describes where your data lives, which columns identify users and items, and where to save the trained model.

2. **Run `recotem train`.** One command fetches data, searches for the best algorithm and settings, trains the final model, and writes a signed artifact.

3. **Run `recotem serve`.** One command starts an HTTP server that loads the artifact and answers `POST /predict/{name}` requests. Retrain and the server updates itself.

## Next steps

- [Installation](/guide/installation) — pip and Docker setup, key generation
- [Tutorial](/guide/tutorial/) — end-to-end example with a real purchase log dataset
- [Recipe Basics](/guide/recipe-basics) — understand every section of a recipe file
- [CLI Reference](/guide/cli) — all six commands and their flags
