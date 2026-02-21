# インストール

## Docker のインストール

Recotem は Docker で動作します。まずは [Docker の公式ページ](https://docs.docker.com/get-docker/) から Docker をインストールしてください。

## Recotem の起動

### リポジトリのクローン

```bash
git clone https://github.com/codelibs/recotem.git
cd recotem
```

### 起動

```bash
docker compose up -d
```

初回起動時はイメージのダウンロードとビルドのため時間がかかります。

### Recotem へのアクセス

[http://localhost:8000](http://localhost:8000) へアクセスします。下のようなログイン画面が表示されれば正常に起動しています。

初期ログイン情報:

- ユーザー名: `admin`
- パスワード: `DEFAULT_ADMIN_PASSWORD` 環境変数の値（デフォルト: `very_bad_password`）

![ログイン画面](./login.png)

### 停止

```bash
docker compose down
```
