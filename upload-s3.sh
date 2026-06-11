#!/usr/bin/env bash
# ============================================================================
#  upload-s3.sh — Publishes the DASH output ($OUT) to S3 in real time so a CDN
#  (CloudFront) can serve the live stream. stream.sh launches this in the
#  background during LIVE when S3_BUCKET is set; you can also run it standalone.
#
#  Usage:
#     S3_BUCKET=s3://my-bucket/live ./upload-s3.sh         # loop (live)
#     S3_BUCKET=s3://my-bucket/vod ONESHOT=1 ./upload-s3.sh # single pass (VOD)
#
#  Env:
#     S3_BUCKET   (required)  destino, p.ej. s3://bucket/prefijo
#     OUT=encoded             carpeta DASH local a subir
#     REGION=                 región AWS (opcional)
#     INTERVAL=1              segundos entre pasadas (modo loop)
#     ONESHOT=0               1 → una sola pasada y salir (para VOD)
#
#  Requisitos: AWS CLI (`aws configure` con credenciales). El bucket debe tener
#  CORS para que el navegador de la Quest pueda leerlo (GET + cabecera Range),
#  y lectura pública o vía CloudFront (OAC).
#
#  Orden de subida importante para evitar 404 en el player:
#     1) primero los segmentos + init (inmutables, cache larga)
#     2) el manifest al final (no-cache → el player ve el timeline fresco)
# ============================================================================
set -euo pipefail

OUT="${OUT:-encoded}"
DEST="${S3_BUCKET:?Define S3_BUCKET=s3://bucket/prefijo}"
DEST="${DEST%/}"
REGION="${REGION:-}"
INTERVAL="${INTERVAL:-1}"
ONESHOT="${ONESHOT:-0}"

command -v aws >/dev/null || { echo "AWS CLI no encontrado (instala awscli y haz 'aws configure')"; exit 1; }
REGION_ARG=(); [[ -n "$REGION" ]] && REGION_ARG=(--region "$REGION")

# Sube por tipo con su Content-Type y cache larga (los segmentos son inmutables).
sync_type() {  # $1 = glob   $2 = content-type
  aws s3 sync "$OUT" "$DEST" --exclude "*" --include "$1" --size-only \
    --content-type "$2" --cache-control "public,max-age=31536000,immutable" \
    "${REGION_ARG[@]}" --only-show-errors
}

upload_once() {
  sync_type "*.m4s"  "video/iso.segment"
  sync_type "*.mp4"  "video/mp4"
  sync_type "*.webm" "video/webm"
  # Manifest al final, sin cache para que el player relea el timeline en vivo.
  if [[ -f "$OUT/manifest.mpd" ]]; then
    aws s3 cp "$OUT/manifest.mpd" "$DEST/manifest.mpd" \
      --content-type "application/dash+xml" \
      --cache-control "no-cache,no-store,must-revalidate" \
      "${REGION_ARG[@]}" --only-show-errors
  fi
}

if [[ "$ONESHOT" == "1" ]]; then
  echo "▶ Subida única $OUT/ → $DEST"
  upload_once
  echo "✓ Subido"
  exit 0
fi

echo "▶ Publicando $OUT/ → $DEST  cada ${INTERVAL}s   [Ctrl-C para parar]"
while true; do
  upload_once || echo "  ⚠ fallo en una pasada de subida (reintento en ${INTERVAL}s)"
  sleep "$INTERVAL"
done
