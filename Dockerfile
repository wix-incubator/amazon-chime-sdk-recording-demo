# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

FROM ubuntu:20.04

ENV DEBIAN_FRONTEND noninteractive

RUN /usr/bin/apt-get update && \
	/usr/bin/apt-get install -y sudo curl software-properties-common && \
	curl -sL https://deb.nodesource.com/setup_10.x | bash - && \
	add-apt-repository ppa:savoury1/ffmpeg4 && \
	/usr/bin/apt-get update && \
	/usr/bin/apt-get upgrade -y && \
	/usr/bin/apt-get install -y nodejs pulseaudio xvfb firefox ffmpeg xdotool unzip

RUN curl -s -O http://ciscobinary.openh264.org/libopenh264-2.2.0-linux64.6.so.bz2 && \
	bzip2 -d libopenh264-2.2.0-linux64.6.so.bz2 && \
	cp libopenh264-2.2.0-linux64.6.so /tmp/

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