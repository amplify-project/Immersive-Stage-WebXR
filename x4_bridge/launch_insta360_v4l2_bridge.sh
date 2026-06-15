#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_BIN="${SCRIPT_DIR}/insta360_v4l2_bridge"

if [[ ! -x "${BRIDGE_BIN}" ]]; then
  echo "Error: binary not found or not executable: ${BRIDGE_BIN}" >&2
  echo "Build it first: ./build_insta360_v4l2_bridge.sh" >&2
  exit 1
fi

print_help() {
  cat <<'EOF'
Usage: ./launch_insta360_v4l2_bridge.sh [insta360_v4l2_bridge options]

This launcher reloads v4l2loopback and then starts insta360_v4l2_bridge.

Launcher defaults (applied only if not provided):
  --device /dev/video10
  --stitch-type template

Examples:
  ./launch_insta360_v4l2_bridge.sh
  ./launch_insta360_v4l2_bridge.sh --no-flowstate
  ./launch_insta360_v4l2_bridge.sh --device /dev/video12 --stitch-type dynamicstitch

All additional arguments are passed directly to insta360_v4l2_bridge.
EOF

  echo
  echo "insta360_v4l2_bridge options:"
  "${BRIDGE_BIN}" --help
}

# Defaults used when not provided by user arguments.
DEFAULT_DEVICE="/dev/video10"
DEFAULT_STITCH_TYPE="template"

has_device=false
has_stitch_type=false

for arg in "$@"; do
  case "${arg}" in
    --help|-h)
      print_help
      exit 0
      ;;
    --device)
      has_device=true
      ;;
    --stitch-type)
      has_stitch_type=true
      ;;
  esac
done

cmd=("${BRIDGE_BIN}")
if [[ "${has_device}" == false ]]; then
  cmd+=(--device "${DEFAULT_DEVICE}")
fi
if [[ "${has_stitch_type}" == false ]]; then
  cmd+=(--stitch-type "${DEFAULT_STITCH_TYPE}")
fi
cmd+=("$@")

echo "Reloading v4l2loopback..."
sudo modprobe -r v4l2loopback || true
sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1

echo "Starting Insta360 bridge..."
exec sudo "${cmd[@]}"
