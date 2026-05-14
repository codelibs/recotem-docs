---
layout: home

hero:
  name: Recotem
  text: 専門知識のいらない推薦システム
  tagline: 小さな設定ファイルがあれば、機械学習の専門知識がなくても推薦システムを構築できます。
  image:
    src: /recotem-logo.png
    alt: Recotem
  actions:
    - theme: brand
      text: 使ってみる
      link: /ja/guide/
    - theme: alt
      text: GitHub を見る
      link: https://github.com/codelibs/recotem

features:
  - title: 簡単にはじめられる
    details: データとモデルの設定を 1 つの小さな YAML ファイルに書くだけ。データ取得、最適なアルゴリズム選択、学習、配信まで CLI がすべて担当します。
  - title: ちょうど良いデフォルト
    details: データ分割、評価、ハイパーパラメータチューニングに、現実的なデフォルト値を用意しています。生のデータから動作する /predict エンドポイントまで数分です。
  - title: 本番運用に対応
    details: HMAC 署名されたモデルアーティファクト、再学習時の自動ホットスワップ、Docker / Kubernetes / cron 向けのデプロイパターンを標準で提供します。
---
