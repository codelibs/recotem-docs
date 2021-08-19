# EC サイトデータによるチュートリアル

このチュートリアルでは、とあるファッション EC サイトの購買ログ（ダミーデータ）を用いて、
recotem の基本的な用法である

- 学習データの形式の指定
- パラメータ調整ジョブの作成
- 推薦アルゴリズムの妥当性の確認

を学んでいきます。

## データの準備

このチュートリアルで使用するデータを<a href="https://github.com/codelibs/recotem/releases/download/v0.1.0.alpha4/purchase_log.csv" download="purchase_log.csv" >こちら</a>からダウンロードします。 このデータは「どのユーザーがどの商品を購入したか」という情報を記録するシンプルな履歴データです:

| user_id | item_id |
| ------- | ------- |
| 1       | 49      |
| 1       | 69      |
| 2       | 21      |
| 2       | 57      |

## Recotem へのログイン

[http://localhost:8000](http://localhost:8000)にアクセスすると、以下のような画面で認証を求められます。[前項](./installation)でのインストールの直後は、

- ユーザー名: `admin`
- パスワード: `very_bad_password`

によってログインすることができます。

<img src="../../../guide/tutorial/1.input-login-info.png" width="70%">

ユーザー情報を入力したら"Login"ボタンをクリックします。初期状態では、以下のような画面に遷移します。"Create"と書かれたタブをクリックします。
<img src="../../../guide/tutorial/2.project-top.png">

## プロジェクトの作成

Recotem を使うにあたって、最初に必要なのは「プロジェクト」と呼ばれる単位です。同じプロジェクト内では、複数のデータを扱うことができますが、データの形式は同一であることが求められます。

今回使用するデータの形式は以下のようなものでした。

| user_id | item_id |
| ------- | ------- |
| 1       | 49      |
| 1       | 69      |
| 2       | 21      |

ユーザーを表す列名はそのまま"user_id", アイテムは"item_id"ですから、その通り入力します:

<img src="../../../guide/tutorial/3.fill-project-info.png">

"Create new project"をクリックすると、下のようなプロジェクトのトップ画面に異動します。

<img src="../../../guide/tutorial/4.empty-project-top.png">

"Start upload -> tuning" をクリックします。

## データのアップロード

以下のような画面に移動しました。

<img src="../../../guide/tutorial/5.file-input.png">

推薦システムプロジェクトを始めるには、まずは学習データがなければなりませんので、アップロードしてきます。赤い枠のファイル入力欄をクリックすると、ファイル選択画面が現れるので、適宜先ほどダウンロードした`purchase_log.csv`を選択してください。

<img src="../../../guide/tutorial/6.file-selection-done.png">

上の図のように、学習データが選択されると、"Upload"ボタンをクリックすることができるようになりますので、クリックして次に進みます。

## パラメータ調整ジョブとモデルの作成

## 推薦結果の妥当性の確認
