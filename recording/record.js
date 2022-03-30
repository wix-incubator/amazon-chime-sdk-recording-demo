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
const VIDEO_FRAMERATE = 30;
const VIDEO_GOP = VIDEO_FRAMERATE * 2;
const AUDIO_BITRATE = "160";
const AUDIO_SAMPLERATE = 44100;
const AUDIO_CHANNELS = 2;

// We will forcefully kill recorder if it does not end after 25h
const MAX_RECORDING_DURATION =
  process.env.MAX_RECORDING_DURATION || 25 * 60 * 60;

let remainingSeconds = Number(MAX_RECORDING_DURATION);
let recordingDurationInterval;

const venc = `venc=x264{profile=main,preset=veryfast,vbv-minrate=${VIDEO_BITRATE},vbv-maxrate=${VIDEO_BITRATE},vbv-bufsize=8000,hrd=cbr,x264-scenecut=-1}`
const videoOpts = `vcodec=h264,${venc},fps=${VIDEO_FRAMERATE},gop=${VIDEO_GOP},vb=${VIDEO_BITRATE}`
const audioOpts = `acodec=aac,ab=${AUDIO_BITRATE},channels=${AUDIO_CHANNELS},samplerate=${AUDIO_SAMPLERATE}`
const outputOpts = `access=file,mux=ffmpeg{mux=mp4},dst=-`
const cvlcArgs = [
  // Capture display device
  'screen://',
  `:screen-fps=${VIDEO_FRAMERATE}`,
  ':screen-left=0',
  ':screen-top=0',
  `:screen-width=${BROWSER_SCREEN_WIDTH}`,
  `:screen-height=${BROWSER_SCREEN_HEIGHT}`,
  // Capture audio device
  '--input-slave=pulse://',
  '--sout',
  `#transcode{${videoOpts},${audioOpts},audio-sync,threads=0}:standard{${outputOpts}}`,
  '--sout-avformat-options={movflags=empty_moov+frag_keyframe+default_base_moof}',
  // Verbose output
  // '-vvv',
]

log(`cvlc ${cvlcArgs.join(' ')}`);
const cvlc = spawn('cvlc', cvlcArgs);

cvlc.stdout.on("data", (data) =>
  log(`cvlc stdout: ${data}`)
);
cvlc.stderr.on("data", (data) =>
  error(`cvlc stderr: ${data}`)
);
cvlc.on("close", (code) => {
  log(
    `cvlc exited with code ${code}`
  );
});

const fileName = `${OUTPUT_FILE_NAME}.mp4`;
new S3Utils(BUCKET_NAME, fileName).uploadStream(cvlc.stdout);

// event handler for docker stop, not exit until upload completes
process.on("SIGTERM", (code, signal) => {
  log(`exited with code ${code} and signal ${signal}(SIGTERM)`);
  clearInterval(recordingDurationInterval);
  process.kill(cvlc.pid, "SIGTERM");
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
    process.kill(cvlc.pid, "SIGTERM");
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
