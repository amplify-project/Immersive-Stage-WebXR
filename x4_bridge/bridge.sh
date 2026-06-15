#!/usr/bin/env bash

# Nombre de tu binario compilado
BINARY="./insta360_v4l2_bridge"

echo "======================================================"
# Asegurarnos de que el módulo v4l2loopback esté arriba
sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1 2>/dev/null
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
    
    echo "[Bash Watchdog] Reiniciando puente desde cero..."
    echo "------------------------------------------------------"
done
