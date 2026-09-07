#!/usr/bin/env python3
"""
S4 Stage1 prototype pipeline (spec §5-L1): five classic-CV analyses per clip,
CPU-only, each producing an explainable numeric score. Mirrors the eventual
Rust port's analysis surface closely enough that per-analysis timings here are
a meaningful "Python floor" for the perf budget in spec §9.

Analyses:
  1. scene_detect   - PySceneDetect ContentDetector, scene cut timestamps
  2. motion         - OpenCV Farneback optical flow on 2-4 sampled frame pairs/sec
                       -> pan/tilt/zoom/handheld/static heuristic + jitter score
  3. focus          - Laplacian variance (lower = softer/out of focus)
  4. exposure       - luma histogram, % of pixels clipped near 0 / 255
  5. audio          - ffmpeg astats: peak level dBFS, count of sample-level clips

Each clip is analyzed independently in its own process (see bench_stage1.py for
the multiprocessing harness); this module exposes analyze_clip(path) -> dict
and is also runnable standalone for one file.
"""
import json
import math
import subprocess
import sys
import time
import traceback

import cv2
import numpy as np

# --- 1. scene detection ------------------------------------------------

def analyze_scenes(path):
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    t0 = time.perf_counter()
    video = open_video(path)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=27.0))
    sm.detect_scenes(video=video, show_progress=False)
    scene_list = sm.get_scene_list(start_in_scene=True)
    cuts = [round(s[0].get_seconds(), 3) for s in scene_list[1:]]  # exclude clip start
    return {
        "scene_cut_timestamps_s": cuts,
        "scene_count": len(scene_list),
        "elapsed_s": round(time.perf_counter() - t0, 4),
    }


# --- 2. optical flow / motion classification ----------------------------

def _classify_motion(mean_dx, mean_dy, div_flow, jitter):
    """Very small heuristic classifier — not a trained model (spec §5 notes no
    off-the-shelf CC-commercial model exists; this is the P0 stand-in, P2
    calibrates thresholds against a labeled set at 3-5x this cost)."""
    speed = math.hypot(mean_dx, mean_dy)
    if jitter > 2.2 and speed < 3.0:
        return "handheld"
    if speed < 0.35:
        return "static"
    if abs(div_flow) > 0.015 and speed < 2.0:
        return "zoom"
    if abs(mean_dy) > abs(mean_dx) * 1.4:
        return "tilt"
    return "pan"


def analyze_motion(path, samples_per_sec=3):
    t0 = time.perf_counter()
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open for motion analysis")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_s = frame_count / fps if fps > 0 else 0

    step = max(1, int(round(fps / samples_per_sec))) if fps > 0 else 10
    scale = 0.25  # downscale for flow speed

    prev_gray = None
    dxs, dys, divs, mags_std = [], [], [], []
    idx = 0
    ok, frame = cap.read()
    while ok:
        if idx % step == 0:
            small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            if prev_gray is not None and prev_gray.shape == gray.shape:
                flow = cv2.calcOpticalFlowFarneback(
                    prev_gray, gray, None, 0.5, 2, 15, 3, 5, 1.2, 0)
                fx, fy = flow[..., 0], flow[..., 1]
                dxs.append(float(np.mean(fx)))
                dys.append(float(np.mean(fy)))
                # crude divergence proxy for zoom: correlation of flow vector with
                # direction from frame center
                h, w = fx.shape
                yy, xx = np.mgrid[0:h, 0:w]
                cx, cy = w / 2, h / 2
                rx, ry = (xx - cx), (yy - cy)
                norm = np.sqrt(rx**2 + ry**2) + 1e-6
                radial = (fx * rx + fy * ry) / norm
                divs.append(float(np.mean(radial)) / (w + h))
                mags_std.append(float(np.std(np.hypot(fx, fy))))
            prev_gray = gray
        idx += 1
        ok, frame = cap.read()
    cap.release()

    if not dxs:
        return {
            "elapsed_s": round(time.perf_counter() - t0, 4),
            "error": "no_frame_pairs_sampled",
            "classification": "static",
        }

    mean_dx, mean_dy = float(np.mean(dxs)), float(np.mean(dys))
    mean_div = float(np.mean(divs))
    jitter_score = float(np.mean(mags_std))  # higher = shakier
    classification = _classify_motion(mean_dx, mean_dy, mean_div, jitter_score)

    return {
        "elapsed_s": round(time.perf_counter() - t0, 4),
        "frame_pairs_sampled": len(dxs),
        "duration_s": round(duration_s, 2),
        "mean_flow_dx": round(mean_dx, 4),
        "mean_flow_dy": round(mean_dy, 4),
        "zoom_divergence": round(mean_div, 5),
        "jitter_score": round(jitter_score, 4),
        "classification": classification,
    }


# --- 3. focus (Laplacian variance) --------------------------------------

