#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  benchmark/run.sh --media-root /path/to/seed [options]

Required:
  --media-root DIR   External root containing canonical A/... through F/... files.

Options:
  --driver FILE      Override the repository core driver with another executable
                     implementing benchmark/DRIVER_CONTRACT.md.
  --seed-map FILE    JSON fixture-id to path overrides; every path must remain
                     under --media-root.
  --with-l3          Run optional L3 narrative orchestration (default: skip).
  --keep-work        Preserve the temporary DB, generated G media and export.
  -h, --help         Show this help.

The same values may be supplied through TRIPCUT_BENCHMARK_MEDIA_ROOT,
TRIPCUT_BENCHMARK_DRIVER and TRIPCUT_BENCHMARK_SEED_MAP.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA_ROOT="${TRIPCUT_BENCHMARK_MEDIA_ROOT:-}"
DRIVER="${TRIPCUT_BENCHMARK_DRIVER:-}"
SEED_MAP="${TRIPCUT_BENCHMARK_SEED_MAP:-}"
L3_MODE="skip"
KEEP_WORK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --media-root)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      MEDIA_ROOT="$2"
      shift 2
      ;;
    --driver)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      DRIVER="$2"
      shift 2
      ;;
    --seed-map)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      SEED_MAP="$2"
      shift 2
      ;;
    --with-l3)
      L3_MODE="run"
      shift
      ;;
    --keep-work)
      KEEP_WORK=1
      shift
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

[[ -n "${MEDIA_ROOT}" ]] || { printf '%s\n' '--media-root is required' >&2; exit 2; }
[[ -d "${MEDIA_ROOT}" ]] || { printf 'media root is not a directory: %s\n' "${MEDIA_ROOT}" >&2; exit 2; }
if [[ -n "${DRIVER}" ]]; then
  [[ -x "${DRIVER}" ]] || { printf 'driver is not executable: %s\n' "${DRIVER}" >&2; exit 2; }
else
  command -v cargo >/dev/null || { printf 'cargo is required for the repository benchmark driver\n' >&2; exit 127; }
fi
if [[ -n "${SEED_MAP}" && ! -f "${SEED_MAP}" ]]; then
  printf 'seed map is not a file: %s\n' "${SEED_MAP}" >&2
  exit 2
fi
command -v python3 >/dev/null || { printf 'python3 is required\n' >&2; exit 127; }

RUN_ID="$(date -u +%Y-%m-%dT%H%M%SZ)-$$"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tripcut-benchmark.XXXXXX")"
cleanup() {
  if [[ "${KEEP_WORK}" -eq 1 ]]; then
    printf 'work directory preserved: %s\n' "${RUN_DIR}"
  else
    rm -rf "${RUN_DIR}"
  fi
}
trap cleanup EXIT

"${SCRIPT_DIR}/scripts/generate-g.sh" --output "${RUN_DIR}/media"

PREPARE=(
  python3 "${SCRIPT_DIR}/scripts/benchmark.py" prepare
  --manifests "${SCRIPT_DIR}/manifests"
  --golden "${SCRIPT_DIR}/annotations/golden-moments.json"
  --media-root "${MEDIA_ROOT}"
  --synthetic-root "${RUN_DIR}/media"
  --run-dir "${RUN_DIR}"
  --run-id "${RUN_ID}"
  --l3 "${L3_MODE}"
)
if [[ -n "${SEED_MAP}" ]]; then
  PREPARE+=(--seed-map "${SEED_MAP}")
fi
"${PREPARE[@]}"

set +e
if [[ -n "${DRIVER}" ]]; then
  "${DRIVER}" --request "${RUN_DIR}/request.json" --output "${RUN_DIR}/observations.json"
else
  (
    cd "${SCRIPT_DIR}/../src-tauri"
    cargo run --example bench_driver -- \
      --request "${RUN_DIR}/request.json" \
      --output "${RUN_DIR}/observations.json"
  )
fi
DRIVER_STATUS=$?
set -e
if [[ ! -f "${RUN_DIR}/observations.json" ]]; then
  printf 'driver exited %s and did not write observations.json\n' "${DRIVER_STATUS}" >&2
  if [[ "${DRIVER_STATUS}" -eq 0 ]]; then
    exit 1
  fi
  exit "${DRIVER_STATUS}"
fi

set +e
python3 "${SCRIPT_DIR}/scripts/benchmark.py" evaluate \
  --manifests "${SCRIPT_DIR}/manifests" \
  --golden "${SCRIPT_DIR}/annotations/golden-moments.json" \
  --policy "${SCRIPT_DIR}/policy.json" \
  --request "${RUN_DIR}/request.json" \
  --before "${RUN_DIR}/source-before.json" \
  --observations "${RUN_DIR}/observations.json" \
  --output "${RUN_DIR}/metrics.json"
EVALUATE_STATUS=$?
set -e

if [[ -f "${RUN_DIR}/metrics.json" ]]; then
  METRICS_TEMP="${SCRIPT_DIR}/metrics.json.tmp-$$"
  cp "${RUN_DIR}/metrics.json" "${METRICS_TEMP}"
  mv "${METRICS_TEMP}" "${SCRIPT_DIR}/metrics.json"

  RESULT_DATE="$(date -u +%Y-%m-%dT%H%M%SZ)"
  RESULT_PATH="${SCRIPT_DIR}/results/${RESULT_DATE}.json"
  if [[ -e "${RESULT_PATH}" ]]; then
    RESULT_PATH="${SCRIPT_DIR}/results/${RESULT_DATE}-$$.json"
  fi
  cp "${RUN_DIR}/metrics.json" "${RESULT_PATH}"
  printf 'metrics: %s\n' "${SCRIPT_DIR}/metrics.json"
  printf 'result:  %s\n' "${RESULT_PATH}"
fi

# 评估器是唯一权威:driver 非零可能只是预期损坏夹具(request 不含答案,driver 无从豁免),
# 评估器已校验失败集⊆预期集。metrics PASS ⟺ exit 0。
if [[ "${DRIVER_STATUS}" -ne 0 ]]; then
  printf 'note: driver exited %s (deterministic failures audited by evaluator)\n' "${DRIVER_STATUS}" >&2
fi
exit "${EVALUATE_STATUS}"
