// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const AWS = require("aws-sdk");

class S3Utils {
  constructor(bucket, key) {
    const sts = new AWS.STS();
    sts.getCallerIdentity({}, (err, data) => {
      if (err) console.log(err, err.stack);
      else console.log(data);
    });
    
    this.bucket = bucket;
    this.key = key;
    this.fileS3 = new AWS.S3({ params: { Bucket: bucket, Key: key } });
    console.log(
      `[S3] constructing an S3 object with bucket: ${this.bucket}, key: ${this.key}`
    );
  }

  uploadStream(stream) {
    const managedUpload = this.fileS3.upload({ Body: stream }, (err, data) => {
      if (err) {
        console.log(
          "[stream upload process] - failure - error handling on failure",
          err
        );
      } else {
        console.log(
          `[stream upload process] - success - uploaded the file to: ${data.Location}`
        );
        process.exit();
      }
    });
    managedUpload.on("httpUploadProgress", function (event) {
      console.log(
        `[stream upload process]: on httpUploadProgress ${event.loaded} bytes`
      );
    });
  }
}

module.exports = {
  S3Utils,
};
