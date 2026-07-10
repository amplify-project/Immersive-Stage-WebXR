#!/usr/bin/env bash
# make-bed.sh — construye el WAV de 4 canales que va en scene.json → "bed".
#
# El resto de la cadena (stream.sh, tools/bedAnalysis.js) da por hecho que el
# canal 0 del bed es la primera componente ambisónica, el 1 la segunda, etc. Un
# fichero con más canales NO se puede usar: nadie sabe cuáles de ellos son la
# FOA, y ffmpeg cogería los cuatro primeros sin rechistar. De ahí este paso.
#
# El caso que se ha dado: un editor de vídeo (Clipchamp) exporta las 4 pistas
# como un 7.1, duplicando cada una en dos canales. Se ve al listar niveles: los
# canales van en parejas idénticas.
#
#   ./make-bed.sh -l media/ambisionic03.wav          ← qué lleva cada canal
#   ./make-bed.sh media/ambisionic03.wav media/bed03.wav 0,2,4,6
#
# Con un fichero que ya tiene 4 canales basta con:
#   ./make-bed.sh media/toma.wav media/bed.wav       ← copia 0,1,2,3
#
# NO toca el orden ni la ganancia: si la toma es FuMa sale FuMa, y el ×√2 de la
# W lo aplica stream.sh al convertir a AmbiX. Los índices que le des son los que
# escribe, en ese orden. Si el campo sonoro suena girado, eso lo arregla
# `alignment` en la escena, no este script.
set -euo pipefail

usage() {
  cat <<'EOF'
Uso:
  ./make-bed.sh -l|--list <entrada>
        Lista los canales de <entrada> con su nivel, y avisa si van duplicados.

  ./make-bed.sh <entrada> <salida.wav> [c0,c1,c2,c3]
        Escribe un WAV de 4 canales tomando esos canales de <entrada>, en ese
        orden. Sin índices: 0,1,2,3 (solo si la entrada tiene 4 canales).

  ./make-bed.sh -m|--merge <W> <X> <Y> <Z> <salida.wav> [fuma|ambix]
        Junta cuatro WAV mono, uno por componente, en un WAV de 4 canales. Los
        argumentos van SIEMPRE por componente (W, X, Y, Z); lo que cambia con el
        formato es el orden en que se escriben:
            fuma  (por defecto) → W,X,Y,Z      ambix → W,Y,Z,X
        Escribe el orden, NO renormaliza: si las componentes venían con
        normalización FuMa, siguen con ella. El ×√2 de la W lo aplica stream.sh.
        Ese formato es el que hay que declarar en scene.json → "bedFormat".
EOF
}

