// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const VERSION = 14;

console.log(`Version: ${VERSION}-wix`);

const { S3Utils } = require("./utils/s3");
const { Params } = require("./utils/params");
const { respondFactory } = require("./utils/response");
const { startRecording, stopRecording } = require("./utils/recording");
const { setNamespace, log } = require("./utils/log");

const recordingArtifactsBucket = process.env.recordingArtifactsBucket;

exports.handler = function (event, context, callback) {
  setNamespace("Handler");

  const respond = respondFactory(context, callback);
  const params = new Params(event, respond);

  log("Received event: ", event);

  const action = (params.get("action") || "").toLowerCase();

  log("Handling action: ", action);

  const parametersConfig = {
    start: ["targetURL", "recordingName"],
    stop: ["taskId"],
    download: ["recordingName"],
    delete: ["recordingName"],
  };

  log("Required parameters configuration: ", parametersConfig);

  const parametersValid = params.ensureAllExist(parametersConfig, action);

  if (parametersValid) {
    switch (action) {
      case "start":
        setNamespace(action);

        return startRecording(
          respond,
          params.get("targetURL"),
          params.get("recordingName")
        );
      case "stop":
        setNamespace(action);

        return stopRecording(respond, params.get("taskId"));
      case "download":
        setNamespace(action);

        new S3Utils(
          recordingArtifactsBucket,
          `${params.get("recordingName")}.mp4`
        )
          .getUrl()
          .then((url) => {
            respond({
              statusCode: 200,
              body: JSON.stringify(
                {
                  url,
                },
                null,
                " "
              ),
            });
          })
          .catch((e) => {
            respond({
              statusCode: e.statusCode,
              headers: {},
              body: JSON.stringify(
                {
                  error: e,
                },
                null,
                " "
              ),
            });
          });

        break;

      case "delete":
        setNamespace(action);

        new S3Utils(
          recordingArtifactsBucket,
          `${params.get("recordingName")}.mp4`
        )
          .remove()
          .then(() => {
            respond({
              statusCode: 200,
              body: JSON.stringify(
                {
                  message: `OK`,
                },
                null,
                " "
              ),
            });
          })
          .catch((e) => {
            respond({
              statusCode: e.statusCode,
              body: JSON.stringify({ error: e }, null, " "),
            });
          });

        break;

      default:
        respond({
          statusCode: 400,
          body: JSON.stringify({
            error: {
              message:
                "Invalid parameter: action. Valid values 'start', 'stop', 'download', 'delete'",
            },
          }),
        });
    }
  }
};
