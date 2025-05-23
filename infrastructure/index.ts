import { App } from "aws-cdk-lib";
import { Cluster } from "./shared/cluster";
import { Transmitter } from "./transmitter";

const app = new App();

const cluster = new Cluster(app, "imported-hypurr-liquidator-cluster", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new Transmitter(app, "hypurr-transmitter", {
  cluster: cluster.cluster,
  vpc: cluster.vpc,
  policies: {},
});
