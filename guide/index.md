# Overview

Recotem is **"a recommendation engine for non-experts"**. It offers the following functionalities via a browser-based UI and REST API, covering the full lifecycle from model building to deployment and operations:

## Key Features

- **Automatic algorithm tuning** --- Uses Optuna and irspack to automatically search for the best recommendation algorithm and hyperparameters for your data.
- **Model training** --- Train models using tuned parameters and review evaluation metrics.
- **API key management** --- Issue and manage API keys with three scope levels: read, predict, and admin.
- **Deployment slots** --- Assign trained models to slots and serve them as a real-time recommendation API.
- **A/B testing and conversion tracking** --- Configure weighted slots for multiple models, record conversion events, and analyze results.
- **Scheduled retraining** --- Set up schedules for automatic model retraining with optional auto-deploy.
- **Dashboard** --- View summary statistics per project including model counts, tuning jobs, and deployment status.
- **User management** --- Administrators can create, edit, and disable user accounts.

Recotem is open-source software developed on GitHub, freely available under the Apache License 2.0.
