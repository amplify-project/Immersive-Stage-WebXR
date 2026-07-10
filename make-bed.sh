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
EOF
}

nch() { ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$1"; }

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

case "${1:-}" in
  -h|--help|'') usage; exit 0 ;;
  -l|--list) [[ $# -eq 2 ]] || { usage; exit 1; }; list "$2"; exit 0 ;;
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
