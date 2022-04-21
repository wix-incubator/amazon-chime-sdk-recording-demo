import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
// import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { DefaultInstanceTenancy, SubnetFilter, SubnetType } from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const prefix = 'RecorderV2';

    const vpcCidr = '10.193.0.0/16';

    const instanceType = 'c6a.xlarge';
    const asgMinSize = 1;
    const asgDesiredCapacity = 2;
    const asgMaxSize = 10;

    const ecsContainerName = 'recording-container';
    const ecsTaskCpu = '4096';
    const ecsTaskMemory = '8192';
    const ecsContainerCpu = 4096;
    const ecsContainerMemoryLimit = 8192;
    const ecsContainerMemoryReservation = 8192;
    const ecsContainerLinuxSharedMemorySize = 2048;

    const recordingArtifactsBucket = `live-video-${this.account}-${this.region}-recordings`

    // const ecrDockerImageArn = '';
    // const availabilityZones = 
    // const azs = ['us-east-1d', 'us-east-1f'];

    const vpc = new ec2.Vpc(this, `${prefix}VPC`, {
      cidr: vpcCidr,
      // natGateways: 2,
      maxAzs: 2,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      defaultInstanceTenancy: DefaultInstanceTenancy.DEFAULT,
      natGatewaySubnets: {
        // availabilityZones: azs,
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
    // TODO: rewrite using Level-2 constructs once https://github.com/aws/aws-cdk/pull/19066 is GA'd
    const autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, `${prefix}ManagedASG`, {
      vpcZoneIdentifier: vpc.privateSubnets.map(x => x.subnetId),
      launchTemplate: { 
        launchTemplateId: launchTemplate.launchTemplateId, 
        version: launchTemplate.latestVersionNumber 
      },
      minSize: `${asgMinSize}`,
      desiredCapacity: `${asgDesiredCapacity}`,
      maxSize: `${asgMaxSize}`,
      metricsCollection: [ { granularity: '1Minute' } ],
      newInstancesProtectedFromScaleIn: true,
    });
    autoScalingGroup.cfnOptions.creationPolicy = {
      resourceSignal: { timeout: 'PT15M' }
    };
    autoScalingGroup.cfnOptions.updatePolicy = {
      autoScalingReplacingUpdate: {
        willReplace: true
      }
    };
    userData.addCommands(
      `echo ECS_CLUSTER=${ecsCluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_IMAGE_PULL_BEHAVIOR=prefer-cached >> /etc/ecs/ecs.config', 
      'yum install -y aws-cfn-bootstrap',
      `/opt/aws/bin/cfn-signal -e $? --stack ${this.stackName} --resource ${autoScalingGroup.logicalId} --region ${this.region}`,
    );
    const capacityProvider = new ecs.CfnCapacityProvider(this, `${prefix}ECSCapacityProvider`, {
      autoScalingGroupProvider: {
        autoScalingGroupArn: autoScalingGroup.ref, //logicalId,
        managedScaling: {
          instanceWarmupPeriod: 20, // seconds
          maximumScalingStepSize: 100,
          minimumScalingStepSize: 2,
          status: 'ENABLED',
          targetCapacity: 80, // keep 20% of instances warm and ready
        },
        managedTerminationProtection: 'ENABLED',
      },
    });
    const clusterCpa = new ecs.CfnClusterCapacityProviderAssociations(this, `${prefix}ECSClusterCPA`, {
      cluster: ecsCluster.clusterName,
      capacityProviders: [ capacityProvider.ref ],
      defaultCapacityProviderStrategy: [
        { base: 1, weight: 1, capacityProvider: capacityProvider.ref }
      ],
    });


    const lambdaFunctionRole = new iam.Role(this, `${prefix}LambdaFunctionRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonECS_FullAccess' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess' },
      ],
    });

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
    // const ecrRepo = new ecr.Repository(this, `${prefix}ECRRepository`);
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
    lambdaFunction.node.addDependency(clusterCpa);
    const lambdaFunctionUrl = new cdk.CfnResource(this, `${prefix}LambdaFunctionURL`, {
      type: 'AWS::Lambda::Url',
      properties: {
        AuthType: 'NONE', // TODO: change to IAM
        TargetFunctionArn: lambdaFunction.functionArn,
      }
    });

    // const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'recorder-autoscaling-group', {
    //   vpc: vpc,
    //   instanceType: new ec2.InstanceType(instanceType),
    //   launchTemplate: launchTemplate,

    // });
    // example resource
    // const queue = new sqs.Queue(this, 'CdkQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
