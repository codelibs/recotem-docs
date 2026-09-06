---
title: "E-commerce Product Recommendations: A Practical Guide"
description: "Where product recommendations belong on an e-commerce site — home, product page, cart, email — what data you need, how to measure lift, and how to ship one."
---

# E-commerce Product Recommendations: A Practical Guide

Product recommendations are the most proven personalization feature in
e-commerce: done well, they lift conversion, grow average order value, and put
the long tail of your catalog in front of shoppers who would never have
searched for it. They are also unusually accessible — the data they need is a
purchase log you already have.

This guide is the planning layer for an e-commerce recommendation project:
**where** recommendations belong on a store, **what data** feeds them, **how to
measure** whether they are working, and a concrete path to shipping one. When
you are ready to build, the hands-on companion is
[Recommendations from Purchase Logs](/learn/use-cases/purchase-logs), which
walks through training and serving against a real order log.

## Where recommendations fit on an EC site

Each placement answers a different shopper question, and — importantly — needs
a different kind of query from the engine.

### Homepage: "Recommended for you"

A personalized row for returning, identified shoppers, driven by their
purchase (and browsing) history. This is a **user-to-items** query: given
`user_id`, return top-N products, excluding what they already own. For
first-time and anonymous visitors, fall back to bestsellers or trending items
— a popularity list is the correct cold-start behavior, not a failure.

### Product detail page: "Customers who bought this also bought"

The highest-intent placement on the site. The shopper is examining a specific
product; showing its strongest co-purchase companions and substitutes captures
both cross-sell and comparison behavior. This is an **item-to-items** query
seeded by the product being viewed — it needs no shopper identity at all, so it
works for every visitor including anonymous ones. That is what makes the PDP
widget the usual best first placement: maximum coverage, clear intent.

### Cart and checkout: "Goes well with your order"

Seeded by the items in the basket, this placement targets attachment — the
cable for the camera, the filters for the coffee maker. Keep it to a few
accessory-priced items and exclude everything already in the cart. Tread
carefully at the final payment step: distraction there can cost more than the
attach revenue is worth, which is why measurement (below) matters.

### Post-purchase email and retention

"Based on your recent order" emails and win-back campaigns reuse the same
engine offline: generate recommendations for a batch of customers on a
schedule, feed them to your email platform. Because it runs in batch, this is
often the *easiest* first integration — no site changes at all, just a nightly
job and a merge field.

## What data you need

The non-negotiable input is an **interaction log**: rows of
`(customer_id, product_id, timestamp)`.

- **Purchase history** is the strongest signal — every completed order is a
  costly, unambiguous vote of interest. If you have only purchases, that is
  enough to start; "bought together" models are built from exactly this.
- **Browsing behavior** — product views, add-to-carts — is 10–100× more
  abundant and reaches shoppers who have not bought yet. If your analytics
  stack already collects it (GA4 does), it can widen coverage substantially:
  see [GA4 + BigQuery](/learn/use-cases/ga4-bigquery) for building directly
  from those events.
- **Ratings are not required.** Purchases and views are *implicit feedback*,
  and modern recommenders are built for it — see
  [Collaborative Filtering Explained](/learn/basics/collaborative-filtering)
  for why the absence of star ratings is not a blocker.

Practical data-quality notes from real order logs: use stable IDs (customer
account ID, SKU — beware losing guest checkouts to null IDs), de-duplicate
repeat purchases of the same SKU so subscription-like items do not drown the
signal, and keep timestamps so models can be evaluated on "what did this
customer buy *next*" rather than a random split. A few thousand orders across
a few hundred customers is already enough to beat a non-personalized baseline;
you do not need big-tech scale.

A **product catalog** file (SKU → title, category, image URL, stock status) is
the useful second ingredient — not for the model, but so API responses carry
display fields and so you can filter out-of-stock items before rendering.

## Measuring impact

Recommendations are a revenue feature, so measure them like one.

- **Engagement metrics** — impression → click-through rate (CTR) per widget,
  and attributed conversion: did a session that clicked a recommendation end
  in a purchase that included the recommended item? Track these per placement;
  a PDP widget and a homepage row perform very differently and should be
  judged separately.
- **Business metrics** — average order value and units per order for sessions
  that engaged with recommendations, revenue attributed to recommendation
  clicks, and share of catalog surfaced (long-tail exposure).
- **A/B test against a baseline.** The honest comparison is not
  "recommendations vs nothing" but "personalized model vs bestseller list".
  Randomize by visitor, hold placement and design constant, vary only the
  ranking source. Note that beating a bestseller list online is a **floor, not
  a justification** — offline it is cleared by models that lose to a 30-line
  item-item kNN ([Is the model any good?](/learn/basics/collaborative-filtering#is-the-model-any-good)).
- **Offline metrics guide, online metrics decide.** Training-time scores like
  nDCG and recall are for choosing between models before deployment. They do
  not guarantee revenue lift; the A/B test is the ground truth. Watch for
  cannibalization too — a cart widget that lifts its own CTR while lowering
  completed checkouts is a net loss.

## A concrete path with Recotem

[Recotem](/docs/) is an open-source (Apache-2.0), self-hosted way to ship
everything above without a data-science team or per-request SaaS fees. The
shape of the project:

1. **Export or point at your order log.** A CSV export of
   `(customer_id, sku, timestamp)` is enough; if orders live in PostgreSQL /
   MySQL or BigQuery, Recotem's [data sources](/docs/data-sources/) read them
   directly with no export step.
2. **Write a recipe.** One YAML file declares the source, column mapping,
   cleansing rules (dedup, null-ID handling, minimum-volume gates), the
   algorithms to try, and a time-based evaluation split. The
   [purchase-logs walkthrough](/learn/use-cases/purchase-logs) shows a
   complete, annotated e-commerce recipe.
3. **Train and serve.** `recotem train` runs a hyperparameter search across
   implicit-feedback algorithms (IALS, RP3beta, and friends, with a
   popularity baseline in the mix) and writes a signed model artifact;
   `recotem serve` exposes it over HTTP with API-key auth.
4. **Wire up the placements.** The API verbs map one-to-one onto the
   placements above:
   [`:recommend`](/docs/serving-api#post-v1-recipes-name-recommend) for the
   personalized homepage row,
   [`:recommend-related`](/docs/serving-api#post-v1-recipes-name-recommend-related)
   with `seed_items` for PDP and cart widgets (works for anonymous visitors),
   and `:batch-recommend` for the nightly email job. `exclude_items` hides
   products already owned or already in the cart, and an `item_metadata`
   block joins titles, categories, and image URLs into responses so the
   frontend can render directly.
5. **Retrain on a schedule.** Run `recotem train` nightly from cron or your
   scheduler; the serving process hot-swaps the new model with no restart or
   downtime. See [Operations](/docs/operations) for the production checklist.

Start with the PDP "also bought" widget (best coverage, no login required),
A/B test it against your current non-personalized widget, then expand to the
homepage row and email once the numbers justify it.

## Next steps

- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — the
  full hands-on build this guide plans for: recipe, cleansing, training,
  serving.
- [GA4 + BigQuery](/learn/use-cases/ga4-bigquery) — widen the signal with
  browsing events from Google Analytics 4.
- [Collaborative Filtering Explained](/learn/basics/collaborative-filtering) —
  the algorithms behind "customers who bought this".
- [Build vs Buy for Recommendation Engines](/learn/compare/build-vs-buy) — if
  you are still weighing SaaS against self-hosting.
- [Serving API](/docs/serving-api) — every endpoint your storefront will call.
- Back to the [Learn hub](/learn/).
