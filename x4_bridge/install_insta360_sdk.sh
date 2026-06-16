#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MEDIA_SDK_DEB="${SCRIPT_DIR}/libs/libMediaSDK-dev-3.1.1.0-20250922_191110-amd64.deb"
CAMERA_SDK_SRC="${SCRIPT_DIR}/libs/CameraSDK-20250812_192742-2.1.1-Linux"

INSTALL_ROOT="${INSTALL_ROOT:-/opt/insta360}"
CAMERA_SDK_NAME="$(basename "${CAMERA_SDK_SRC}")"
CAMERA_SDK_DEST="${INSTALL_ROOT}/${CAMERA_SDK_NAME}"
CAMERA_SDK_LINK="${INSTALL_ROOT}/CameraSDK"
LDCONFIG_FILE="/etc/ld.so.conf.d/insta360-camera-sdk.conf"

require_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "Missing file: ${path}" >&2
    exit 1
  fi
}

require_dir() {
  local path="$1"
  if [[ ! -d "${path}" ]]; then
    echo "Missing directory: ${path}" >&2
    exit 1
  fi
}

require_file "${MEDIA_SDK_DEB}"
require_dir "${CAMERA_SDK_SRC}"
require_file "${CAMERA_SDK_SRC}/lib/libCameraSDK.so"
require_dir "${CAMERA_SDK_SRC}/include"

echo "Installing MediaSDK package:"
echo "  ${MEDIA_SDK_DEB}"
sudo dpkg -i "${MEDIA_SDK_DEB}"

echo
echo "Installing CameraSDK:"
echo "  source:      ${CAMERA_SDK_SRC}"
echo "  destination: ${CAMERA_SDK_DEST}"
sudo install -d "${INSTALL_ROOT}"
sudo rm -rf "${CAMERA_SDK_DEST}"
sudo cp -a "${CAMERA_SDK_SRC}" "${CAMERA_SDK_DEST}"
sudo ln -sfn "${CAMERA_SDK_DEST}" "${CAMERA_SDK_LINK}"

echo
echo "Registering CameraSDK shared libraries:"
echo "  ${CAMERA_SDK_LINK}/lib"
printf '%s\n' "${CAMERA_SDK_LINK}/lib" | sudo tee "${LDCONFIG_FILE}" >/dev/null
sudo ldconfig

echo
echo "Done."
echo "CameraSDK root: ${CAMERA_SDK_LINK}"
echo
echo "Build with:"
echo "  CAMERA_SDK_ROOT=${CAMERA_SDK_LINK} ./build_insta360_v4l2_bridge.sh"
