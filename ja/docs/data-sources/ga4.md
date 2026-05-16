---
title: GA4 ソース
---

# GA4 ソース

`ga4` ソースは [Google Analytics 4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1) から直接 Recotem の学習を実行できるようにします。BigQuery Export を経由しません。BQ Export を有効にしていないプロパティ向けです。

動作する出発点としては recotem リポジトリの `examples/ga4-data-api/` を参照してください。

BQ Export が**有効**なプロパティでは通常 [BigQuery ソース](./bigquery) のほうが適しています — BigQuery はよりスケールし、イベントペイロード全体を扱えます。

## インストール

```bash
pip install "recotem[ga4]"
```

このエクストラなしで `recotem train` を実行すると、以下のメッセージで終了します:

```
DataSourceError: google-analytics-data is required for GA4Source. Install with: pip install 'recotem[ga4]'
```

## 認証

Application Default Credentials (ADC) のみ。レシピに認証情報を埋め込みません。以下のいずれかを設定してください:

```bash
# ローカル開発
gcloud auth application-default login

# GKE — Pod のサービスアカウントを Google サービスアカウントにバインドする
# Workload Identity。環境変数の設定は不要。

# Cloud Run / Cloud Functions
# デプロイ時に --service-account=<sa>@<project>.iam.gserviceaccount.com

# サービスアカウントキーファイル (本番環境では非推奨)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

サービスアカウントには GA4 プロパティに対する `roles/analytics.viewer` が必要です。

## レシピ設定

```yaml
source:
  type: ga4
  property_id: "123456789"          # 数値のプロパティ ID。G-XXXX 形式の測定 ID ではない
  user_dimension: userPseudoId      # userPseudoId または userId
  item_dimension: itemId            # itemId | itemName | itemCategory
  time_dimension: date              # date | dateHour | dateHourMinute
  event_names: [purchase, view_item, add_to_cart]
  # lookback_days か (start_date + end_date) の正確に一方のみを指定:
  lookback_days: 90
  # start_date: "2026-01-01"
  # end_date:   "2026-05-01"
  max_rows: 1_000_000               # 必須
  weight_column: event_count
  api_timeout_seconds: 60
