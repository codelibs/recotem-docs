---
title: "Recotem vs LightFM vs implicit: Python レコメンダー選び"
description: "レコメンド ライブラリ 比較。LightFM・implicit・irspack の違いと、学習からチューニング・配信までを担う Recotem の位置づけを解説します。"
---

# Recotem vs LightFM vs implicit: Python レコメンダー選び

**LightFM の代替**を探しているとき、あるいは **Python のレコメンドライブラリ**を
比較しているとき、最初に問うべきは「どのモデルが最良か」ではなく「パイプラインの
どこまでを自分で持ちたいか」です。LightFM と `implicit` は優れたモデルライブラリ
です。Recotem はモデルライブラリ（[irspack](https://github.com/tohtsky/irspack)）を、
データ読み込み・チューニング・配信 API でラップしたフレームワークです。このページ
では両者の違いを公平に整理し、適切なツールを選べるようにします。

## ライブラリ vs フレームワーク

**ライブラリ**はモデルを提供します。import して、あらかじめ用意した
「ユーザー × アイテム」の疎行列を渡し、`fit` を呼べば、ユーザーに対してアイテムを
スコアリングできるオブジェクトが得られます。その周辺 — データウェアハウスからの
抽出、アルゴリズムの選択とチューニング、評価、HTTP での予測公開 — は、すべて自分で
書いて運用するコードです。LightFM と `implicit` はこの意味でライブラリです。

**フレームワーク**は周辺のパイプラインを提供します。Recotem は 1 つの YAML レシピ
から全経路を実行します。ソースからデータを取得し、複数アルゴリズムのハイパーパラメータ
探索を行い、評価し、署名付きアーティファクトを生成します。付属サーバーはこれを
ホットロードして `POST /v1/recipes/{name}:recommend` として配信します。モデル本体は
irspack が担い、Recotem の役割はその両側にあるすべてです。

抽象的にどちらが「優れている」というものではありません。適切な選択は、どこまでの
配管を自分で作りたいかで決まります。

## 一覧比較

以下の表は、2 つのライブラリと、エンジンである irspack、そしてその上に構築された
フレームワークである Recotem を比較したものです。メンテナンス状況は時とともに
変化するため 2026-07 時点として記載しています。

| 観点 | LightFM | implicit | irspack | Recotem（irspack の上） |
|---|---|---|---|---|
| アルゴリズム | ハイブリッド行列分解（BPR / WARP / WARP-kOS / logistic 損失）。アイテム・ユーザーの副次特徴を利用可能 | iALS、BPR、Logistic MF、item-item KNN（cosine / TF-IDF / BM25） | IALS、KNN、RP3beta、DenseSLIM、TruncatedSVD、BPRFM、Mult-VAE | irspack のアルゴリズムをレシピごとに選択（IALS、CosineKNN、TopPop、RP3beta、DenseSLIM、TruncatedSVD、BPRFM） |
| ハイパーパラメータ調整 | 自前で用意（Optuna、グリッドサーチなど） | 自前で用意 | モデルごとに Optuna 探索と早期停止プルーニングを内蔵 | レシピ駆動の複数アルゴリズム Optuna 探索、アルゴリズム別の試行予算に対応 |
| 評価 | `precision_at_k`、`recall_at_k`、`auc_score`、逆順位 | `ranking_metrics_at_k`（precision、MAP、NDCG、AUC） | 高速な C++/Eigen のランキング指標（NDCG、MAP、recall、hit、precision） | irspack の評価を利用し、レシピの `metric` で最良試行を選択 |
| データ読み込み | 疎行列を自分で構築 | 疎行列を自分で構築 | 疎行列を自分で構築 | CSV / Parquet / BigQuery / SQL / プラグインをレシピで宣言 |
| 配信 | なし（サービスは自作） | なし（サービスは自作） | なし（学習用ライブラリ） | FastAPI エンドポイント、HMAC 署名アーティファクト、認証、ホットスワップ、バッチ |
| GPU 高速化 | CPU（Cython） | CPU + ALS/BPR に任意の CUDA カーネル | CPU（C++/Eigen） | CPU（C++/Eigen） |
| メンテナンス（2026-07 時点） | 最新 1.17（2023-03）。リリース頻度は低いがアーカイブ済みではない | アクティブ。最新 v0.7.3（2026-05） | アクティブ。最新 v0.5.2（2026-07） | アクティブ（本プロジェクト） |

## LightFM

[LightFM](https://github.com/lyst/lightfm) は Lyst 製のハイブリッド行列分解
ライブラリです。特徴は ID だけでなく**ユーザー・アイテムのメタデータ特徴**の埋め込み
を学習する点で、履歴の少ないユーザーやアイテムに対しても妥当な予測を返せる —
コールドスタート問題への部分的な答えになります。BPR、WARP、WARP-kOS、logistic の
各損失をサポートし、小さな評価モジュールも同梱します。

2026-07 時点で最新リリースは 1.17（2023-03）で、その前が 1.16（2020-11）です。
リポジトリはアーカイブされておらず issue も受け付けていますが、リリース頻度は低い
ため、活発に開発中というよりは**メンテナンスモードの成熟した安定ライブラリ**と捉える
のが適切です。副次特徴が問題の核心になるケースでは、LightFM は今も文書の充実した
有力な選択肢です。

補足として、irspack — したがって Recotem — は LightFM を直接利用できます。`BPRFM`
アルゴリズムは LightFM の BPR/WARP 行列分解を irspack がラップしたものです。つまり
Recotem を選んでも LightFM のモデルを手放すわけではなく、他のアルゴリズムと並べて
自動でチューニング・配信してもらえる、ということです。

## implicit

[`implicit`](https://github.com/benfred/implicit) は暗黙的フィードバック向けの
高速な協調フィルタリングライブラリです。交互最小二乗法（iALS）、Bayesian
Personalized Ranking、Logistic Matrix Factorization、item-item 近傍モデル
（cosine、TF-IDF、BM25）を実装します。学習は Cython と OpenMP でマルチスレッド化
され、ALS/BPR には任意の CUDA GPU カーネルがあるため、大規模な行列にもよくスケール
します。近似最近傍ライブラリ（Faiss、Annoy、NMSLIB）と連携して検索を高速化でき、
`ranking_metrics_at_k` の評価ヘルパも同梱します。

2026-07 時点でアクティブにメンテナンスされており、v0.7.3 が 2026-05 にリリースされ、
新しめの Python バージョンでのテストもされています。無駄のない高速なモデル部品が
欲しく、チューニング・評価・配信を自分で持つことを厭わないなら、`implicit` は
優れた選択肢です。とくに GPU 学習が重要な場合に向いています。

## irspack: Recotem の内部エンジン

[irspack](https://github.com/tohtsky/irspack) は Recotem が構築の土台とする
アルゴリズム・チューニング・評価のレイヤです。暗黙的フィードバック向けレコメンダー
の一群（IALS、複数の KNN 変種、RP3beta、DenseSLIM、TruncatedSVD、BPRFM、Mult-VAE）を
高速な C++/Eigen で実装し、早期停止プルーニング付きの **Optuna ベースのハイパーパラ
メータ最適化**、そして高速なランキング指標評価（NDCG、MAP、recall、hit）を提供します。
「万能なレコメンダーは存在しないので、複数アルゴリズムを試し、それぞれをチューニング
し、検証指標で決める」という前提を核にしています。

irspack 自体はライブラリです。ウェアハウスからデータを取得することも、予測を配信
することもしません。`IDMappedRecommender` は生のユーザー・アイテム ID を内部インデックス
に対応付け、実 ID で予測できるようにしますが、データソースや HTTP エンドポイントとの
接続は利用者に委ねられます。2026-07 時点で irspack はアクティブにメンテナンスされて
います（v0.5.2、2026-07）。Recotem 2.1.0 は irspack 0.5.2 を固定しています（Recotem
2.0.x は 0.4.2 でした）。

## Recotem の立ち位置: irspack の上で学習・調整・配信

Recotem の位置づけは明確です。**ライブラリはモデルを与え、Recotem は irspack の上で
学習・チューニング・配信を与える**、というものです。irspack をエンジンとして残し、
ライブラリが利用者に委ねる 3 つのレイヤを追加します。

1. **レシピ形式。** 1 つの YAML でデータソース、カラムマッピング、クレンジング規則、
   試すアルゴリズムの一覧、チューニング予算、出力を宣言します。全フィールドは
   [レシピリファレンス](/ja/docs/recipe-reference) を参照してください。
2. **レシピ駆動の探索。** モデルごとの Optuna チューニングは irspack が行い、Recotem は
   レシピの `training.algorithms` にわたる複数アルゴリズム探索を駆動し、アルゴリズム別
   の試行予算を尊重し、レシピの `metric` で最良モデルを選びます。ハイパーパラメータの
   範囲は irspack 側の各レコメンダーの既定値に由来します。
3. **配信 API。** 勝ち残ったモデルは HMAC 署名付きアーティファクトに書き出され、
   `recotem serve` がそれを検証して `POST /v1/recipes/{name}:recommend`（関連アイテム
   やバッチの各動詞も）として読み込みます。API キー認証とファイル mtime によるホット
   スワップにより、無停止で再学習できます。

最小のレシピでパイプライン全体を表現できます。

```yaml
name: news_articles
source:
  type: csv
  path: ./interactions.csv
schema:
  user_column: user_id
  item_column: item_id
training:
  algorithms: [IALS, CosineKNN, TopPop]
  metric: ndcg
  n_trials: 40
output:
  path: ./artifacts/news_articles.recotem
```

```bash
recotem train recipe.yaml
recotem serve --recipes ./artifacts/
```

トレードオフは 1 画面に収まります。ライブラリならデータ読み込み、探索ループ、評価
ハーネス、モデルを囲む Web サービスを自分で書くことになりますが、Recotem ではそれらが
設定になります。

## 生のライブラリが適しているとき

Recotem は方針を持ったツールであり、すべてのプロジェクトに合うわけではありません。
次のような場合は LightFM や `implicit` を直接使うほうが向いています。

- **モデルだけが欲しい。** 学習パイプラインと配信スタックが既にあり、そこに差し込む
  高速で検証済みのレコメンダーだけが必要な場合。
- **Recotem が公開していないアルゴリズムや機能が必要。** LightFM の豊富な副次特徴の
  埋め込みや、`implicit` の CUDA 高速化 ALS がまさに必要で、直接使って完全に制御したい
  場合。
- **モデルを研究・カスタマイズしたい。** ライブラリを直接使えば、サブクラス化や内部の
  検査など、レシピのフィールドではできない実験ができます。
- **統合先がノートブックやバッチジョブ**であり、常時稼働の HTTP サービスではない場合。
  Recotem の主要な価値である配信レイヤが使われないためです。

逆に、面倒に感じている作業が配管そのもの — BigQuery や SQL からのデータ取得、複数
アルゴリズムの公平な比較、認証付きでホットスワップ可能な予測 API の立ち上げ — であれば、
その配管こそ Recotem が irspack の上で提供するものです。

## 次のステップ

- [レシピリファレンス](/ja/docs/recipe-reference) — 学習・調整・配信を駆動する全
  フィールド。
- [ガイド](/ja/guide/) — Recotem を導入し、最初のモデルを end-to-end で学習する。
- [OSS レコメンドエンジン比較](/ja/learn/compare/open-source) — Gorse、RecBole、
  Merlin と Recotem の比較。
- [Recotem を学ぶ](/ja/learn/) — 実際のレコメンダーを作るためのタスク志向ガイド。
