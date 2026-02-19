# Building the image

In recotem, there are three images(`backend`, `celery_worker`, and `frontend` described in [container introduction](./)) that need to be built. These images can be built as follows:

1.  Clone recotem's source from [Github](https://github.com/codelibs/recotem).
2.  In the cloned directory, do the following

    ```
    docker-compose build
    ```

Recotem manages pre-built docker images for each release in the [Github Container Registry](https://github.com/orgs/codelibs/packages?repo_name=recotem).
