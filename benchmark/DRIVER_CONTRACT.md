# TripCut Benchmark Driver Contract

`run.sh` intentionally does not inspect or mutate `project.db` as a substitute
for application behavior. A driver must exercise the application-under-test and
translate its observable output to one stable JSON contract.

## Invocation

```text
<driver> --request /absolute/request.json --output /absolute/observations.json
```

The driver must return non-zero on workflow failure. It should still write an
observations file when possible so the runner can preserve a red metrics result.
The driver must not call Git, modify source media, or write outside the request's
temporary database/export locations and the output file.

## Request

The request contains:

- `database_path`: a nonexistent path reserved for a clean project database;
- `export_directory`: a nonexistent temporary export destination;
- `l3_mode`: `skip` or `run`;
- `fixtures[]`: opaque fixture ID, group, absolute external media path and the
  VFR/Proxy source-time checkpoints the driver must observe.

Checkpoints are observation coordinates, not expected results. Scenario
descriptions, expected labels, Golden status and thresholds remain deliberately
absent so the application cannot pass by echoing the answer key.

## Required application workflow

1. Start with exactly `database_path`; refuse a pre-existing project database.
2. Import every requested media path through the real import path.
3. Wait for all enabled analysis, transcript, proxy and classification jobs.
4. Run Scene and Shot Stack generation.
5. Run L3 only when requested; otherwise record `l3: skipped`.
6. Export through the real export path and wait for completion.
7. Read observable application state into `observations.schema.json`.

All time values are signed integer microseconds. `scene_boundaries_us` excludes
clip start/end. For every checkpoint requested by a manifest, emit a mapping
with the exact `source_pts_us`; `mapped_source_pts_us` is the source position
obtained after the application round-trip (source→output for VFR, proxy→source
for Proxy). A missing checkpoint is a failure, not zero error.

`recommended` means the item is on the preferred/recommended side. `retained`
means it remains explicitly available to the user even if not preferred.
`rejected` means an automatic or persisted reject state. Golden recall requires
`(recommended || retained) && !rejected`.

`routine_repeated_in_story` is true only when a repeated Routine candidate is
still emitted as a normal repeated story beat; Montage/transition folding and a
real anomaly promoted to story event are false.

The output is validated against `observations.schema.json`. Additional evidence
fields are allowed on `run` and individual fixtures so a driver can preserve DB
IDs, job IDs, export paths and human-review notes.
