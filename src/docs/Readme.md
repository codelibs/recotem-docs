# Role of recotem containers

Recotem includes following Docker containers.

- db
  - PosgreSQL database. All information about user/project will be saved on `db`.
- backend
  - A container that provides web API.
- celer_worker
  - A container to execute tuning and training
- queue
  - A rabbit-mq message broker between `backend` and `celery_worker`
- frontend
  - Serves TML & Javascript & css.
- proxy
  - Reverse proxy which for the communication between `backend` and `frontend`.

We have to set several environment variables for these containers to cooperate. See the comments in `envs/production.env` file in [recotem](https://github.com/codelibs/recotem).
