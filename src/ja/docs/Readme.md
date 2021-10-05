# 各コンテナの役割

Recotem には以下のコンテナが存在します。

- db
  - PosgreSQL データベース用のコンテナです。ユーザやプロジェクトの情報は全て`db`に保存されます。
- backend
  - web API を提供するコンテナです。
- celer_worker
  - チューニングやモデルの訓練を実行するためのコンテナです。
- queue
  - `backend` と `celery_workerq の通信のためのメッセージブローカであり、rabbitmq イメージを用います。
- frontend
  - Web UI のための HTML & Javascript & css をサーブするコンテナです。
- proxy
  - backend と frontend の通信のため、reverse proxy を行うコンテナです。

各々のコンテナが協働するのに必要な環境変数は、[recotem 本体](https://github.com/codelibs/recotem)の `envs/production.env` ファイルにおけるコメントを参照してください。
