import { IgnoreMode } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as cdk from "aws-cdk-lib";

export type BackendProps = {
  cluster: ecs.ICluster;
  service: string;
  healthCheckPath: string;
  containerEnvironment?: { [key: string]: string };
  containerSecrets?: { [key: string]: ecs.Secret };
  inlineRolePolicies?: iam.RoleProps["inlinePolicies"];
  vpc: ec2.IVpc;
};

export class Backend extends Construct {
  public readonly service: ecs.FargateService;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: BackendProps) {
    super(scope, id);

    const { cluster, inlineRolePolicies = {}, vpc } = props;

    const transmitterSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "liquidator-secret",
      "frax-liquidator/config"
    );

    // Create a security group for the services
    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      "ServiceSecurityGroup",
      {
        vpc,
        description: "Security group for liquidator services",
        allowAllOutbound: true,
      }
    );

    // Create namespace for service discovery
    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "MonitoringNamespace",
      {
        name: "monitoring.local",
        vpc,
      }
    );

    // Create roles for the services
    this.role = new iam.Role(this, `${id}-role`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
      inlinePolicies: {
        ...inlineRolePolicies,
      },
    });

    const taskDefinition = new ecs.TaskDefinition(this, "api", {
      family: props.service,
      compatibility: ecs.Compatibility.EC2_AND_FARGATE,
      cpu: "1024",
      memoryMiB: "2048",
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole: this.role,
    });

    taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [transmitterSecret.secretArn],
      })
    );

    const image = ecs.ContainerImage.fromAsset("./", {
      file: "Dockerfile",
      buildArgs: {
        SERVICE: props.service,
      },
      ignoreMode: IgnoreMode.DOCKER,
    });

    // Add main application container with metrics endpoint
    const mainContainer = taskDefinition.addContainer(`${id}-backend`, {
      image,
      memoryLimitMiB: 2048,
      environment: {
        ...props.containerEnvironment,
        REDIS_PASSWORD: "redis1234567890",
        DATASTREAMS_HOSTNAME: "https://api.testnet-dataengine.chain.link",
        DATASTREAMS_WS_HOSTNAME: "wss://ws.testnet-dataengine.chain.link",
        DATASTREAMS_CLIENT_ID: "0166ae4d-fee2-4450-bb32-bfde7cb23cec",
        DATASTREAMS_CLIENT_SECRET: "TZ!0Du2p@E!j&LCE_uSdY5h3Zy@wTxNMmeRlPGbcF12L!lPKEiL>L163^KD8*AQDy#@-6G)EoaNer7ax557grEPB3Y7Rc<2DW9mi<Z@ChYLfOEi?2+J2X#ZM19x57Ab2",
        HEALTH_PORT: "8081",
        DATASTREAMS_WS_RECONNECT_ENABLED: "true",
        DATASTREAMS_WS_RECONNECT_MAX_ATTEMPTS: "10000",
        DATASTREAMS_WS_RECONNECT_INTERVAL: "5000",
        DATASTREAMS_WS_RECONNECT_STALE_INTERVAL: "60000",
      },
      secrets: {
        PRIVATE_KEY: ecs.Secret.fromSecretsManager(
          transmitterSecret,
          "PRIVATE_KEY"
        ),
      },
      command: [
        "/bin/sh",
        "-c",
        "npm start",
      ],
      portMappings: [{ containerPort: 3000 }, { containerPort: 3001 }],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "hypurr-transmitter-backend",
        logRetention: logs.RetentionDays.THREE_DAYS,
      }),
      essential: true,
    });

    // Create the main service with service discovery
    this.service = new ecs.FargateService(this, `${id}-service`, {
      cluster: cluster,
      serviceName: "hypurr-transmitter",
      taskDefinition: taskDefinition,
      securityGroups: [serviceSecurityGroup],
      assignPublicIp: false,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      desiredCount: 1,
      circuitBreaker: {
        rollback: false,
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      cloudMapOptions: {
        name: "hypurr-transmitter",
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });
  }
}
