---
layout: home

hero:
  name: Recotem
  text: Recommender system for non-experts
  tagline: A small config file is all you need. No machine-learning expertise required.
  image:
    src: /recotem-logo.png
    alt: Recotem
  actions:
    - theme: brand
      text: Getting Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/codelibs/recotem

features:
  - title: Easy to set up
    details: Describe your data and model in one small YAML file. The CLI handles fetching data, picking the best algorithm, training, and serving.
  - title: Friendly defaults
    details: Sensible defaults for splitting, evaluation, and hyperparameter tuning. Get from raw interactions to a working /predict endpoint in minutes.
  - title: Production-ready
    details: HMAC-signed model artifacts, automatic hot-swap on retrain, and ready-to-use Docker / Kubernetes / cron deployment patterns.
---
