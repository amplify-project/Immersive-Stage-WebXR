# Insta360 live a camara virtual V4L2

Este directorio contiene un bridge C++ que abre una camara Insta360 con el SDK oficial, genera el video cosido en tiempo real con `RealTimeStitcher` y publica los frames en una camara virtual Linux compatible con V4L2.

Flujo:

```text
Insta360 CameraSDK -> MediaSDK RealTimeStitcher -> OpenCV RGBA a BGR24 -> /dev/videoX
```

El objetivo es poder consumir la Insta360 desde herramientas que esperan una webcam normal, por ejemplo OpenCV, ROS, GStreamer, OBS, navegadores o `ffmpeg`.

## Contenido

- `insta360_v4l2_bridge.cc`: codigo fuente del bridge.
- `download_sdk.sh`: descarga `models/` y `libs/` desde el servidor FTP.
- `build_insta360_v4l2_bridge.sh`: script de compilacion.
- `install_insta360_sdk.sh`: instala MediaSDK y CameraSDK desde `libs/`.
- `insta360_v4l2_bridge`: binario compilado.
- `models/`: modelos del MediaSDK necesarios para algunos modos/procesados del SDK.
- `libs/`: paquete `.deb` del MediaSDK y distribucion del CameraSDK.

## Requisitos

### SDK y librerias

Si `models/` y `libs/` no estan ya presentes, descargarlos desde el servidor FTP:

```bash
./download_sdk.sh
```

El script pide usuario y password de forma interactiva antes de conectar, para evitar el acceso anonimo por defecto del cliente FTP. Descarga:

- `ftp://192.168.15.2/NASV1/sharedV1/AMPLIFY/live_v4l2_insta360/models/` a `./models`
- `ftp://192.168.15.2/NASV1/sharedV1/AMPLIFY/live_v4l2_insta360/libs/` a `./libs`

Usa `wget` si esta instalado; si no, usa `lftp`. Hace descargas reanudables cuando el cliente lo soporta.

Instalar el SDK incluido en `libs/`:

```bash
./install_insta360_sdk.sh
```

El script hace:

- `sudo dpkg -i libs/libMediaSDK-dev-3.1.1.0-20250922_191110-amd64.deb`
- Copia `libs/CameraSDK-20250812_192742-2.1.1-Linux` a `/opt/insta360/CameraSDK-20250812_192742-2.1.1-Linux`
- Crea el enlace estable `/opt/insta360/CameraSDK`
- Registra `/opt/insta360/CameraSDK/lib` en `ldconfig`

El script de compilacion espera por defecto el CameraSDK instalado en:

```bash
/opt/insta360/CameraSDK
```

Tambien usa:

- `libCameraSDK.so`
- `libMediaSDK.so`
- OpenCV, al menos `opencv_core` y `opencv_imgproc`
- Headers de V4L2 de Linux
- `g++` con C++17
- `wget` o `lftp` si se quiere descargar `models/` y `libs/` desde FTP

Si el CameraSDK esta en otra ruta, se puede indicar con `CAMERA_SDK_ROOT`:

```bash
CAMERA_SDK_ROOT=/ruta/al/CameraSDK ./build_insta360_v4l2_bridge.sh
```

### Camara virtual V4L2

Hace falta `v4l2loopback`. En Ubuntu/Debian:

```bash
sudo apt update
sudo apt install v4l2loopback-dkms v4l2loopback-utils v4l-utils
```

Despues cargar el modulo creando, por ejemplo, `/dev/video10`:

```bash
sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1
```

Comprobar que existe:

```bash
ls -l /dev/video10
v4l2-ctl --list-devices
```

## Compilar

Desde este directorio:

```bash
./build_insta360_v4l2_bridge.sh
```

Esto genera o actualiza:

```bash
./insta360_v4l2_bridge
```

Comprobar dependencias enlazadas:

```bash
ldd ./insta360_v4l2_bridge | grep -E "CameraSDK|MediaSDK|opencv|not found"
```

Si aparece `not found`, falta alguna ruta de libreria en el sistema o hay que ajustar `LD_LIBRARY_PATH`.

## Ejecutar

Con la Insta360 conectada y `/dev/video10` creado:

```bash
./insta360_v4l2_bridge --device /dev/video10 --output 960x480
```

Para mas resolucion:

