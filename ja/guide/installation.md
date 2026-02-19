# インストール

## Docker のインストール

Recotem は Docker として開発されているので、まずは 最新の Docker をインストールする必要があります。

Docker のインストールについては [Docker の公式ページ](https://docs.docker.com/get-docker/)を参照してください。

## recotem-docker による起動

### Windows

1. [最新のリリースページ](https://github.com/codelibs/recotem/releases/latest/)から"Docker resources to try out" と書かれた zip ファイルをダウンロードします。

   ![recotem compose download page](./download-recotem-compose.png)

1. ダウンロードしたファイル `recotem-compose-vx.y.z.zip` を展開します。
1. 2. で展開したフォルダ中には、更に"recotem-compose"というフォルダが含まれているので、"recotem-compose"の中に移動します。下のようなファイル・フォルダが含まれているはずです。![recotem-compose content](./recotem-compose-content.png)

1. 上の図で赤枠で囲った、`recotem-compose`(環境によっては `recotem-docker.bat` と表示される) をダブルクリックします。
   - Microsoft defender により警告が出る場合がありますが、「詳細情報」から「実行」を選択してください。
   - 初回はリソースのダウンロードのため、起動に時間を要します。

::: tip
手順 4. で発生しうる Microsoft Defender による警告が好ましくない場合、

- Windows Power Shell などを起動し、上のステップ 3 のディレクトリ(`recotem-compose`が存在するディレクトリ)に移動する
- ```
  docker-compose.exe up
  ```

とすれば、Microsoft Defender による警告なしで起動が可能です。
:::

### Linux & MacOS

1. [最新のリリースページ](https://github.com/codelibs/recotem/releases/latest/)から"Docker resources to try out" と書かれた zip ファイルをダウンロードします。

   ![recotem compose download page](./download-recotem-compose.png)

1. ダウンロードしたファイル `recotem-compose-vx.y.z.zip` を展開します。
1. ターミナルで 2. で展開したフォルダ中に移動し、以下を実行します。

```sh
docker-compose up
```

## Recotem へのアクセス

[http://localhost:8000](http://localhost:8000)へアクセスします。
下のようなログイン画面が現れれば正常に起動しています。チュートリアルへお進みください。

![initial login](./initial-login.png)
