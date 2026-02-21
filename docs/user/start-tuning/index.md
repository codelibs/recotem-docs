# Tuning Configuration View

In this view, you can configure a tuning job across four tabs:

1. **Data** --- Select the training data
2. **Split Config** --- Configure the train/validation split
3. **Evaluation Config** --- Configure evaluation metrics
4. **Run** --- Configure and start the tuning job

## 1. Data --- Select Training Data

Select the uploaded training data:

![Data tab](../../../ja/docs/user/start-tuning/start-tuning.png)

## 2. Split Config --- Data Splitting

Specify how to split the training data into training and validation sets.

Select "Use default values" to use the defaults:

![Split Config (default)](../../../ja/docs/user/start-tuning/split-config-default.png)

Select "Manually Define" for advanced settings:

![Split Config (manual)](../../../ja/docs/user/start-tuning/split-config-manually-define.png)

Configuration options:
- **Ratio of test users** --- What percentage of users will have their data split into train/validation sets. Ignored if `Number of test users` is set.
- **Number of test users** --- How many users will have their data split into train/validation sets.
- **Ratio of held-out interactions** --- What percentage of each test user's interactions will be used for validation. Ignored if `Number of held-out interactions per user` is set.
- **Number of held-out interactions per user** --- How many items per test user will be used for validation data.
- **Random seed** --- Random seed for the split.

## 3. Evaluation Config --- Evaluation Metric Settings

Configure which evaluation metric to optimize. Select "Use default values" to use the defaults:

![Evaluation Config (default)](../../../ja/docs/user/start-tuning/evaluation-config-default.png)

Select "Manually Define" for detailed settings:

![Evaluation Config (manual)](../../../ja/docs/user/start-tuning/evaluation-config-manually-define.png)

- **Target metric** --- Choose from four metrics: NDCG, MAP, Recall, and Hit.
- **Cutoff** --- How many top-ranked items to use for calculating the metric.

## 4. Run --- Tuning Job Settings

Configure the tuning job execution parameters:

![Run (default)](../../../ja/docs/user/start-tuning/training-job-default.png)

Select "Manually Define" for detailed settings:

![Run (manual)](../../../ja/docs/user/start-tuning/training-job-manually-define.png)

- **Number of trials** --- How many parameter configurations to try.
- **Overall timeout** --- Overall timeout for the entire job.
- **Single step timeout** --- If a trial takes longer than this value (in seconds), force it to stop.
- **Rough memory budget** --- A rough upper limit on memory usage, allowing selection of less memory-intensive algorithms.
- **Number of Parallel tasks** --- How many parallel tasks to run.
- **Random seed** --- Random seed.
- **Algorithms** --- Select from the candidate algorithms: DenseSLIM, SLIM, IALS, AsymmetricCosineKNN, RP3beta, TopPop, TruncatedSVD.
- **Train a model using the full data** --- If checked, after tuning completes, a model will automatically be trained on all data using the best parameters.

Click **"START THE JOB"** to start the tuning job. You will be navigated to the [Tuning Job Detail View](../tuning-job-detail/).
