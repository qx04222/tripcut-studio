#!/usr/bin/env python3
"""One-off fix-verification run: re-runs analyze_audio (after the -v info fix)
over every generated fixture and writes audio_corrected.json next to results.json."""
import sys, os, json, csv
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import stage1_pipeline as sp
from multiprocessing import get_context

GEN = "/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/38c230ca-c578-49ef-b07a-e3b6d17d80b4/scratchpad/s4/fixtures/generated"
MANIFEST = "/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/38c230ca-c578-49ef-b07a-e3b6d17d80b4/scratchpad/s4/fixtures/MANIFEST.csv"


def work(item):
    fn, p = item
    try:
        r = sp.analyze_audio(p)
    except Exception as e:
        r = {"error": str(e), "error_type": type(e).__name__}
    return fn, r


def main():
    files = []
    with open(MANIFEST, newline="") as f:
        for row in csv.DictReader(f):
            p = os.path.join(GEN, row["filename"])
            if os.path.exists(p):
                files.append((row["filename"], p))

    with get_context("spawn").Pool(processes=8) as pool:
        results = dict(pool.map(work, files))

    out_path = os.path.join(os.path.dirname(__file__), "..", "audio_corrected.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)

    n_audio = sum(1 for r in results.values() if r.get("has_audio_stream"))
    print(f"{n_audio}/{len(results)} fixtures have detected audio")
    clip = sum(1 for r in results.values() if r.get("likely_clipping"))
    print(f"{clip} fixtures flagged likely_clipping")


if __name__ == "__main__":
    main()