nch() { ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$1"; }
srate() { ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$1"; }
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# Nivel RMS y pico de un canal, en dB.
level() {
  ffmpeg -hide_banner -nostats -t 60 -i "$1" \
    -filter_complex "[0:a]pan=mono|c0=c$2,volumedetect[a]" -map "[a]" -f null - 2>&1 |
    grep -oP '(mean|max)_volume: \K[-0-9.]+' | tr '\n' ' '
}

# Pico de la diferencia entre dos canales. Muy por debajo del suelo de ruido del
# formato ⇒ son el mismo canal escrito dos veces.
diff_peak() {
  ffmpeg -hide_banner -nostats -t 60 -i "$1" \
    -filter_complex "[0:a]pan=mono|c0=c$2-c$3,volumedetect[a]" -map "[a]" -f null - 2>&1 |
    grep -oP 'max_volume: \K[-0-9.]+'
}

list() {
  local in="$1" n; n=$(nch "$in")
  echo "$in → $n canales"
  for (( c = 0; c < n; c++ )); do
    printf '  c%-2d  media/pico dB: %s\n' "$c" "$(level "$in" "$c")"
  done

  # ¿Parejas idénticas? Entonces los canales útiles son los pares.
  if (( n >= 2 && n % 2 == 0 )); then
    local dup=1
    for (( c = 0; c < n; c += 2 )); do
      awk -v v="$(diff_peak "$in" "$c" $((c+1)))" 'BEGIN{exit !(v < -80)}' || { dup=0; break; }
    done
    if (( dup == 1 )); then
      local sel=""
      for (( c = 0; c < n; c += 2 )); do sel+="${sel:+,}$c"; done
      echo
      echo "Los canales van en parejas idénticas: hay $((n/2)) canales reales, duplicados."
      echo "Los útiles son:  $sel"
    fi
  fi
}

# Cuatro monos, uno por componente, a un WAV de 4 canales. Argumentos por
# componente y no por posición: quien tiene los ficheros sabe cuál es la W, pero
# el orden en que hay que escribirlos depende del formato, y ahí es donde se
# cuela el campo sonoro girado sin que nadie se dé cuenta.
merge() {
  local w="$1" x="$2" y="$3" z="$4" out="$5" fmt="${6:-fuma}"
  local names=(W X Y Z) files=("$w" "$x" "$y" "$z")

  for i in "${!files[@]}"; do
    local f="${files[$i]}"
    [[ -f "$f" ]] || { echo "No existe la ${names[$i]}: $f"; exit 1; }
    local n; n=$(nch "$f")
    (( n == 1 )) || { echo "La ${names[$i]} ('$f') tiene $n canales, no 1. Extrae el mono primero."; exit 1; }
  done
  [[ -e "$out" ]] && { echo "Ya existe: $out (bórralo tú si de verdad quieres reemplazarlo)"; exit 1; }

  # Distintas frecuencias de muestreo ⇒ join no alinea nada, mezcla basura.
  local sr0; sr0=$(srate "$w")
  for i in "${!files[@]}"; do
    local sr; sr=$(srate "${files[$i]}")
    [[ "$sr" == "$sr0" ]] || { echo "La ${names[$i]} va a $sr Hz y la W a $sr0 Hz. Reamuestrea antes."; exit 1; }
  done

  # join corta por la más corta: si una componente está recortada, el bed sale
  # mudo desde ahí y no lo dice nadie. Mejor avisar ahora.
  local d0; d0=$(dur "$w")
  for i in "${!files[@]}"; do
    local d; d=$(dur "${files[$i]}")
    awk -v a="$d" -v b="$d0" 'BEGIN{exit !(a-b > 0.05 || b-a > 0.05)}' &&
      echo "⚠  ${names[$i]} dura ${d}s y la W ${d0}s: el bed se cortará por la más corta."
  done

  # Orden de escritura según el formato declarado. FuMa: W,X,Y,Z. AmbiX/ACN: W,Y,Z,X.
  local ord
  case "$fmt" in
    fuma)  ord=(0 1 2 3) ;;
    ambix) ord=(0 2 3 1) ;;
    *) echo "Formato desconocido: '$fmt' (fuma|ambix)"; exit 1 ;;
  esac

  # amerge, NO join: con entradas mono todos los canales se llaman FC, y join los
  # coloca por nombre dentro del layout de salida — la W acaba en el canal 2 y el
  # campo sonoro sale girado sin un solo aviso. amerge concatena en orden de
  # entrada; el pan de después solo fija el layout a 4.0.
  ffmpeg -hide_banner -v error \
    -i "${files[${ord[0]}]}" -i "${files[${ord[1]}]}" \
    -i "${files[${ord[2]}]}" -i "${files[${ord[3]}]}" \
    -filter_complex "[0:a][1:a][2:a][3:a]amerge=inputs=4,pan=4.0|c0=c0|c1=c1|c2=c2|c3=c3[a]" \
    -map "[a]" -c:a pcm_s24le "$out"

  echo "→ $out  (4 canales, $fmt: ${names[${ord[0]}]},${names[${ord[1]}]},${names[${ord[2]}]},${names[${ord[3]}]})"
  echo
  echo "En scene.json:   \"bed\": \"$out\",  \"bedFormat\": \"$fmt\""
  echo "Y mide la rotación del micro con «Analyse bed» en el editor."
}

case "${1:-}" in
  -h|--help|'') usage; exit 0 ;;
  -l|--list) [[ $# -eq 2 ]] || { usage; exit 1; }; list "$2"; exit 0 ;;
  -m|--merge)
    shift
    [[ $# -eq 5 || $# -eq 6 ]] || { usage; exit 1; }
    merge "$@"; exit 0 ;;
esac

[[ $# -ge 2 ]] || { usage; exit 1; }
IN="$1"; OUT="$2"; CH="${3:-}"

[[ -f "$IN" ]] || { echo "No existe: $IN"; exit 1; }
# Un bed es caro de volver a grabar y barato de volver a generar: no se pisa.
[[ -e "$OUT" ]] && { echo "Ya existe: $OUT (bórralo tú si de verdad quieres reemplazarlo)"; exit 1; }

N=$(nch "$IN")

if [[ -z "$CH" ]]; then
  if (( N != 4 )); then
    echo "'$IN' tiene $N canales: no puedo adivinar cuáles son la FOA."
    echo "Míralos con  ./make-bed.sh -l '$IN'  y pásalos:  ./make-bed.sh '$IN' '$OUT' a,b,c,d"
    exit 1
  fi
  CH="0,1,2,3"
fi

IFS=',' read -r -a C <<< "$CH"
(( ${#C[@]} == 4 )) || { echo "Hacen falta 4 índices separados por comas, no ${#C[@]}: '$CH'"; exit 1; }
for c in "${C[@]}"; do
  [[ "$c" =~ ^[0-9]+$ ]] && (( c < N )) || { echo "Canal fuera de rango: '$c' (la entrada tiene $N)"; exit 1; }
done

ffmpeg -hide_banner -v error -i "$IN" \
  -filter_complex "[0:a]pan=4.0|c0=c${C[0]}|c1=c${C[1]}|c2=c${C[2]}|c3=c${C[3]}[a]" -map "[a]" \
  -c:a pcm_s24le "$OUT"

echo "→ $OUT  (4 canales, desde ${C[0]},${C[1]},${C[2]},${C[3]} de $IN)"
echo
echo "En scene.json:   \"bed\": \"$OUT\""
echo "Y vuelve a medir la rotación del micro con «Analyse bed» en el editor:"
echo "el alignment que tengas ahora se midió sobre el fichero antiguo."
