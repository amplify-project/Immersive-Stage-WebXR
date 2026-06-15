#!/usr/bin/env bash
set -euo pipefail

CAMERA_SDK_ROOT="${CAMERA_SDK_ROOT:-/opt/insta360/CameraSDK}"

if [[ ! -d "${CAMERA_SDK_ROOT}" ]]; then
  CAMERA_SDK_ROOT="/home/VICOMTECH/aelosegi/Linux_CameraSDK-2.1.1_MediaSDK-3.1.1/CameraSDK-20250812_192742-2.1.1-Linux"
fi

g++ -std=c++17 -O2 -Wall -Wextra \
  -I"${CAMERA_SDK_ROOT}/include" \
  $(pkg-config --cflags opencv4) \
  insta360_v4l2_bridge.cc \
  -L"${CAMERA_SDK_ROOT}/lib" \
  -Wl,-rpath,"${CAMERA_SDK_ROOT}/lib" \
  $(pkg-config --libs opencv4) \
  -lCameraSDK \
  -lMediaSDK \
  -pthread \
  -o insta360_v4l2_bridge
