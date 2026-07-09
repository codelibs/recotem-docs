---
title: How to Evaluate a Recommender System (Offline Evaluation)
description: Evaluate a recommender system with offline evaluation — pick train/test splits, avoid leakage and popularity bias, and read nDCG and Recall@K in Recotem.
---

# How to Evaluate a Recommender System (Offline Evaluation)

Before a recommendation model reaches production, you need a defensible answer
to one question: *is it actually good?* **Offline evaluation** answers it
without exposing users to an untested model. You hold out interactions the model
never saw during training, ask the model to predict them, and score how well the
recommended lists recover the held-out items. This page walks through the split
strategies, the pitfalls that quietly inflate your scores, how to read the
ranking metrics, and how Recotem runs an [Optuna](https://optuna.org/) search
against a real `metric`/`cutoff` and reports the winning `best_score`.

If you want the definitions and math behind the metrics themselves, read
[Recommender Metrics: nDCG, MAP, Recall@K](/learn/concepts/evaluation-metrics)
first. This page is the practical companion — *how* to run the evaluation and
read the result.

## Split your interactions: train, validation, test

Offline evaluation lives or dies on how you split the data. The model learns on
one slice and is scored on another slice it has never seen. Three strategies
dominate.

### Random hold-out

Hold out a random fraction of each user's interactions for scoring. It is the
simplest baseline and maximizes the amount of test signal per user, but it
ignores time: the model may be scored on an interaction that happened *before*
some of its training interactions. That is fine for static catalogs where order
does not matter, and it is Recotem's default (`split.scheme: random`).

### Leave-one-out

Hold out exactly one interaction per user — usually that user's **most recent**
one — and train on the rest. "Predict the next thing this user does" is the
question most recommenders are really asked in production, so leave-one-out is
intuitive and widely used in the literature. The downside is a tiny, high-variance
test set (one item per user), so scores wobble more between runs.

### Temporal (time-based) split

Pick a single cutoff timestamp. Everything **before** it is training data;
everything **at or after** it is the test set. This is the most honest simulation
of production, because the model is only ever trained on the past and scored on
the future — exactly how it will be deployed. It also surfaces concept drift that
a random split hides. The cost is that recent-only users may have no training
history and become cold-start cases.

::: tip How Recotem's split schemes map to these strategies
Recotem exposes three schemes in `training.split.scheme`:

- **`random`** — interactions held out uniformly at random per user (the random
  hold-out above). `time_column` is unused.
- **`time_user`** — for each user, the most recent `heldout_ratio` of that
  user's interactions (ranked by `time_column`) are held out. With a small
  `heldout_ratio`, this is the per-user "hold out the latest" idea behind
  leave-one-out.
- **`time_global`** — a single global cutoff at the `1 - heldout_ratio` quantile
  of `time_column`; every interaction at or after the cutoff is held out. This is
  the temporal split.

`time_user` and `time_global` require `schema.time_column`; omitting it is a
recipe error (exit 2). Full semantics are in the
[Recipe Reference](/docs/recipe-reference#training).
:::

A time-aware split for e-commerce or event data typically looks like this:

```yaml
schema:
  user_column: user_id
  item_column: item_id
  time_column: ts            # required for time_user / time_global

training:
  algorithms: [IALS, RP3beta, TopPop]
  metric: ndcg
  cutoff: 20
  split:
    scheme: time_user        # random | time_global | time_user
    heldout_ratio: 0.1        # fraction of interactions held out, in (0, 1)
    test_user_ratio: 1.0      # fraction of users included in the test split
    seed: 42
```

## Common pitfalls

A high offline score means nothing if the evaluation is rigged in the model's
favour. Two failure modes are so common they deserve their own callout.

### Data leakage

**Leakage** is any path by which information from the test set reaches the model
during training. It produces scores that look excellent offline and collapse in
production. The usual culprits:

- **Temporal leakage** — a random split lets the model train on interactions that
  happened *after* the ones it is scored on. If your recommender is meant to
  predict the future, evaluate with `time_user` or `time_global` so the training
  data is strictly earlier than the held-out data.
- **Duplicate interactions** — the same (user, item) pair in both train and test
  makes the task trivially easy. Recotem's [`cleansing.dedup`](/docs/recipe-reference#cleansing)
  (`keep_last` by default) collapses duplicate pairs before the split.
- **Pre-split feature engineering** — computing popularity, embeddings, or
  normalization statistics over the *whole* dataset (test included) leaks
  aggregate signal. Recotem sidesteps this because the split happens inside the
  training driver, before any model sees the data.

::: warning A random split can silently leak time
`split.scheme: random` is convenient but does not respect time order. If the
production task is "recommend what the user does next", a random split
over-reports quality. Prefer a temporal scheme (`time_user` / `time_global`) for
anything where recency matters.
:::

### Popularity bias

The easiest way to score well on a naive metric is to recommend whatever is most
popular to everyone. Popular items appear in many users' held-out sets, so a
pure-popularity model earns a deceptively decent Recall@K while delivering zero
personalization. Guard against it:

- **Keep a popularity baseline in the search.** Recotem's `TopPop` recommender
  *is* "recommend the most popular items". Include it in `training.algorithms` so
  every run reports the popularity floor — if a personalized algorithm cannot beat
  `TopPop`, the search will tell you.
- **Read the whole picture, not one number.** A model that only marginally beats
  `TopPop` on nDCG may not be worth deploying. Compare the winning `best_score`
  against the `TopPop` trials.
- **Consider a temporal split**, which reduces the popularity advantage because
  yesterday's hits are not always tomorrow's.

## Reading the metrics: nDCG and Recall@K

Ranking metrics score the top-`K` recommended items against a user's held-out
set. Two you will use constantly:

- **Recall@K** — of the items the user actually interacted with in the test set,
  what fraction appears in the top `K` recommendations? It answers *"did we find
  the relevant items?"* and ignores their order within the list. Range `0`–`1`,
  higher is better.
- **nDCG@K** (normalized Discounted Cumulative Gain) — like Recall@K, but rewards
  putting relevant items **higher** in the list, with a logarithmic position
  discount, then normalizes by the ideal ordering. It answers *"did we find the
  relevant items **and** rank them well?"* Range `0`–`1`, higher is better.

Use Recall@K when position within the list does not matter much (a large grid of
suggestions). Use nDCG@K when the top slots carry most of the value (a short "for
you" row where the first item gets the clicks). `K` is the `cutoff` you evaluate
at — set it to the real length of the list your UI shows. The full definitions,
the DCG/IDCG formula, and a worked example are in
[Recommender Metrics](/learn/concepts/evaluation-metrics).

## How Recotem evaluates: an Optuna search against your metric

You do not run the split, the scoring, or the model comparison by hand. Recotem's
training driver does all of it, driven entirely by the `training` block of your
[recipe](/docs/recipe-reference#training):

1. **Split** the cleaned interactions using `split.scheme` / `heldout_ratio` into
   a train part and a held-out validation part.
2. **Search.** For each algorithm in `algorithms`, Optuna samples hyperparameters
   (from each irspack recommender's built-in ranges) and runs `n_trials` trials
   total, sharing the budget across algorithms.
3. **Score.** Every trial trains on the train part and evaluates the held-out part
   with your chosen `metric` at `cutoff` — e.g. `metric: ndcg`, `cutoff: 20`
   computes nDCG@20.
4. **Select.** The trial with the highest metric wins. Its algorithm becomes
   `best_class`, its hyperparameters `best_params`, and its validation score
   `best_score`. Recotem then refits that configuration on the full data and
   writes a signed artifact.

The knobs that matter for evaluation quality:

| Field | Role in evaluation |
|-------|--------------------|
| `metric` | The score to optimize: `ndcg`, `map`, `recall`, or `hit`. Default `ndcg`. |
| `cutoff` | The `K` in Recall@K / nDCG@K — the evaluated list length. Default `20`. |
| `algorithms` | The candidate models. Keep `TopPop` in the list as a popularity floor. |
| `n_trials` | Optuna's total trial budget — more trials explore hyperparameters more thoroughly. |
| `split.scheme` | `random`, `time_user`, or `time_global` — see the pitfalls above. |
| `split.heldout_ratio` | Fraction of interactions held out for scoring. |

The search emits a `search_done` structured log event carrying `best_class`,
`best_score`, and `n_completed`, and the final `train_done` event repeats
`best_score` — both are useful for [alerting on training runs](/docs/operations#training-pipeline-events).

::: warning "All trials scored 0.0"
If every completed trial scores exactly `0.0`, `recotem train` exits 4 with
`code: zero_score`. It usually means the split produced an empty or near-empty
validation set — too few users/interactions, or a `cutoff` larger than the number
of items available. Try `split.scheme: random`, lower `split.heldout_ratio`, or a
smaller `cutoff`. See [Troubleshooting](/docs/operations#recotem-train-exits-4-with-zero-score).
:::

## Reading `best_score` from the artifact header

Every artifact records the evaluation result in its (HMAC-signed) header, so you
can read the score of a shipped model without deserializing it or re-running
training. `recotem inspect` verifies the header and prints it:

```bash
recotem inspect ./artifacts/purchase_history.recotem
```

```text
HMAC: OK  (kid=prod-2026-q3)
{
  "recipe_name": "purchase_history",
  "best_class": "IALSRecommender",
  "best_score": 0.1873,
  "metric": "ndcg",
  "cutoff": 20,
  "data_stats": {"n_rows": 128443, "n_users": 5120, "n_items": 3311},
  "trained_at": "2026-07-08T09:14:52Z",
  "recotem_version": "2.0.0"
}
```

Read `best_score` **together with** `metric` and `cutoff` — a bare `0.1873` is
meaningless without knowing it is nDCG@20. The header also carries `best_params`
(the winning hyperparameters) and `data_stats` (row/user/item counts), so you can
compare two training runs, confirm a retrain improved the score, or audit which
algorithm won — all from the signed header alone. The same values are exposed at
runtime on the authenticated `/v1/health/details` endpoint. `recotem inspect` is
safe on untrusted or corrupt files because the HMAC and size checks run before any
payload is touched; see the [Operations Runbook](/docs/operations#recotem-inspect-flags).

::: tip Offline score is a signal, not a verdict
A higher offline `best_score` is necessary but not sufficient. Metrics can be
gamed by popularity, and offline data cannot capture novelty, diversity, or how
users react to being recommended something. Treat offline evaluation as the gate
that decides *which* model is worth an online A/B test — not as the final word.
:::

## Next steps

- [Recommender Metrics: nDCG, MAP, Recall@K](/learn/concepts/evaluation-metrics) —
  the definitions, formulas, and worked examples behind the numbers above.
- [How to Build a Recommendation System in Python](/learn/how-to/build-in-python) —
  the end-to-end path from interactions to a served model that this page evaluates.
- [Recipe Reference](/docs/recipe-reference#training) — every `training`, `split`,
  `metric`, and `cutoff` field with types and defaults.
- [Operations Runbook](/docs/operations) — `recotem inspect`, the training
  pipeline events, and troubleshooting `zero_score` and `min_data_violation`.
- [Recommendations from Purchase Logs](/learn/use-cases/purchase-logs) — a concrete
  recipe with a `time_user` split you can adapt.
- Back to the [Learn hub](/learn/).
