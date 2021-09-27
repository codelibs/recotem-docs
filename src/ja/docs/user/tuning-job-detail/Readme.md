# チューニングジョブ詳細画面

この画面では、現在進行中あるいは完了済みのチューニングジョブの設定を確認したり、
チューニングの進行状況を知ることが出来ます。

![tuning-config](./tuning-job.png)

"Logs"と書かれたタブをクリックして、現時点までに完了しているジョブの試行を表示することが出来ます。

![tuning-log](./log-unfinished.png)

ジョブが正常に終了すると、"Results"と書かれたタブが出現します。それをクリックすると

- (あれば)チューニング結果を用いて作成されたモデルへのリンク
- 最適なパラメータでもって算出されたスコア値
- 最適なパラメータの詳細

が表示されます:

![tuning-result](./result.png)