# 各コンテナの役割

Recotem には以下の 7 つのコンテナが存在します。

- **db** --- PostgreSQL 17 データベース。ユーザー、プロジェクト、モデル情報をすべて管理します。
- **redis** --- Redis 7。Celery ブローカー（db0）、Channels（db1）、キャッシュ（db2）、モデルイベント（db3）に使用します。
- **backend** --- Django 5.1 + Django REST Framework + Django Channels。Daphne（ASGI）で動作し、管理 API および WebSocket エンドポイントを提供します。
- **worker** --- Celery ワーカー。チューニングやモデル学習などの非同期タスクを実行します。backend と同じ Docker イメージを使用します。
- **beat** --- Celery Beat。定期再学習のスケジューリングを担当します。
- **inference** --- FastAPI サービス。リアルタイム推薦 API（ポート 8081）を提供します。デプロイ済みモデルをメモリにキャッシュし、A/B ルーティングにも対応します。
- **proxy** --- Nginx + Vue 3 SPA。ポート 8000 で全サービスへのリバースプロキシを担当します。

環境変数の詳細については、[recotem 本体](https://github.com/codelibs/recotem)の `envs/.env.example` を参照してください。
