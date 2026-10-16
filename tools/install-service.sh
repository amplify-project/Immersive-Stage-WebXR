#!/usr/bin/env bash
# Start the server (player + editor + live encode) when the PC boots.
#
# Installs a systemd service that runs server.js as the CURRENT user, from this
# checkout, under an English locale. Run it as your normal user, NOT with sudo:
# it asks for sudo itself only to write the unit file.
#
#   tools/install-service.sh            install + enable + start
#   tools/install-service.sh --remove   stop + disable + delete
#
# Why each line of the unit is there:
#   User=          ~/.aws (S3 credentials) and the audio/video groups are the
#                  user's; as root the uploader finds no credentials.
#   LC_ALL/LANG=C  `arecord -l` is translated ("scheda", "tarjeta") and the ALSA
#                  device list comes up empty on an Italian or Spanish machine.
#   PATH=          systemd's PATH has no nvm node, no ~/.local/bin aws; we pin
#                  the PATH of the shell that ran this script.
#
# Logs: journalctl -u amplify-player -f
set -euo pipefail

NAME=amplify-player
UNIT=/etc/systemd/system/$NAME.service
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--remove" ]]; then
  sudo systemctl disable --now "$NAME" 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "Removed $NAME."
  exit 0
fi

[[ $EUID -eq 0 ]] && { echo "Run this as your normal user, not with sudo (it calls sudo itself)."; exit 1; }
NODE="$(command -v node)" || { echo "node not found in PATH."; exit 1; }
[[ -f "$DIR/server.js" ]] || { echo "No server.js in $DIR."; exit 1; }
for t in ffmpeg arecord v4l2-ctl; do
  command -v "$t" >/dev/null || echo "  warning: $t not found in PATH — live capture will fail."
done

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Immersive player server (player, editor, live encode)
Wants=network-online.target
After=network-online.target sound.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=LC_ALL=C.UTF-8
Environment=LANG=C.UTF-8
Environment=PATH=$PATH
ExecStart=$NODE $DIR/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$NAME"
sleep 1
systemctl --no-pager --lines=8 status "$NAME" || true
echo
echo "Installed. Starts at every boot. Logs: journalctl -u $NAME -f"
