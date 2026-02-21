# Model Configuration View

A Model Configuration stores the combination of a recommendation algorithm and its hyperparameters. Model configurations are automatically generated from tuning job results, but can also be created manually.

![Model configuration list](../../../ja/docs/user/model-config/model-config.png)

## Viewing Model Configurations

The list displays the following information:
- **Name** --- Identifier for the model configuration
- **Algorithm** --- The recommendation algorithm used (IALS, SLIM, RP3beta, etc.)
- **Source** --- Auto-generated from a tuning job or manually created
- **Created at** --- Creation date and time

Click a row to view its details:

![Model configuration detail](../../../ja/docs/user/model-config/model-config-detail.png)

## Using Model Configurations

Model configurations are selected when training models in the [Start Training View](../start-training/). You can use the same model configuration to create multiple models (with different datasets or time periods).

::: tip
If you enable the "Train a model using the full data" option when running a tuning job, a model configuration is automatically generated and a model is trained upon tuning completion.
:::
