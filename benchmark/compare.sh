#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: benchmark/compare.sh [BASELINE.json CANDIDATE.json]

With no arguments, compares the two newest files in benchmark/results/.
Regressions are printed in red and produce exit 1.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case $# in
  0)
    RESULTS=()
    while IFS= read -r result; do
      RESULTS+=("${result}")
    done < <(find "${SCRIPT_DIR}/results" -maxdepth 1 -type f -name '*.json' -print | sort)
    if [[ ${#RESULTS[@]} -lt 2 ]]; then
      printf '%s\n' 'Need at least two result files, or pass BASELINE and CANDIDATE explicitly.' >&2
      exit 2
    fi
    BASELINE="${RESULTS[$((${#RESULTS[@]} - 2))]}"
    CANDIDATE="${RESULTS[$((${#RESULTS[@]} - 1))]}"
    ;;
  2)
    BASELINE="$1"
    CANDIDATE="$2"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

python3 "${SCRIPT_DIR}/scripts/compare.py" \
  --policy "${SCRIPT_DIR}/policy.json" \
  "${BASELINE}" "${CANDIDATE}"
