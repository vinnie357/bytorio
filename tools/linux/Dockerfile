# Pinned x86_64 Linux build and test image for the Bytorio toolchain.
#
# glibc baseline: Ubuntu 22.04 ships glibc 2.35, the glibc of the oldest SteamOS 3 release, so
# everything built here runs on any SteamOS 3.x. Nothing in this image carries credentials.
FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956

ARG MISE_VERSION=2026.10.17
ARG MISE_SHA256=17565e268c5542d8ce944321e17af81e0b741b65af4aa7e8e010ee77376a4aa3
ARG EMSDK_TAG=6.0.12
ARG VFOX_EMSDK_COMMIT=3f458a0b4526dad4ea3938696e1e5e2e21350181

ENV DEBIAN_FRONTEND=noninteractive

# Compilers, the headers SDL3 is built against (SDL3 loads X11, Wayland and audio libraries at
# run time, so none of these become run-time dependencies of the player) and Chrome's runtime
# libraries for the browser checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    build-essential ca-certificates clang curl git libasound2-dev libdbus-1-dev libdecor-0-dev \
    libdrm-dev libegl1-mesa-dev libgbm-dev libgl1-mesa-dev libpulse-dev libudev-dev \
    libwayland-dev libx11-dev libxcursor-dev libxext-dev libxfixes-dev libxi-dev libxkbcommon-dev \
    libxrandr-dev libxss-dev libxtst-dev pkg-config rsync unzip wayland-protocols xz-utils zip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/mise.tar.gz \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz" \
 && echo "${MISE_SHA256}  /tmp/mise.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mise.tar.gz -C /opt \
 && ln -s /opt/mise/bin/mise /usr/local/bin/mise \
 && rm /tmp/mise.tar.gz

# The vfox-emsdk plugin downloads emsdk from its main branch, so install the pinned tag by hand
# where mise expects the tool and pin the plugin itself to a commit.
RUN git clone --depth 1 --branch "${EMSDK_TAG}" https://github.com/emscripten-core/emsdk /opt/emsdk \
 && /opt/emsdk/emsdk install "${EMSDK_TAG}" \
 && /opt/emsdk/emsdk activate "${EMSDK_TAG}" \
 && mkdir -p /root/.local/share/mise/installs/vfox-jdx-vfox-emsdk \
 && ln -s /opt/emsdk "/root/.local/share/mise/installs/vfox-jdx-vfox-emsdk/${EMSDK_TAG}" \
 && git clone https://github.com/jdx/vfox-emsdk /root/.local/share/mise/plugins/vfox-jdx-vfox-emsdk \
 && git -C /root/.local/share/mise/plugins/vfox-jdx-vfox-emsdk checkout "${VFOX_EMSDK_COMMIT}"

# A virtual X server and Mesa's software renderer let the GPU checks run without a display.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1-mesa-dri libglx-mesa0 xvfb \
 && rm -rf /var/lib/apt/lists/*

# Rosetta leaves a stale stat buffer behind when lstat fails; see rosetta-lstat.c. Luau 0.743 hits
# it and rejects every .luaurc, so preload the fix for everything run in this image.
COPY rosetta-lstat.c /tmp/rosetta-lstat.c
RUN gcc -shared -fPIC -O2 -o /usr/local/lib/rosetta-lstat.so /tmp/rosetta-lstat.c -ldl \
 && rm /tmp/rosetta-lstat.c
ENV LD_PRELOAD=/usr/local/lib/rosetta-lstat.so

WORKDIR /work
