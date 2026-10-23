#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Nombre de tu binario compilado
BINARY="./insta360_v4l2_bridge"

echo "======================================================"
# A FRESH v4l2loopback on every start, not just "make sure it is loaded".
# A module left from the last session keeps that session's state: after the
# bridge was killed (SIGKILL in the watchdog or from the editor's Stop), the
# exclusive_caps device can stay stuck with the old writer's format/state, and
# the new bridge or the live's ffmpeg then fail to use /dev/video10. Reloading
# was the manual fix (modprobe -r + modprobe); launch_insta360_v4l2_bridge.sh
# always did it, this script did not.
LOOP_DEV=/dev/video10
LOOP_ARGS=(video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1)
if lsmod | grep -q '^v4l2loopback '; then
    echo "Recargando v4l2loopback (estado limpio para $LOOP_DEV)..."
    if ! sudo modprobe -r v4l2loopback 2>/dev/null; then
        # Someone has a loopback device open: name them, the reload cannot happen.
        echo "⚠ No se pudo recargar v4l2loopback: está en uso. Lo tienen abierto:"
        sudo fuser -v "$LOOP_DEV" 2>&1 | sed 's/^/    /'
        echo "  Para el directo/vista previa que lo use (o mata ese pid) y vuelve a iniciar el puente."
        echo "  Sigo con el módulo tal como está: puede que $LOOP_DEV no funcione."
    fi
fi
lsmod | grep -q '^v4l2loopback ' || sudo modprobe v4l2loopback "${LOOP_ARGS[@]}"
[[ -e "$LOOP_DEV" ]] || echo "✕ $LOOP_DEV no existe tras cargar v4l2loopback (¿otro video_nr en /etc/modprobe.d?)."
echo "Iniciando Watchdog persistente en Bash..."
echo "======================================================"

while true; do
    # Ejecutar el puente de video
    sudo $BINARY
    
    # Si llega aquí, es porque el programa ha fallado o el Watchdog de C++ lo ha cerrado
    echo "[Bash Watchdog] El programa se detuvo. Aplicando purga total de memoria RAM y USB..."
    
    # Forzar la muerte de cualquier hilo huérfano del SDK
    sudo killall -9 insta360_v4l2_bridge 2>/dev/null

    # Espera de cortesía para que el Kernel de Linux limpie los descriptores USB
    sleep 2

    # Reset del USB: el SIGKILL deja la interfaz reclamada (USB zombi) y el SDK
    # falla con "timeout to wait for synchronize". unbind/bind lo limpia.
    sudo bash "${SCRIPT_DIR}/reset_usb.sh"

    echo "[Bash Watchdog] Reiniciando puente desde cero..."
    echo "------------------------------------------------------"
done
