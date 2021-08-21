# インストール (クイックスタート)

## Docker のインストール

Recotem は Docker として開発されているので、まずは Docker をインストールする必要があります。

Docker のインストールについては [Docker の公式ページ](https://docs.docker.com/get-docker/)を参照してください。

## recotem-docker による起動

### Windows

1. 起動用スクリプト[recotem-docker.bat](https://github.com/codelibs/recotem/releases/latest/download/recotem-compose.bat)をダウンロードします。
   - ブラウザによっては「この種のファイルはコンピュータに損害を与える可能性があります」との警告がでますが、そのまま保存して下さい。
1. ダウンロードした `recotem-docker.bat` をダブルクリックします。
   - Microsoft defender により警告が出る場合がありますが、「詳細情報」から「実行」を選択してください。
   - 初回はリソースのダウンロードのため、起動に時間を要します。

::: tip
ここで紹介した手順で発生しうる警告が好ましくない場合は、[ドキュメントのインストール手順](../docs/installation)に従ってください。
:::

### Linux & MacOS

1. 起動用スクリプト[recotem-docker.sh]をダウンロードします
1. コマンドラインから`sh recotem-docker.sh` で recotem-docker を起動します。

## Recotem へのアクセス

[http://localhost:8000](http://localhost:8000)へアクセスします。
下のようなログイン画面が現れれば正常に起動しています。チュートリアルへお進みください。
