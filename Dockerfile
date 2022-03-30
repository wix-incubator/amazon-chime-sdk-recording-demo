# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

FROM ubuntu:18.04

ENV DEBIAN_FRONTEND noninteractive

RUN /usr/bin/apt-get update && \
	/usr/bin/apt-get install -y sudo curl software-properties-common && \
	curl -sL https://deb.nodesource.com/setup_10.x | bash - && \
	# <=18.04 only:
	add-apt-repository ppa:jonathonf/vlc-3 && \
	add-apt-repository ppa:jonathonf/ffmpeg-4 && \
	# These binaries are newer and support 20.04, but VLC produces cryptic "avcodec encoder warning: cannot send one frame to encoder -22" and refuses to stream anything:
	# add-apt-repository ppa:savoury1/vlc3 && \
	# add-apt-repository ppa:savoury1/ffmpeg4 && \
	/usr/bin/apt-get update && \
	/usr/bin/apt-get upgrade -y && \
	/usr/bin/apt-get install -y nodejs pulseaudio xvfb firefox ffmpeg vlc vlc-plugin-access-extra xdotool unzip

COPY /recording /recording
WORKDIR /recording
RUN /usr/bin/npm install && \
	chmod +x /recording/run.sh && \
	chmod +x /recording/record.js

# Run container as non-root
RUN adduser --disabled-password --gecos '' docker
RUN adduser docker sudo
RUN echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
USER docker

ENTRYPOINT ["/recording/run.sh"]