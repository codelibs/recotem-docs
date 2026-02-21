# Role of Recotem Containers

Recotem consists of the following 7 Docker containers:

- **db** --- PostgreSQL 17 database. Manages all user, project, and model information.
- **redis** --- Redis 7. Used for the Celery broker (db0), Channels (db1), cache (db2), and model events (db3).
- **backend** --- Django 5.1 + Django REST Framework + Django Channels. Runs on Daphne (ASGI) and provides the management API and WebSocket endpoints.
- **worker** --- Celery worker. Executes asynchronous tasks such as tuning and model training. Uses the same Docker image as the backend.
- **beat** --- Celery Beat. Handles scheduling for automatic model retraining.
- **inference** --- FastAPI service. Provides the real-time recommendation API (port 8081). Caches deployed models in memory and supports A/B routing.
- **proxy** --- Nginx + Vue 3 SPA. Serves as the reverse proxy for all services on port 8000.

For details on environment variables, refer to `envs/.env.example` in [the recotem repository](https://github.com/codelibs/recotem).