```

| フィールド | 必須 | デフォルト | 備考 |
|------------|------|-----------|------|
| `property_id` | yes | — | 数値のみ (`^\d+$`)。`G-XXXX` 形式の測定 ID では**ありません**。 |
| `user_dimension` | yes | — | `userId` を使うにはプロパティで User-ID 機能の設定が必要。`userPseudoId` はクッキーベースのデフォルト。 |
| `item_dimension` | no | `itemId` | GA4 のアイテムスコープのディメンション。 |
| `time_dimension` | no | `date` | 時刻バケットの粒度。`date` / `dateHour` / `dateHourMinute`。 |
| `event_names` | yes | — | 1〜50 個のイベント名。各値は `^[A-Za-z_][A-Za-z0-9_]{0,39}$` に一致。 |
| `lookback_days` | XOR | — | 1〜3650 日。プロパティのタイムゾーンにおける前日 (昨日) で終わるローリングウィンドウ。 |
| `start_date` / `end_date` | XOR | — | ISO 形式の日付。いずれかを設定する場合は両方必須。`start_date <= end_date`。 |
| `max_rows` | yes | — | 返却される行数のハードキャップ。有効範囲 `[1, 50_000_000]`。範囲外は `ValidationError`。 |
| `weight_column` | no | `event_count` | `eventCount` メトリックの出力 DataFrame カラム名。`schema.weight_column` と一致する必要があります。`user_dimension`、`item_dimension`、`time_dimension`、または `eventName` という値と衝突する値は拒否されます — 衝突するとディメンションが暗黙的に上書きされてしまうためです。 |
| `api_timeout_seconds` | no | `60` | 有効範囲 `[5, 600]`。範囲外は `ValidationError`。 |

::: warning 日付範囲の指定方式は正確に 1 つ
`lookback_days` を設定する**か**、`start_date` と `end_date` の両方を設定してください。両方の方式を設定したり、どちらも設定しなかった場合はレシピロード時に `ValidationError` が発生します。`lookback_days` はプロパティのタイムゾーンにおける直前の完了日 (つまり昨日、今日ではない) で終わるローリングウィンドウを生成します。
:::

## 行が DataFrame に到達する流れ

GA4 リクエストは 4 つのディメンションと 1 つのメトリックを要求します:

```
dimensions = [<user_dimension>, <item_dimension>, <time_dimension>, eventName]
metric     = eventCount
```

レスポンスはページング (ページサイズ 100,000) されます。各行はレシピのスキーマのカラム名で DataFrame の 1 行になります。内部の `eventName` カラムは `fetch()` がリターンする前に削除されるため、同じ `(user, item, time)` に対する複数のイベント種別は複数の行として現れます。

::: warning GA4 では `cleansing.dedup: none` を使用してください
GA4 ソースは `(user, item, time, eventName)` ごとに 1 行を返します。`keep_first` / `keep_last` は他のイベント種別の重みを破棄してしまいます。irspack は内部で重複する `(user, item)` の重みを集約するため、別々の行のままにしておくのが正しい挙動です。
:::

## クォータ、ページング、リトライ

- ページサイズ 100,000 (Data API のハード最大値)。
- フェッチャは `row_count` が枯渇するか、`max_rows` に到達するか、`RECOTEM_GA4_MAX_PAGES` (デフォルト 500) に達するまでループします。
- `RESOURCE_EXHAUSTED` / `UNAVAILABLE` の gRPC コードは `google.api_core.retry.Retry` 経由でリトライされます (初期 1 秒、最大 30 秒までの指数バックオフ、総バジェット = 3 × `api_timeout_seconds`)。
- `PERMISSION_DENIED` → 即座に `DataSourceError` を発生し、必要なロール (`roles/analytics.viewer`) とプロパティ ID をメッセージに含めます。
- その他の `GoogleAPICallError` サブクラス (例: `NOT_FOUND`、`INVALID_ARGUMENT`) → 即座に `DataSourceError` を発生し、API エラーのクラス名とメッセージを保持します。
- 1 回の取得あたりの実時間バジェット `10 × api_timeout_seconds` がページング処理全体を制限します。デッドラインは `run_report` 呼び出しの**前**と**後**の両方でチェックされるため、リトライバジェットを消費した不運なページが追加のリトライサイクル 1 つ分超過することはありません。

### バジェットの相互作用

ページごとの `Retry(timeout=3 × api_timeout_seconds)` バジェットは、最悪ケースでは発生まで 3× の待機時間をすべて消費する可能性があります。試行ごとの `timeout=api_timeout_seconds` と組み合わせると、最悪ケースで 1 ページが約 `3 × api_timeout_seconds` を消費する可能性があります。外側の 10× 実時間バジェットは意図的にサーキットブレーカーであり、緩い上限ではありません: 持続的な `RESOURCE_EXHAUSTED` の背圧下では、無制限に実行がドリフトすることを許さず、おおよそ 3 ページ消費した時点で中断します。ワークロードがより多くのリトライページを正当に必要とする場合はクエリを絞るか、`api_timeout_seconds` を上げてください (実時間バジェットも線形に増加します)。

## 環境変数

| 変数 | デフォルト | 備考 |
|------|-----------|------|
| `GOOGLE_APPLICATION_CREDENTIALS` | (未設定) | ADC キーファイルのパス。空 = デフォルトチェーン (`gcloud` ユーザー認証情報 → メタデータサーバー) を使用。 |
| `RECOTEM_GA4_MAX_PAGES` | `500` | ページングループのハード上限。クランプ範囲 `[1, 10_000]`。 |
| `RECOTEM_METRICS_ENABLED` | (未設定) | 真の値で `recotem_ga4_pages_fetched_total`、`recotem_ga4_rows_fetched_total`、`recotem_ga4_quota_remaining` の Prometheus メトリクスを公開 (`recotem[metrics]` が必要)。 |

## トラブルシューティング

| エラー | 想定される原因 | 対処 |
|--------|--------------|------|
| `google-analytics-data is required for GA4Source. Install with: pip install 'recotem[ga4]'` | エクストラ未インストール。 | `pip install "recotem[ga4]"` |
| `GA4 access denied for property ...` | サービスアカウントにロールが付与されていない。 | GA4 プロパティに `roles/analytics.viewer` を付与してください。 |
| `set exactly one of lookback_days OR (start_date + end_date)` | 両方または両方が未設定。 | どちらか一方を選択してください。 |
| `GA4 result exceeds max_rows=...` | 結果が本当に巨大。 | `event_names` を絞るかウィンドウを短くしてください。 |
| `GA4 fetch reached max_pages=<n> without seeing a short page; increase RECOTEM_GA4_MAX_PAGES or tighten the query` | プロパティがデフォルト上限に対して大きすぎる。 | クォータを確認の上で `RECOTEM_GA4_MAX_PAGES` を引き上げてください。 |

## 備考

- `recotem validate recipes/my_recipe.yaml` は学習開始前に ADC チェーンとレシピスキーマを検証します。実際の Data API リクエストは発行**しません** — プロパティのクォータは保持されます。
- 整数でない `eventCount` 値は生の `ValueError` (終了コード 1) ではなく `DataSourceError` (終了コード 3) として表面化します。
- `GOOGLE_*` および `GCP_*` 環境変数はレシピの `${...}` 展開からブラックリストされています。クラウド認証情報はレシピファイルではなく ADC から提供する必要があります。