def analyze_focus(path, samples_per_sec=1):
    t0 = time.perf_counter()
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open for focus analysis")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(fps / samples_per_sec)))

    vals = []
    idx = 0
    ok, frame = cap.read()
    while ok:
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            lap = cv2.Laplacian(gray, cv2.CV_64F)
            vals.append(float(lap.var()))
        idx += 1
        ok, frame = cap.read()
    cap.release()

    if not vals:
        return {"elapsed_s": round(time.perf_counter() - t0, 4), "error": "no_frames_read"}

    return {
        "elapsed_s": round(time.perf_counter() - t0, 4),
        "frames_sampled": len(vals),
        "laplacian_var_mean": round(float(np.mean(vals)), 2),
        "laplacian_var_min": round(float(np.min(vals)), 2),
        "soft_frame_fraction": round(float(np.mean([v < 60.0 for v in vals])), 3),
    }


# --- 4. exposure (histogram) --------------------------------------------

def analyze_exposure(path, samples_per_sec=1):
    t0 = time.perf_counter()
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("cannot open for exposure analysis")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(fps / samples_per_sec)))

    over_fracs, under_fracs = [], []
    idx = 0
    ok, frame = cap.read()
    while ok:
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            total = gray.size
            over_fracs.append(float(np.sum(gray >= 250)) / total)
            under_fracs.append(float(np.sum(gray <= 5)) / total)
        idx += 1
        ok, frame = cap.read()
    cap.release()

    if not over_fracs:
        return {"elapsed_s": round(time.perf_counter() - t0, 4), "error": "no_frames_read"}

    return {
        "elapsed_s": round(time.perf_counter() - t0, 4),
        "frames_sampled": len(over_fracs),
        "overexposed_pixel_fraction_mean": round(float(np.mean(over_fracs)), 4),
        "underexposed_pixel_fraction_mean": round(float(np.mean(under_fracs)), 4),
        "overexposed_flag": bool(np.mean(over_fracs) > 0.05),
        "underexposed_flag": bool(np.mean(under_fracs) > 0.15),
    }


# --- 5. audio (ffmpeg astats) --------------------------------------------

def analyze_audio(path):
    t0 = time.perf_counter()
    # NOTE: astats' summary lines are logged at AV_LOG_INFO, not AV_LOG_ERROR.
    # "-v error" (used everywhere else in this module) silently swallows them.
    # Bug found during the S4 bench: with -v error every clip reported
    # has_audio_stream=False even though most S4 fixtures do carry audio.
    # Do not "clean up" this -v info back to error.
    cmd = ["ffmpeg", "-v", "info", "-nostats", "-i", path, "-af",
           "astats=metadata=1:reset=1", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    stderr = r.stderr

    def grab(key):
        vals = []
        for line in stderr.splitlines():
            if key in line:
                try:
                    vals.append(float(line.split(":")[-1].strip()))
                except ValueError:
                    pass
        return vals

    peak = grab("Peak level dB")
    flat = grab("Flat factor")

    has_audio = bool(peak) or "Stream #" in stderr or "Audio:" in stderr
    result = {
        "elapsed_s": round(time.perf_counter() - t0, 4),
        "has_audio_stream": "Audio:" in r.stderr or "a:0" in r.stderr or bool(peak),
        "peak_level_db_max": round(max(peak), 2) if peak else None,
        "peak_level_db_last": round(peak[-1], 2) if peak else None,
        "flat_factor_max": round(max(flat), 2) if flat else None,
        "likely_clipping": bool(peak and max(peak) >= -0.3),
    }
    return result


# --- orchestration --------------------------------------------------------

def analyze_clip(path):
    """Run all 5 analyses on one clip. Never raises — failures are captured
    per-analysis so a single bad file cannot take down a worker (S4 §requirement)."""
    result = {"path": path, "analyses": {}}
    steps = [
        ("scene_detect", analyze_scenes),
        ("motion", analyze_motion),
        ("focus", analyze_focus),
        ("exposure", analyze_exposure),
        ("audio", analyze_audio),
    ]
    overall_t0 = time.perf_counter()
    fail_class = None
    for name, fn in steps:
        t0 = time.perf_counter()
        try:
            result["analyses"][name] = fn(path)
        except Exception as e:
            result["analyses"][name] = {
                "error": str(e),
                "error_type": type(e).__name__,
                "elapsed_s": round(time.perf_counter() - t0, 4),
            }
            if fail_class is None:
                fail_class = type(e).__name__
    result["total_elapsed_s"] = round(time.perf_counter() - overall_t0, 4)
    result["fail_class"] = fail_class
    result["ok"] = fail_class is None
    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: stage1_pipeline.py <video path>", file=sys.stderr)
        sys.exit(1)
    r = analyze_clip(sys.argv[1])
    print(json.dumps(r, indent=2))
