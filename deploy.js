// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");

// Parameters
let region = "us-east-1";
let imageId = ``;
let bucket = ``;
let stack = ``;
let ecrDockerImageArn = ``;

function usage() {
  console.log(
    `Usage: deploy.sh [-r region] [-b bucket] [-s stack] [-i docker-image]`
  );
  console.log(`  -r, --region       Target region, default '${region}'`);
  console.log(`  -b, --s3-bucket    S3 bucket for deployment, required`);
  console.log(`  -s, --stack-name   CloudFormation stack name, required`);
  console.log(`  -i, --image-arn    Docker image store in ECR, required`);
  console.log(`  -h, --help         Show help and exit`);
}

function ensureBucket() {
  const s3Api = spawnSync("aws", [
    "s3api",
    "head-bucket",
    "--bucket",
    `${bucket}`,
    "--region",
    `${region}`,
  ]);
  if (s3Api.status !== 0) {
    console.log(`Creating S3 bucket ${bucket}`);
    const s3 = spawnSync("aws", [
      "s3",
      "mb",
      `s3://${bucket}`,
      "--region",
      `${region}`,
    ]);
    if (s3.status !== 0) {
      console.log(`Failed to create bucket: ${JSON.stringify(s3)}`);
      console.log((s3.stderr || s3.stdout).toString());
      process.exit(s3.status);
    }
  }
}

function ensureEC2ImageId() {
  // Fetching the ECS optimized AMI for AL2
  // More info: https://aws.amazon.com/premiumsupport/knowledge-center/launch-ecs-optimized-ami/
  imageId = spawnSync("aws", [
    "ssm",
    "get-parameters",
    "--names",
    "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id",
    "--region",
    `${region}`,
    "--query",
    '"Parameters[0].Value"',
  ]);
  if (!imageId.length) {
    // Setting image ID optimized for us-east-1
    // Mode info: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html
    imageId = "ami-00f69adbdc780866c";
  }
}

function getArgOrExit(i, args) {
  if (i >= args.length) {
    console.log("Too few arguments");
    usage();
    process.exit(1);
  }
  return args[i];
}

function parseArgs() {
  var args = process.argv.slice(2);
  var i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "-r":
      case "--region":
        region = getArgOrExit(++i, args);
        break;
      case "-b":
      case "--s3-bucket":
        bucket = getArgOrExit(++i, args);
        break;
      case "-s":
      case "--stack-name":
        stack = getArgOrExit(++i, args);
        break;
      case "-i":
      case "--docker-image":
        ecrDockerImageArn = getArgOrExit(++i, args);
        break;
      default:
        console.log(`Invalid argument ${args[i]}`);
        usage();
        process.exit(1);
    }
    ++i;
  }
  if (!stack.trim() || !bucket.trim() || !ecrDockerImageArn.trim()) {
    console.log("Missing required parameters");
    usage();
    process.exit(1);
  }
}

function spawnOrFail(command, args, options) {
  const cmd = spawnSync(command, args, options);
  if (cmd.error) {
    console.log(`Command ${command} failed with ${cmd.error.code}`);
    process.exit(255);
  }
  const output = cmd.stdout.toString();

  if (cmd.status !== 0) {
    console.log(
      `Command ${command} failed with exit code ${cmd.status} signal ${cmd.signal}`
    );
    console.log(cmd.stderr.toString());
    process.exit(cmd.status);
  }
  return output;
}

function ensureTools() {
  spawnOrFail("aws", ["--version"]);
  spawnOrFail("sam", ["--version"]);
}

parseArgs();
ensureTools();

if (!fs.existsSync("build")) {
  fs.mkdirSync("build");
}

console.log(`Using region ${region}, bucket ${bucket}, stack ${stack}`);
ensureEC2ImageId();
ensureBucket();

spawnOrFail("sam", [
  "package",
  "--s3-bucket",
  `${bucket}`,
  "--template-file",
  "templates/RecordingCloudformationTemplate.yaml",
  "--output-template-file",
  "build/packaged.yaml",
  "--region",
  `${region}`,
]);

const instanceType = "c6a.xlarge";
console.log(`Querying availability zones for instance type ${instanceType}`);
const instanceTypeAzs = JSON.parse(
  spawnOrFail("aws", [
    "ec2",
    "describe-instance-type-offerings",
    "--location-type",
    "availability-zone",
    "--filters",
    `Name=instance-type,Values=${instanceType}`,
    "--query",
    "InstanceTypeOfferings[*].Location",
    "--region",
    `${region}`,
  ])
).sort().join(',');
console.log(`Found ${instanceTypeAzs}`);

console.log("Deploying recording application");
const output = spawnOrFail("sam", [
  "deploy",
  "--template-file",
  "./build/packaged.yaml",
  "--stack-name",
  `${stack}`,
  "--parameter-overrides",
  `ECRDockerImageArn=${ecrDockerImageArn}`,
  `EcsAsgMinSize=1`,
  `EcsAsgDesiredSize=2`,
  `EcsAsgMaxSize=10`,
  `InstanceType=${instanceType}`,
  `InstanceTypeSupportedAvailabilityZones=us-east-1d,us-east-1e`,//us-east-1f`,
  `VpcCIDR=10.192.0.0/16`,
  `PublicSubnetsCIDR=10.192.10.0/24,10.192.11.0/24`,
  `PrivateSubnetsCIDR=10.192.12.0/24,10.192.13.0/24`,
  "--capabilities",
  "CAPABILITY_IAM",
  "--region",
  `${region}`,
  "--no-fail-on-empty-changeset",
]);
console.log(output);

const invokeUrl = spawnOrFail("aws", [
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  `${stack}`,
  "--query",
  "Stacks[0].Outputs[0].OutputValue",
  "--output",
  "text",
  "--region",
  `${region}`,
]);
console.log(`Recording API Gateway invoke URL: ${invokeUrl}`);
console.log("Deployment complete");
