import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";

import { Backend } from "./constructs/backend";

export interface APIProps extends cdk.StackProps {
  cluster: ecs.ICluster;
  policies?: iam.RoleProps["inlinePolicies"];
  vpc: ec2.IVpc;
}

export class Transmitter extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: APIProps) {
    super(scope, id, props);

    const { cluster } = props;

    new Backend(this, "hypurr-transmitter", {
      cluster,
      service: "transmitter",
      inlineRolePolicies: props.policies,
      healthCheckPath: "/health",
      vpc: props.vpc,
    });
  }
}
