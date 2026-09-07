#!/usr/bin/env python3
"""
S4 throughput harness: runs stage1_pipeline.analyze_clip over every generated
fixture, at worker counts 4/6/8, and records per-clip timing, corrupted-file
failure handling, and system resource usage (wall clock, CPU%, peak RSS).

Usage:
  python3 bench_stage1.py --workers 4,6,8 --out results.json

Reads fixture list from MANIFEST.csv (so results can be joined with codec/
resolution/fps/vfr/corrupted metadata). Never lets one file's failure kill the
run — each clip is wrapped in analyze_clip, which itself never raises.
"""
import argparse
import csv
import json
import multiprocessing as mp
import os
import resource
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(__file__))
import stage1_pipeline  # noqa: E402

SCRATCH = "/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/38c230ca-c578-49ef-b07a-e3b6d17d80b4/scratchpad/s4"
GEN = os.path.join(SCRATCH, "fixtures", "generated")
MANIFEST = os.path.join(SCRATCH, "fixtures", "MANIFEST.csv")


def load_manifest():
    rows = {}
    with open(MANIFEST, newline="") as f:
        for row in csv.DictReader(f):
            rows[row["filename"]] = row
    return rows


def _worker(path):
    r = stage1_pipeline.analyze_clip(path)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    # ru_maxrss is bytes on macOS, KB on Linux
    maxrss_bytes = usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024
    r["worker_maxrss_mb"] = round(maxrss_bytes / 1e6, 1)
    r["filename"] = os.path.basename(path)
    return r


class ResourceSampler:
    """Background thread sampling this process tree's total RSS + system CPU%
    every 0.5s while a run is in flight."""

    def __init__(self):
        self._stop = threading.Event()
        self.samples = []
        self._thread = None

    def _run(self):
        import psutil
        proc = psutil.Process(os.getpid())
        psutil.cpu_percent(interval=None)  # prime
        while not self._stop.is_set():
            try:
                children = proc.children(recursive=True)
                rss = proc.memory_info().rss + sum(c.memory_info().rss for c in children if c.is_running())
                cpu = psutil.cpu_percent(interval=None)
                self.samples.append({"t": time.time(), "total_rss_mb": round(rss / 1e6, 1), "cpu_pct": cpu})
            except Exception:
                pass
            self._stop.wait(0.5)

    def __enter__(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._thread.join(timeout=2)

    def summary(self):
        if not self.samples:
            return {}
        rss = [s["total_rss_mb"] for s in self.samples]
        cpu = [s["cpu_pct"] for s in self.samples]
        return {
            "peak_total_rss_mb": max(rss),
            "mean_total_rss_mb": round(sum(rss) / len(rss), 1),
            "peak_cpu_pct": max(cpu),
            "mean_cpu_pct": round(sum(cpu) / len(cpu), 1),
            "n_samples": len(self.samples),
        }


def run_at_worker_count(files, n_workers):
    with ResourceSampler() as sampler:
        t0 = time.perf_counter()
        with mp.get_context("spawn").Pool(processes=n_workers) as pool:
            results = pool.map(_worker, files, chunksize=1)
        wall_s = time.perf_counter() - t0
    return {
        "n_workers": n_workers,
        "n_files": len(files),
        "wall_clock_s": round(wall_s, 3),
        "throughput_clips_per_min": round(len(files) / (wall_s / 60), 2) if wall_s > 0 else None,
        "resource_summary": sampler.summary(),
        "results": results,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", default="4,6,8")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "results.json"))
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    manifest = load_manifest()
    files = sorted(os.path.join(GEN, fn) for fn in manifest if os.path.exists(os.path.join(GEN, fn)))
    if args.limit:
        files = files[: args.limit]

    print(f"Found {len(files)} fixtures to analyze (manifest has {len(manifest)} rows)")

    all_runs = []
    for wc in [int(x) for x in args.workers.split(",")]:
        print(f"\n=== worker count = {wc} ===")
        run = run_at_worker_count(files, wc)
        run["worker_count_label"] = wc
        print(f"  wall clock: {run['wall_clock_s']}s  throughput: {run['throughput_clips_per_min']} clips/min")
        print(f"  resource: {run['resource_summary']}")
        all_runs.append(run)

    out = {
        "manifest_rows": len(manifest),
        "files_analyzed": len(files),
        "runs": all_runs,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