```bash
./insta360_v4l2_bridge \
  --device /dev/video10 \
  --output 1920x960 \
  --stream-res 1920x960p30
```

Parar con `Ctrl+C`.

## Opciones

Ver ayuda:

```bash
./insta360_v4l2_bridge --help
```

Opciones disponibles:

- `--device PATH`: dispositivo V4L2 de salida. Por defecto `/dev/video10`.
- `--output WxH`: resolucion del frame cosido publicado en V4L2. Por defecto `960x480`.
- `--fps N`: FPS anunciados por el dispositivo V4L2. Por defecto `30`.
- `--bitrate N`: bitrate del live stream solicitado a la camara. Por defecto `1048576`.
- `--stream-res NAME`: resolucion del stream de entrada de la camara. Valores soportados:
  - `1440x720p30`
  - `1920x960p30`
  - `2560x1280p30`
  - `960x480p30`
- `--no-flowstate`: desactiva FlowState.

## Probar la camara virtual

Con `ffmpeg`/`ffplay`:

```bash
ffplay -f v4l2 -input_format bgr24 -video_size 960x480 /dev/video10
```

Con `v4l2-ctl`:

```bash
v4l2-ctl --device=/dev/video10 --all
v4l2-ctl --device=/dev/video10 --list-formats-ext
```

Con OpenCV en Python:

```python
import cv2

cap = cv2.VideoCapture("/dev/video10", cv2.CAP_V4L2)
while True:
    ok, frame = cap.read()
    if not ok:
        break
    cv2.imshow("Insta360 V4L2", frame)
    if cv2.waitKey(1) == 27:
        break

cap.release()
cv2.destroyAllWindows()
```

## Notas de implementacion

El SDK entrega los frames cosidos en el callback:

```cpp
stitcher->SetStitchRealTimeDataCallback(...)
```

El bridge crea un `cv::Mat` `RGBA`, lo convierte a `BGR24` con OpenCV y lo escribe en `/dev/videoX`. La salida V4L2 se configura con:

```cpp
V4L2_PIX_FMT_BGR24
```

El hilo del callback no escribe directamente al dispositivo. En su lugar deja el ultimo frame en una cola de tamano efectivo 1. Asi se evita bloquear el hilo del SDK si el consumidor V4L2 va mas lento.

## Problemas frecuentes

### `error: open /dev/video10: No such file or directory`

No existe la camara virtual. Cargar `v4l2loopback`:

```bash
sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1
```

### `/dev/video10 is not a V4L2 video output device`

El dispositivo existe, pero no es un dispositivo de salida. Asegurarse de usar un nodo creado por `v4l2loopback`, no una webcam fisica.

### Permiso denegado al abrir `/dev/video10`

Comprobar permisos:

```bash
ls -l /dev/video10
groups
```

Soluciones tipicas:

```bash
sudo usermod -aG video "$USER"
```

Despues cerrar sesion y volver a entrar. Para una prueba rapida tambien se puede ejecutar el bridge con `sudo`, aunque no es lo ideal para uso diario.

### `no Insta360 device found`

El SDK no detecta la camara. Revisar:

- La camara esta encendida y conectada.
- El modo USB/conexion de la camara es compatible con el SDK.
- No hay otro proceso usando la camara.
- El demo original `realtime_stitcher_demo` funciona en esta maquina.

### `failed to start live stream`

La camara se abre, pero no acepta iniciar el live stream. Probar:

- Otra resolucion con `--stream-res`.
- Menor salida, por ejemplo `--output 960x480`.
- Cerrar otros procesos que usen la camara.
- Reiniciar la camara.

### Imagen negra o consumidor bloqueado

Comprobar que el consumidor usa el tamano correcto:

```bash
ffplay -f v4l2 -input_format bgr24 -video_size 960x480 /dev/video10
```

Si se ejecuto el bridge con `--output 1920x960`, usar `-video_size 1920x960`.

## Ejemplo completo

```bash
cd /home/VICOMTECH/aelosegi/live_v4l2_insta360

./download_sdk.sh

./install_insta360_sdk.sh

./build_insta360_v4l2_bridge.sh

sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1

./insta360_v4l2_bridge --device /dev/video10 --output 960x480
```

En otra terminal:

```bash
ffplay -f v4l2 -input_format bgr24 -video_size 960x480 /dev/video10
```
