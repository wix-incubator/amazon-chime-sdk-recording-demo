// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawn } = require("child_process");
const { S3Utils } = require("./utils/s3");

const OUTPUT_FILE_NAME =
  process.env.OUTPUT_FILE_NAME || "Not present in environment";
log(`OUTPUT_FILE_NAME: ${OUTPUT_FILE_NAME}`);

const TARGET_URL = process.env.TARGET_URL || "Not present in environment";
log(`TARGET_URL: ${TARGET_URL}`);

const args = process.argv.slice(2);
const BUCKET_NAME = args[0];
log(`BUCKET_NAME: ${BUCKET_NAME}`);
const BROWSER_SCREEN_WIDTH = args[1];
const BROWSER_SCREEN_HEIGHT = args[2];
log(
  `BROWSER_SCREEN_WIDTH: ${BROWSER_SCREEN_WIDTH}, BROWSER_SCREEN_HEIGHT: ${BROWSER_SCREEN_HEIGHT}`
);

const VIDEO_BITRATE = 3000;
const VIDEO_FRAMERATE = 24;
const VIDEO_GOP = VIDEO_FRAMERATE * 2;
const AUDIO_BITRATE = "160k";
const AUDIO_SAMPLERATE = 44100;
const AUDIO_CHANNELS = 2;
const DISPLAY = process.env.DISPLAY;

// We will forcefully kill recorder if it does not end after 25h
const MAX_RECORDING_DURATION =
  process.env.MAX_RECORDING_DURATION || 25 * 60 * 60;

let remainingSeconds = Number(MAX_RECORDING_DURATION);
let recordingDurationInterval;

const transcodeStreamToOutput = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  // disable interaction via stdin
  "-nostdin",
  // screen image size
  "-s",
  `${BROWSER_SCREEN_WIDTH}x${BROWSER_SCREEN_HEIGHT}`,
  // video frame rate
  "-r",
  `${VIDEO_FRAMERATE}`,
  // hides the mouse cursor from the resulting video
  "-draw_mouse",
  "0",
  // "-rtbufsize",
  // "104857600", // 100M
  // "-probesize",
  // "10000000", // 10MB
  // "-thread_queue_size",
  // "1024", // 1024 * 1280 * 720 * 4 bytes ~= 3.5GB
  // grab the x11 display as video input
  "-f",
  "x11grab",
  "-i",
  `${DISPLAY}`,
  // grab pulse as audio input
  "-f",
  "pulse",
  "-ac",
  "2",
  // "-thread_queue_size",
  // "1024",
  "-i",
  "default",
  // "-vsync",
  // "vfr",
  // codec video with libx264
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-profile:v",
  "main",
  "-preset",
  "veryfast",
  // "-tune",
  // "zerolatency",
  "-x264opts",
  "nal-hrd=cbr:no-scenecut",
  "-minrate",
  `${VIDEO_BITRATE}`,
  "-maxrate",
  `${VIDEO_BITRATE}`,
  "-g",
  `${VIDEO_GOP}`,
  // codec audio with aac
  "-c:a",
  "aac",
  "-b:a",
  `${AUDIO_BITRATE}`,
  "-ac",
  `${AUDIO_CHANNELS}`,
  "-ar",
  `${AUDIO_SAMPLERATE}`,
  // "-af",
  // "aresample=async=1000",
  // adjust fragmentation to prevent seeking(resolve issue: muxer does not support non seekable output)
  "-movflags",
  "empty_moov+default_base_moof+frag_keyframe",
  // set output format to mp4 and output file to stdout
  "-f",
  "mp4",
  '-',
]);

transcodeStreamToOutput.stderr.on("data", (data) =>
  error(`stderr: ${data}`)
);
transcodeStreamToOutput.on("close", (code) => {
  log(
    `exited with code ${code}`
  );
});

const fileName = `${OUTPUT_FILE_NAME}.mp4`;
new S3Utils(BUCKET_NAME, fileName).uploadStream(transcodeStreamToOutput.stdout);

// event handler for docker stop, not exit until upload completes
process.on("SIGTERM", (code, signal) => {
  log(`exited with code ${code} and signal ${signal}(SIGTERM)`);
  clearInterval(recordingDurationInterval);
  process.kill(transcodeStreamToOutput.pid, "SIGTERM");
});

// debug use - event handler for ctrl + c
process.on("SIGINT", (code, signal) => {
  log(`exited with code ${code} and signal ${signal}(SIGINT)`);
  clearInterval(recordingDurationInterval);
  process.kill("SIGTERM");
});

process.on("exit", function (code) {
  clearInterval(recordingDurationInterval);
  log(`[recording process] exit code ${code}`);
});

recordingDurationInterval = setInterval(() => {
  remainingSeconds--;

  if (remainingSeconds < 0) {
    clearInterval(recordingDurationInterval);
    log("[recording process] task is running for too long - killing");
    process.kill(transcodeStreamToOutput.pid, "SIGTERM");
  }
}, 1000);

function log(s) {
  console.log(
    `[recording process] ${new Date().toISOString()} ${s}`
  );
}

function error(s) {
  console.error(
    `[recording process] ${new Date().toISOString()} ${s}`
  );
}
