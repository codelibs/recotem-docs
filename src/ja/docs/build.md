# イメージのビルド

recotem において、独自イメージが必要なのは、[コンテナ紹介](./)における `backend`, `celery_worker`, `frontend`の 3 つになります。
これらのイメージは、以下によってビルドすることができます。

1. recotem 本体を[Github](https://github.com/codelibs/recotem)よりクローンする。
2. クローンしたディレクトリで、以下を実行する
   ```
   docker-compose build
   ```

尚、recotem では、各リリースに対応するビルド済み docker イメージを、[Github Container Registry](https://github.com/orgs/codelibs/packages?repo_name=recotem)で管理しています。
