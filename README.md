# Live Video Recorder

Recorder is based on Amazon Chime recorder demo project:
https://github.com/aws-samples/amazon-chime-sdk-recording-demo

Setup was based on this documentation:
https://aws.amazon.com/blogs/business-productivity/how-to-enable-client-side-recording-using-the-amazon-chime-sdk/

Note that solution was modified based on custom requirements and is not exactly same as the one provided by Amazon.

Additional information can be found in internal Slack channel for live-video.

**Security/access related details may never be added to this project or its README file.**

---

## Deploy

> WARNING: you will be charged by AWS for resources created by this script. Make sure you understand what is being created. If you are testing on staging environment - modify instance type and reduce number of running instances.

#### Prerequisites:

- Node.js 14.x.x+
- AWS CLI (`brew install awscli` or https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- AWS CDK (`npm install -g aws-cdk`)
- Docker


Setup credentials for AWS CLI, make sure correct account is selected:
```bash
aws sts get-caller-identity
# {
#     "UserId": "user-id:user@example.com",
#     "Account": "xxxxxxxxxxxx",
#     "Arn": "arn:aws:sts::xxxxxxxxxxxx:assumed-role/role/user@example.com"
# }
```

If deploying on a new account - bootstrap CDK first. This provisions supporting resources for deployment:
```bash
cd cdk
cdk bootstrap
```

Compile CDK stack or run watch server:
```bash
npm run watch
# OR
npm run build
```

Finally, deploy changes and confirm changes:
```bash
# Builds Docker image from included sources and deploys synthesized CloudFormation stack
cdk deploy
```

---

## Deployment of Code Updates

When updating code it is recommended to update/increment echo line in "run.sh" file under "recording". This way you will be able to confirm that new version is used after deployment by checking CloudWatch logs. Something like this:

```
echo v14-wix
```

Code for Lambda function can be found under "lambda" folder.

Code for recorder logic (which would go to docker image) can be found under "recording" folder.

Updating is performed in same way:
```bash
npm run build
cdk deploy
```

Once above steps are completed, test recording, then open CloudWatch, go to "Log groups", go to "RecordingLogGroup", find logs of your test recorder and confirm that echo'ed version at the top of the logs matches your updated version.

Should version not update automatically, instances may need to be updated manually to contain the new image:

- Go to AWS console and into Elastic Container Service.
- Select Recorder cluster, go to "Instances" tab and select option to drain all instances. This should wait for instances to complete tasks and prevent them from accepting new ones. Auto-scaling mechanism should launch new instances to compensate for drained ones. New instances will contain updated docker image.
- Once instances are drained, they can be terminated by going to AWS console and into EC2 service. There you will find "instances" section. After selecting drained instances - there is an option above the table to terminate them.

Be careful - do not terminate instances which do not belong to recording service. Also, do not terminate instances which are still running tasks.

---

## Debugging

Should something fail, both Lambda and Recorder are producing logs. To locate these logs, connect to AWS console and go to CloudWatch service.

Go to "Log groups". There will be 2 groups which will provide valuable information:

- /aws/lambda/RecordingLambda - Lambda logs
- RecordingLogGroup - recorder logs

Please note that recorder logs will contain a lot of instances of "xdotool mousemove 1 100 click 1". This is because recorder needs to simulate click in order to enable auto-play on browser. However, problem is that it is not known exactly when this click needs to be emulated. As a result, this simulated click is repeated continuously.

---

## AutoScale Configuration

Main thing which needs to be configured for the Recorder is auto-scaling. Need to make sure that maximum, minimum and desired amount of instances suits the actual usage situation.

This can be done by going to AWS console, then to Cloud Formation, parameters. Inside parameters look for following keys:

- DesiredCapacity - amount of instances which should normally be required (must be above min and below max values)
- EcsAsgMaxSize - maximum amount of instances allowed
- EcsAsgMinSize - minimum amount of instances allowed

See "How auto-scale works" for more details below.

---

## How recording works

There are 2 components to the whole solution:

- Lambda function - interface for recorder. Accepts requests for starting/stopping recorder. Also provides download link and ability to delete a recording.
- Recorder - docker image which contains FireFox, ffmpeg and NodeJS script for managing the recording process.

How recording process looks like:

- Lambda function is called asking to start recording
- Lambda function launches a recording task which occupies 1 of available free instances (Virtual Machines).
- Recorder opens FireFox in kiosk mode and loads provided Live Video URL. This URL opens UX which is specifically designed for recorder.
- Mouse click is simulated in order to enable auto-play on browser. Without this browser will not be able to launch video with audio on its own and recorder will fail.
- After a delay Node.JS script initializes ffmpeg which records whole screen of the virtual machine.
- Output of ffmpeg is streamed directly out to S3 storage.

At some point recording needs to be stopped. In such case Lambda function is called with taskId asking to stop recording task. This action terminates task, which finalizes stream to S3 and releases instance for taking another task later.

Note that if recording is not stopped due to some malfunction - Node.JS script has an emergency termination logic which would kill the task after a certain time.

Finally, Lambda can be called asking for signed recording download link and later - asking to delete it from S3.

---

## How AutoScale works

During initial deployment following configuration was used:

- Maximum of 1000 instances are allowed.
- Minimum of 25 instances are allowed.
- It is desired to have 25 instances.
- Aim is to have 80% of instances with tasks. Should percentage increase, new instances would need to be fired up. Should it decrease, overhead instance should be terminated.
- When adding/removing instances - maximum of 1000 instances may be added/removed in a single go.
- When adding/removing instances - minimum of 1 instances may be added/removed in a single go.

Initially after deployment - 25 empty (without tasks) instances are launched.

Once more than 30 instances become occupied with tasks, additional instances are launched. New instances take approx. 300 seconds to be prepared and to appear in the list.

Amount of instances can further increase up to 1000.

Should amount of recordings decrease, instances will be terminated to try and maintain no more than 80% instances occupied with tasks.

Scale down would stop once there are 25 instances and no further instances would be terminated.

## Bonus topics

### How to recover video after Lambda crash

There has been a case where lambda crashed and video did not appear in S3.

To recover such video, one can try running the following command:

```
aws s3api list-multipart-uploads --bucket <bucket name>
```

This will list incomplete uploads. Search for missing key in the resulting JSON output and use its information for commands below.

Gather multipart upload part information:
```
aws s3api list-parts --bucket <bucket name> --key '{key of missing video}' --upload-id {uploadId from result of previous command} > recovery.json
```

Once JSON is stored in file, leave only "Parts" key in it. Also ensure that each item inside "Parts" contains only "PartNumber" and "ETag" keys - delete all other keys. This can easily be done by using RegExp find-replace functionality of your favourite IDE.

Once "recovery.json" is prepared, run the following command:
```
aws s3api complete-multipart-upload --multipart-upload file://recovery.json --bucket <bucket name> --key '{key of missing video}' --upload-id {uploadId from result of previous command}
```

This command should connect parts of multipart-upload and create a missing S3 object.

Make sure object is backed-up so that it would not be deleted soon after in case its availability deadline is approaching (business functionality).
