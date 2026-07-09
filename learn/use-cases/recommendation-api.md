---
title: Add a Self-Hosted Recommendation API to Your App
description: "Build a self-hosted recommendation API with Recotem: serve :recommend, :recommend-related, and batch endpoints over HTTP with X-API-Key auth — curl and Python examples."
---

# Add a Self-Hosted Recommendation API to Your App

Once you have a trained model, the last mile is exposing it to your application
as an HTTP API. `recotem serve` turns any directory of recipes into a
**self-hosted recommendation API** — a FastAPI server you run on your own
infrastructure, behind your own authentication, with no per-request fees and no
customer data leaving your network.

This guide walks through the endpoints you get, how to authenticate, and how to
call them from `curl` and from a Python client. It assumes you already have a
signed artifact from `recotem train` (if not, start with the
[GA4 + BigQuery use case](/learn/use-cases/ga4-bigquery)).

## Why self-host instead of a SaaS

Managed recommendation services are quick to start with, but a self-hosted API
wins on a few axes that matter as you scale:

- **Data residency.** Your interaction logs and item catalog never leave your
  environment. The model is trained and served entirely inside your own VPC,
  which simplifies compliance (GDPR, HIPAA, internal data-handling policy).
- **Cost predictability.** There are no per-recommendation or per-user charges.
  You pay for the compute you run — a single container serves thousands of
  requests per second for popular algorithms.
- **No lock-in.** A recipe is a plain YAML file and an artifact is a portable,
  signed binary. You can move the whole pipeline between clouds, or on-prem,
  without rewriting integrations.
- **Full control of the request path.** You choose the reverse proxy, the rate
  limits, the auth model, and the network boundary.

The trade-off is that you own operations — deployment, scaling, and TLS
termination are your responsibility. The rest of this guide, plus the
[Docker deployment guide](/docs/deployment/docker), covers that.

## The endpoints you get

Every recipe you load is exposed under `/v1/recipes/{name}:<verb>`, following
the [AIP-136](https://google.aip.dev/136) colon-verb convention. A recipe named
`purchase_log` produces these recommendation verbs:

| Verb | Purpose |
|---|---|
| `POST /v1/recipes/purchase_log:recommend` | Top-K items for a single user. |
| `POST /v1/recipes/purchase_log:recommend-related` | Items related to one or more seed items ("more like this"). |
| `POST /v1/recipes/purchase_log:batch-recommend` | Recommendations for many users in one request. |
| `POST /v1/recipes/purchase_log:batch-recommend-related` | Related items for many seed sets in one request. |

There are also discovery and health endpoints (`GET /v1/recipes`,
`GET /v1/health`) — see the full [Serving API reference](/docs/serving-api) for
every field and status code.

## Authentication with X-API-Key

Every endpoint except `GET /v1/health` requires an `X-API-Key` header carrying a
plaintext API key. Generate one with:

```bash
recotem keygen --type api
```

This prints a 43-character plaintext key (share it with your client) and a
`sha256:<hex64>` digest to place in the server's `RECOTEM_API_KEYS`:

```bash
export RECOTEM_API_KEYS="client-a:sha256:<hex64>"
```

::: warning
When `RECOTEM_API_KEYS` is empty, the server forces its bind to `127.0.0.1` and
accepts every request unauthenticated. Always configure API keys before exposing
the service beyond loopback. See [Security](/docs/security) for the full network
exposure checklist.
:::

## Get recommendations for a user

`:recommend` takes a `user_id` and an optional `limit` (1–1000, default 10) and
returns items ordered by descending `score`:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u1", "limit": 10}' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "items": [
    {"item_id": "item-42", "score": 0.91, "title": "Example Item", "category": "books"},
    {"item_id": "item-17", "score": 0.84}
  ]
}
```

Each item always carries `item_id` and `score`; any extra fields (like `title`
and `category` above) come from the recipe's `item_metadata` block. If the
`user_id` was never seen during training, the endpoint returns `404` with code
`UNKNOWN_USER` — this is expected for new users, and your application should
handle it, for example by falling back to popularity-based recommendations.

## Find related items

`:recommend-related` answers "customers who viewed this also viewed" from one or
more seed items:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:recommend-related \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{"seed_items": ["item-42"], "limit": 5}' | jq .
```

The response has the same shape as `:recommend`. If none of the seed items are
known to the model you get a `404` with `UNKNOWN_SEED_ITEMS`.

## Recommend for many users at once

