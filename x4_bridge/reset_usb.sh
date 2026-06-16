#!/usr/bin/env bash
# Resetea por software el USB de la Insta360 (vendor 2e1a) vía unbind/bind en
# sysfs. Limpia el estado "zombi" que deja un SIGKILL del bridge: la interfaz USB
# queda reclamada sin liberar y el SDK falla con "timeout to wait for synchronize".
# Requiere root (escribe en /sys). Busca por vendor id, así es robusto a cambios
# de bus/puerto en la re-enumeración.

VID="2e1a"
found=0
for d in /sys/bus/usb/devices/*/; do
  [ -f "${d}idVendor" ] || continue
  if [ "$(cat "${d}idVendor" 2>/dev/null)" = "$VID" ]; then
    devid="$(basename "$d")"
    echo "[usb-reset] reseteando Insta360 en ${devid} ($(cat "${d}product" 2>/dev/null))..."
    echo -n "$devid" > /sys/bus/usb/drivers/usb/unbind 2>/dev/null || true
    sleep 1
    echo -n "$devid" > /sys/bus/usb/drivers/usb/bind 2>/dev/null || true
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  sleep 2   # margen para que el kernel re-enumere antes de relanzar el bridge
  echo "[usb-reset] hecho."
else
  echo "[usb-reset] no se encontró ninguna Insta360 (${VID}:*) en sysfs."
fi
