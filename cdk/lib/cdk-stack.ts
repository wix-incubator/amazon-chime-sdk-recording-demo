import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { CfnAutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DefaultInstanceTenancy, SubnetFilter, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Code } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const prefix = 'RecorderV2';

    const vpcCidr = '10.193.0.0/16';

    const instanceType = 'c6a.xlarge';
    const asgMinSize = 1;
    const asgMaxSize = 10;

    const ecsContainerName = 'recording-container';
    const ecsTaskCpu = '4096';
    const ecsTaskMemory = '7700';
    const ecsContainerCpu = 4096;
    const ecsContainerMemoryLimit = 7700;
    const ecsContainerMemoryReservation = 7700;
    const ecsContainerLinuxSharedMemorySize = 2048;

    const recordingArtifactsBucket = `live-video-${this.account}-${this.region}-recordings`

    const vpc = new ec2.Vpc(this, `${prefix}VPC`, {
      cidr: vpcCidr,
      maxAzs: 2,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      defaultInstanceTenancy: DefaultInstanceTenancy.DEFAULT,
      natGatewaySubnets: {
        onePerAz: true,
        subnetFilters: [
          SubnetFilter.onePerAz()
        ],
        subnetType: ec2.SubnetType.PUBLIC,
      },
      subnetConfiguration: [
        {
          name: 'ingress',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'application',
          subnetType: SubnetType.PRIVATE_WITH_NAT,
          cidrMask: 24,
        },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, `${prefix}EC2SecurityGroup`, {
      vpc: vpc
    });
    securityGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(80), 'HTTP inbound');
    securityGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(22), 'SSH inbound');
    securityGroup.addIngressRule(securityGroup, ec2.Port.tcpRange(31000, 61000), 'ALB ports');

    const ec2Role = new iam.Role(this, `${prefix}EC2Role`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      path: '/',
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonECS_FullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess' },
      ],
      inlinePolicies: {
        'ecs-service': new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['ecs:CreateCluster', 'ecs:DeregisterContainerInstance', 'ecs:DiscoverPollEndpoint',
              'ecs:Poll', 'ecs:RegisterContainerInstance', 'ecs:StartTelemetrySession',
              'ecs:Submit*', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ecr:GetAuthorizationToken',
              'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'autoscaling:CreateOrUpdateTags'
            ],
            resources: ['*']
          })]
        })
      },
    });

    const logGroup = new logs.LogGroup(this, `${prefix}LogGroup`, {
      retention: RetentionDays.TWO_WEEKS,
    });

    const ecsCluster = new ecs.Cluster(this, `${prefix}ECSCluster`, {
      clusterName: `${prefix}ECSC`,
      vpc: vpc,
      containerInsights: true,
    });
    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash -xe' });
    const launchTemplate = new ec2.LaunchTemplate(this, `${prefix}EC2LaunchTemplate`, {
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      securityGroup: securityGroup,
      role: ec2Role,
      detailedMonitoring: true,
      userData: userData,
    });
    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, `${prefix}ManagedASG`, {
      vpc: vpc,
      launchTemplate: launchTemplate,
      minCapacity: asgMinSize,
      maxCapacity: asgMaxSize,
      groupMetrics: [autoscaling.GroupMetrics.all()],
      newInstancesProtectedFromScaleIn: true,
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });
    const autoScalingGroupLogicalId = this.getLogicalId(autoScalingGroup.node.defaultChild as CfnAutoScalingGroup);
    userData.addCommands(
      `echo ECS_CLUSTER=${ecsCluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_IMAGE_PULL_BEHAVIOR=prefer-cached >> /etc/ecs/ecs.config',
      'yum install -y aws-cfn-bootstrap',
      `/opt/aws/bin/cfn-signal -e $? --stack ${this.stackName} --resource ${autoScalingGroupLogicalId} --region ${this.region}`,
    );
    const capacityProvider = new ecs.AsgCapacityProvider(this, `${prefix}ECSCapacityProvider`, {
      autoScalingGroup: autoScalingGroup,
      enableManagedScaling: true,
      enableManagedTerminationProtection: true,
      targetCapacityPercent: 80,
    });
    ecsCluster.addAsgCapacityProvider(capacityProvider);

    const ecsTaskLogGroup = new logs.LogGroup(this, `${prefix}ECSTaskLogGroup`, {
      retention: RetentionDays.ONE_YEAR,
    });
    const ecsTaskDefinition = new ecs.TaskDefinition(this, `${prefix}ECSTaskDefinition`, {
      cpu: ecsTaskCpu,
      memoryMiB: ecsTaskMemory,
      compatibility: ecs.Compatibility.EC2,
      volumes: [
        { name: 'dbus', host: { sourcePath: '/run/dbus/system_bus_socket:/run/dbus/system_bus_socket' } }
      ],
    });
    const dockerImage = new DockerImageAsset(this, `${prefix}DockerImage`, {
      directory: '../'
    });
    const ecsLinuxParameters = new ecs.LinuxParameters(this, `${prefix}ECSLinuxParameters`, {
      sharedMemorySize: ecsContainerLinuxSharedMemorySize,
    });
    ecsTaskDefinition.addContainer(`${prefix}DockerContainer`, {
      containerName: ecsContainerName,
      cpu: ecsContainerCpu,
      memoryLimitMiB: ecsContainerMemoryLimit,
      memoryReservationMiB: ecsContainerMemoryReservation,
      essential: true,
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: ecsTaskLogGroup,
        streamPrefix: ecsContainerName,
      }),
      linuxParameters: ecsLinuxParameters,
    });

    const lambdaFunctionRole = new iam.Role(this, `${prefix}LambdaFunctionRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonECS_FullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess' },
      ],
    });
    const lambdaFunction = new lambda.Function(this, `${prefix}LambdaFunction`, {
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: Duration.seconds(300),
      memorySize: 3008,
      description: 'Lambda to interact with ECS for starting and stopping recording.',
      handler: 'index.handler',
      role: lambdaFunctionRole,
      environment: {
        'ecsClusterArn': ecsCluster.clusterArn,
        'ecsContainerName': ecsContainerName,
        'ecsTaskDefinitionArn': ecsTaskDefinition.taskDefinitionArn,
        'recordingArtifactsBucket': recordingArtifactsBucket,
      },
      code: Code.fromAsset('../lambda/'),
    });
    lambdaFunction.node.addDependency(capacityProvider);
    const lambdaFunctionUrl = new lambda.FunctionUrl(this, `${prefix}LambdaFunctionURL`, {
      function: lambdaFunction,
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    lambdaFunction.addPermission(`${prefix}FunctionURLInvocation`, {
      action: 'lambda:InvokeFunctionUrl',
      principal: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    new cdk.CfnOutput(this, `${prefix}FunctionUrl`, {
      value: lambdaFunctionUrl.url
    });

    const user = new iam.User(this, `${prefix}FunctionInvokeUser`);
    user.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunctionUrl'],
      resources: [lambdaFunction.functionArn],
    }));
    const userCredentials = new iam.AccessKey(this, `${prefix}FunctionAccessKey`, { user: user, serial: 1 });
    const secretValue = new cdk.SecretValue(userCredentials.secretAccessKey.toString());
    const secret = new secretsmanager.Secret(this, `${prefix}FunctionAccessKeySecret`, {
      secretStringValue: secretValue,
    });
    new cdk.CfnOutput(this, `${prefix}FunctionAccessKeySecretArn`, {
      value: secret.secretArn
    });
    new cdk.CfnOutput(this, `${prefix}FunctionAccessKeyId`, {
      value: userCredentials.accessKeyId
    });
  }
}