For homepage precomputation or email campaigns, `:batch-recommend` takes up to
256 per-user requests in a single call and returns a result array that preserves
input order via an `index` field:

```bash
curl -s -X POST http://localhost:8080/v1/recipes/purchase_log:batch-recommend \
  -H "X-API-Key: <plaintext>" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"user_id": "u1", "limit": 5},
      {"user_id": "u2", "limit": 5}
    ],
    "include_metadata": false
  }' | jq .
```

```json
{
  "request_id": "a1b2c3d4e5f6",
  "recipe": "purchase_log",
  "model_version": "sha256:a3f2...e91d",
  "results": [
    {
      "index": 0,
      "status": "ok",
      "items": [{"item_id": "item-42", "score": 0.91}]
    },
    {
      "index": 1,
      "status": "error",
      "error": {"code": "UNKNOWN_USER", "message": "user not seen during training"}
    }
  ]
}
```

A per-user failure (like an unknown user) does not fail the whole batch — that
element carries `status: "error"` and the rest are still processed. Set
`include_metadata: true` to get the same metadata-joined item shape as the
single-user endpoint. The `requests` array holds 1–256 elements and the sum of
all `limit` values must not exceed 5000.

## A Python client

Here is a small `requests` client that calls `:recommend` and handles the
expected `UNKNOWN_USER` case:

```python
import requests

BASE = "http://localhost:8080"
API_KEY = "<plaintext>"  # from `recotem keygen --type api`


def recommend(user_id: str, limit: int = 10) -> list[dict]:
    resp = requests.post(
        f"{BASE}/v1/recipes/purchase_log:recommend",
        headers={"X-API-Key": API_KEY},
        json={"user_id": user_id, "limit": limit},
        timeout=5,
    )
    if resp.status_code == 404:
        # UNKNOWN_USER: new user not seen during training.
        # Fall back to a popularity list, editorial picks, etc.
        return []
    resp.raise_for_status()
    return resp.json()["items"]


for item in recommend("u1"):
    print(item["item_id"], item["score"])
```

Trim any whitespace from the key before sending — leading or trailing spaces in
`X-API-Key` are treated as part of the key and will not match.

## Deploy it

The server ships as a single Docker image. In production you typically run one
long-lived `serve` container and a scheduled `train` job that share an artifact
volume:

```bash
docker run --rm \
  -p 8080:8080 \
  -v recotem_artifacts:/workspace/artifacts:ro \
  -v /opt/recotem/recipes:/recipes:ro \
  -e RECOTEM_SIGNING_KEYS="${RECOTEM_SIGNING_KEYS}" \
  -e RECOTEM_API_KEYS="${RECOTEM_API_KEYS}" \
  -e RECOTEM_HOST="0.0.0.0" \
  ghcr.io/codelibs/recotem:latest \
  serve --recipes /recipes/
```

The full Compose walkthrough, image-tag policy, and volume-permission notes are
in the [Docker deployment guide](/docs/deployment/docker). Recotem does not
terminate TLS or rate-limit requests itself — front it with a reverse proxy
(nginx, Caddy, or a cloud load balancer) for TLS and per-IP quotas, as described
in [Security](/docs/security).

## Hot-swap and model versions

The serving process watches the artifact directory and **hot-swaps** to a new
model when `recotem train` writes one — no restart, no dropped requests. The
poll interval is `RECOTEM_WATCH_INTERVAL` (default 5 s). Combined with the recipe
`output.versioning: append_sha` mode, each train run writes a new
content-addressed artifact and atomically flips a pointer file, so the swap is
all-or-nothing.

Every recommendation response tells you exactly which model answered it:

- The `model_version` field in the body (a `sha256:<64-hex>` digest of the
  artifact).
- The `X-Recotem-Model-Version` response header, which mirrors it.

Log or capture this value so you can correlate served recommendations with a
specific training run — useful for A/B analysis and for confirming a hot-swap
actually took effect.

## Next steps

- [Serving API reference](/docs/serving-api) — every endpoint, field, and error code.
- [Security](/docs/security) — authentication, network exposure, and the reverse-proxy checklist.
- [Docker deployment](/docs/deployment/docker) — production compose, image tags, and the shared artifact volume.
- [Recipe Reference](/docs/recipe-reference) — the `output` and `item_metadata` fields that shape API responses.
- [Product Recommendations from GA4 + BigQuery](/learn/use-cases/ga4-bigquery) — the pillar use case that produces the model you serve here.
- Back to [Learn Recotem](/learn/).
