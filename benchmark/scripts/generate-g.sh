#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: generate-g.sh --output /absolute/outside/repo/directory [--case G-001]

Generates all six Group G fixtures, or one fixture selected by --case.
Requires ffmpeg, ffprobe and macOS `say`. Output media is refused inside the
repository so synthetic clips cannot be committed accidentally.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCHMARK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${BENCHMARK_DIR}/.." && pwd)"
OUTPUT_DIR=""
ONLY_CASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --case)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      ONLY_CASE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "${OUTPUT_DIR}" ]] || { usage >&2; exit 2; }
command -v ffmpeg >/dev/null || { printf 'ffmpeg is required\n' >&2; exit 127; }
command -v ffprobe >/dev/null || { printf 'ffprobe is required\n' >&2; exit 127; }
command -v say >/dev/null || { printf 'macOS say is required\n' >&2; exit 127; }

mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd "${OUTPUT_DIR}" && pwd)"
case "${OUTPUT_DIR}/" in
  "${REPO_DIR}/"*)
    printf 'Refusing to create media inside repository: %s\n' "${OUTPUT_DIR}" >&2
    exit 2
    ;;
esac
mkdir -p "${OUTPUT_DIR}/G"

if [[ -n "${ONLY_CASE}" ]] && [[ ! "${ONLY_CASE}" =~ ^G-00[1-6]$ ]]; then
  printf 'Unknown Group G fixture: %s\n' "${ONLY_CASE}" >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tripcut-g.XXXXXX")"
trap 'rm -rf "${TEMP_DIR}"' EXIT

make_voice() {
  local fixture_id="$1"
  local text="$2"
  say -v Samantha -r 165 -o "${TEMP_DIR}/${fixture_id}.aiff" "${text}"
}

render_fixture() {
  local fixture_id="$1"
  local filename="$2"
  local text="$3"
  local size="$4"
  local effect="$5"
  local noise_volume="$6"
  local voice_volume="$7"
  local output="${OUTPUT_DIR}/G/${filename}"

  if [[ -n "${ONLY_CASE}" && "${fixture_id}" != "${ONLY_CASE}" ]]; then
    return
  fi

  make_voice "${fixture_id}" "${text}"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=30000/1001:duration=4" \
    -f lavfi -i "smptebars=size=${size}:rate=30000/1001:duration=4" \
    -i "${TEMP_DIR}/${fixture_id}.aiff" \
    -f lavfi -i "anoisesrc=color=pink:amplitude=0.9:sample_rate=48000:duration=8" \
    -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0,${effect},format=yuv420p[v];[2:a]adelay=700|700,apad=whole_dur=8,atrim=duration=8,volume=${voice_volume}[voice];[3:a]volume=${noise_volume}[noise];[voice][noise]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]" \
    -map '[v]' -map '[a]' -t 8 \
    -c:v libx264 -preset veryfast -crf 24 \
    -c:a aac -b:a 160k -ar 48000 \
    -movflags +faststart "${output}"

  ffprobe -v error -show_entries format=duration -of csv=p=0 "${output}" >/dev/null
  printf 'generated %s\n' "${output}"
}

render_fixture \
  "G-001" "G-001.mp4" \
  "A bear crossed the road. This is the only recording. Keep this moment." \
  "1360x800" \
  "crop=1280:720:x='40+35*sin(53*t)':y='40+30*cos(47*t)',eq=contrast=1.2:saturation=0.7" \
  "0.10" "1.15"

render_fixture \
  "G-002" "G-002.mp4" \
  "We are stuck in deep mud after midnight. This explains why the trip stopped." \
  "1280x720" \
  "eq=brightness=-0.72:contrast=1.45:saturation=0.45,noise=alls=18:allf=t" \
  "0.18" "1.10"

render_fixture \
  "G-003" "G-003.mp4" \
  "Hail started without warning. The roof is taking damage. Keep the vertical clip." \
  "720x1280" \
  "noise=alls=28:allf=t+u,eq=contrast=1.35:saturation=0.55" \
  "0.45" "1.05"

render_fixture \
  "G-004" "G-004.mp4" \
  "That was our real first reaction. The camera missed focus but the moment cannot be repeated." \
  "1280x720" \
  "gblur=sigma=18:steps=3,eq=brightness=-0.08:saturation=0.8" \
  "0.08" "1.10"

render_fixture \
  "G-005" "G-005.mp4" \
  "The engine failed on the remote road at night. This is the only fault record." \
  "1280x720" \
  "eq=brightness=-0.62:contrast=1.7:saturation=0.25,noise=alls=42:allf=t+u" \
  "0.28" "1.05"

render_fixture \
  "G-006" "G-006.mp4" \
  "The bridge is closed. We must turn back. This is the only spoken explanation." \
  "1280x720" \
  "eq=contrast=0.85:saturation=0.65,noise=alls=12:allf=t" \
  "0.78" "0.62"
