#!/usr/bin/env bash
# ============================================================================
#  gen-cert.sh — Genera un certificado TLS autofirmado para el server.
#  Necesario para WebXR/VR: el navegador exige HTTPS fuera de localhost, y el
#  Quest entra por IP de LAN. Mete las IPs locales en subjectAltName para que
#  el aviso de "no seguro" sea aceptable (igualmente hay que aceptarlo a mano).
#
#  Uso:   ./gen-cert.sh            (detecta tus IPs de LAN)
#         IPS="192.168.1.50" ./gen-cert.sh   (forzar IP concreta)
#  Luego: reinicia el server (node server.js) → pasará a HTTPS automáticamente.
# ============================================================================
set -euo pipefail

OUT="${OUT:-certs}"
mkdir -p "$OUT"

# IPs de LAN (rangos privados) + las que pases por la variable IPS.
DETECTED=$(hostname -I 2>/dev/null | tr ' ' '\n' \
  | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' || true)
IPS="${IPS:-} $DETECTED"

SAN="DNS:localhost,IP:127.0.0.1"
for ip in $IPS; do
  [[ -n "$ip" ]] && SAN="$SAN,IP:$ip"
done
echo "subjectAltName = $SAN"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -days 825 -subj "/CN=immersive-player" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE"

chmod 600 "$OUT/key.pem"
echo
echo "✓ Certificado en $OUT/  (autofirmado, 825 días)."
echo "  Reinicia el server y entra por:  https://<IP-de-la-maquina>:${PORT:-60000}/"
echo "  La primera vez el Quest avisará de 'no seguro' → Avanzado → Continuar."
