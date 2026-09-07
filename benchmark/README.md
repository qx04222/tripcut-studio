# TripCut Travel-native Benchmark

This directory is the P5-F4 local regression apparatus. It contains no media
and never uses Git. The application-facing driver is deliberately separate so
the benchmark cannot turn direct database writes into a false application pass.

## Dataset

- A Attractions: 16 Seed fixtures
- B Road/weather: 16 Seed fixtures
- C RV life/Routine: 16 Seed fixtures
- D People/dialogue/reaction: 16 Seed fixtures
- E Digital-human rhythm: 16 Seed fixtures
- F Technical/time edges: 17 Seed fixtures
- G Bad-but-important: 6 generated fixtures

A-F are exactly the existing 97-item Seed allocation. Canonical media paths are
stored in each manifest (`A/A-001.mov` through the listed F paths). If external
filenames differ, provide a local JSON map; do not copy media into this repo:

```json
{
  "fixtures": {
    "A-001": "A/original-camera-name.mov",
    "F-006": "phone/vfr-original.mov"
  }
}
```

Relative mapped paths are resolved from `--media-root`. Every resolved path must
remain below `--media-root`. Put local maps under `benchmark/local/`; that path,
all media extensions, generated work and result JSON are ignored here.

The manifests use integer microseconds. `scene_boundaries_us: null` means the
Seed clip has not received a frame-level scene-boundary answer key and is
excluded from Scene P/R; it is not treated as “no cuts.” Group G has a known
4-second boundary. Stack/event/Routine/Golden annotations remain active across
all groups. The metrics report annotation counts so coverage is visible.

Golden Moments are duplicated intentionally: `golden: true` is beside each
fixture, while `annotations/golden-moments.json` is the auditable release list.
The runner requires the two sets to match. All G fixtures plus one representative
from A-F are Golden. Any Golden fixture outside `(recommended || retained) &&
!rejected` makes Critical Recall below 100% and fails the locked gate.

## G fixture generation

Group G generation uses ffmpeg/ffprobe and the macOS `say` synthesizer. The
script refuses an output path inside the repository.

```bash
./benchmark/scripts/generate-g.sh --output /tmp/tripcut-g
./benchmark/scripts/generate-g.sh --case G-001 --output /tmp/tripcut-g
```

It creates strong shake + unique bear narration, underexposed stuck-vehicle,
vertical hail, defocused reaction, noisy night failure, and wind-noise unique
talking-head clips. Each manifest records its single-case generation command.

## Application driver

The current desktop surface needs an adapter that can invoke the real app flow.
The executable contract is in `DRIVER_CONTRACT.md`; its JSON output is defined by
`observations.schema.json`. The request contains no answer key. A missing driver
is a hard failure—`run.sh` never simulates Stack or edits the application DB.

## Run

```bash
./benchmark/run.sh \
  --media-root /Volumes/TravelBenchmark/Seed97 \
  --seed-map benchmark/local/seed-map.json \
  --driver /absolute/path/to/tripcut-benchmark-driver
```

Add `--with-l3` to run the optional narrative stage, or `--keep-work` to keep
the temporary clean DB, generated G media and export for manual review. The
default skips L3 but still requires import → all analysis → Stack → export.

The runner performs these operations:

1. validates seven manifests, exactly 97 Seed fixtures, Group G and Golden parity;
2. generates G outside the repository;
3. resolves all external media and hashes both complete Seed and synthetic trees;
4. gives a nonexistent clean DB path and export path to the application driver;
5. hashes both trees again and computes all metrics and gates;
6. atomically writes `benchmark/metrics.json` and preserves an ISO-UTC dated
   result under `benchmark/results/` (`YYYY-MM-DDTHHMMSSZ.json`).

The result covers Scene boundary P/R, pairwise Stack precision, important-event
and Critical recall, all three Safety measures, raw-source delete/modify/add
counts, VFR and Proxy PTS error, and Routine repetition rate. Missing fixtures or
time-mapping checkpoints are explicit failed gates.

## Compare

```bash
./benchmark/compare.sh
./benchmark/compare.sh benchmark/results/2026-09-01T120000Z.json /path/to/candidate.json
```

With no paths it compares the two newest dated results. Higher-is-better and
lower-is-better metrics are handled separately; regressions are printed in red
and return exit 1. Thresholds live in `policy.json`. Critical Recall 100% and an
unchanged source tree are also locked directly by the evaluator.

Runtime JSON and media are intentionally absent from the repository. A first
baseline must be produced by the designated reviewer with the real driver and
external Seed97 dataset.
