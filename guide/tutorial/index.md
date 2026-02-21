# Tutorial

In this tutorial, we will use dummy purchase log data for a fashion e-commerce site to learn the basic workflow of Recotem. We will walk through the full process from data upload to model tuning, training, deployment, and calling the recommendation API.

## 1. Data Preparation

Download the purchase log data `purchase_log.csv` that we will use in this tutorial from <a href="https://raw.githubusercontent.com/codelibs/recotem/refs/tags/v1.0.0/frontend/e2e/test_data/purchase_log.csv" download="purchase_log.csv">this link</a>. This data is a simple log that records "who purchased which item":

| user_id | item_id |
| ------- | ------- |
| 1       | 49      |
| 1       | 69      |
| 2       | 21      |
| 2       | 57      |

## 2. Login

When you access [http://localhost:8000](http://localhost:8000), a login screen will appear. Right after [installation](../installation), you can log in with the following credentials:

- Username: `admin`
- Password: `very_bad_password`

Enter the credentials and click the "Login" button.

## 3. Create a Project

After logging in, the project selection screen is displayed. Click the "New Project" button to create a new project.

In Recotem, a "project" is the fundamental unit for data management. All data within a single project must share the same column structure.

Since our data has `user_id` and `item_id` columns, enter the following:

- **Project name**: Any name (e.g., `fashion-ec`)
- **User column**: `user_id`
- **Item column**: `item_id`

Click "Create" to create the project.

## 4. Upload Data

Once on the project screen, navigate to the Data Management page from the sidebar and click the "Upload" button. Select the `purchase_log.csv` file you downloaded earlier and upload it.

## 5. Tuning Wizard

After uploading the data, start tuning. Navigate to the Tuning page from the sidebar and follow the 4-step wizard.

### Step 1: Select Data

Select the training data to use for tuning. Choose the `purchase_log.csv` you just uploaded and proceed.

### Step 2: Split Config

Configure how to split the training data into train/validation sets. Leave the default values and click "Continue".

### Step 3: Evaluation Config

Configure the evaluation metric and recommendation count. Leave the default values and click "Continue".

### Step 4: Run

Configure the algorithm types and number of trials to explore. Leave the default values and click "Start the job".

## 6. Review Tuning Results

Once the job starts, you will be navigated to the tuning job detail screen. You can monitor progress in the Logs panel.

When the job completes, the explored algorithms and parameters are displayed in the "Results" panel. Each row shows performance metrics (NDCG, etc.) and parameters. The best model configuration is automatically saved.

## 7. Train a Model

The optimal model configuration is automatically created from the tuning results. Navigate to the Model Training page from the sidebar, select the model configuration, and click "Train" to start training with all data.

Once training completes, the trained model is added to the model list.

## 8. Create a Deployment Slot

To serve a trained model as a recommendation API, create a deployment slot.

Navigate to the Deployment Slots page from the sidebar and click "Create Slot". Enter a slot name, select the model you just trained, and save.

## 9. Create an API Key

To call the recommendation API, you need an API key with the `predict` scope.

Navigate to the API Keys management page from the sidebar and click "Create API Key". Enter a name, select the `predict` scope, and create the key.

::: warning
The API key is displayed only at creation time. Be sure to copy it and store it in a safe place.
:::

## 10. Call the Recommendation API

With the API key and deployment slot ready, you can call the recommendation API.

### Single-user Recommendations

```bash
curl -X POST http://localhost:8000/inference/predict/project/{project_id} \
  -H "Content-Type: application/json" \
  -H "X-API-Key: {your_api_key}" \
  -d '{"user_id": "1", "n_recommendations": 10}'
```

Replace `{project_id}` with your project's ID and `{your_api_key}` with the API key you created.

The response returns a list of recommended item IDs in JSON format:

```json
{
  "user_id": "1",
  "recommendations": ["42", "15", "78", "3", "91", "27", "56", "8", "64", "33"],
  "model_id": 1,
  "slot_name": "default"
}
```

You have now completed the basic Recotem workflow --- data upload, tuning, training, deployment, and API call.
