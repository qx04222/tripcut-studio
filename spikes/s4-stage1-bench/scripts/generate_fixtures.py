#!/usr/bin/env python3
"""
S4 fixture generator: expands ~15 real CC-licensed source clips into ~100
test fixtures covering the P0 media compatibility matrix (spec §2):
H.264/HEVC 8-bit/10-bit, 1080p/4K, 25/30/60fps, VFR, and truncated/corrupt
tail frames.

Reads from  <SCRATCH>/s4/fixtures/raw/*
Writes to   <SCRATCH>/s4/fixtures/generated/*
Appends to  <SCRATCH>/s4/fixtures/MANIFEST.csv

This script is NOT meant to be rerun blindly — it appends to MANIFEST.csv.
Delete generated/ and reset MANIFEST.csv to a header-only file before a
fresh run.
"""
import csv
import json
import os
import random
import subprocess
import sys

SCRATCH = "/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/38c230ca-c578-49ef-b07a-e3b6d17d80b4/scratchpad/s4"
RAW = os.path.join(SCRATCH, "fixtures", "raw")
GEN = os.path.join(SCRATCH, "fixtures", "generated")
MANIFEST = os.path.join(SCRATCH, "fixtures", "MANIFEST.csv")

os.makedirs(GEN, exist_ok=True)

random.seed(20260831)

SOURCES = [
    # filename, title, url, license, category
    ("toxaway_clip.webm", "Toxaway Falls - Lake Toxaway, NC -- 4K - Drone -- DJI Mavic Pro 2",
     "https://upload.wikimedia.org/wikipedia/commons/a/a2/Toxaway_Falls_-_Lake_Toxaway%2C_North_Carolina_--_4K_-_Drone_--_DJI_Mavic_Pro_2._Footage.webm",
     "CC BY 3.0", "nature/drone"),
    ("tybee_beach_drone_clip.webm", "Free 4K Drone Beach Content - Tybee Island, Savannah GA",
     "https://upload.wikimedia.org/wikipedia/commons/7/73/Free_4K_Drone_Beach_Content_-_Tybee_Island%2C_Savannah_GA%2C_Wilmington_Island.webm",
     "CC BY 3.0", "nature/drone"),
    ("cherokee_falls_drone_clip.webm", "Twisting Falls - Cherokee National Forest, TN -- 4K Drone",
     "https://upload.wikimedia.org/wikipedia/commons/2/26/Twisting_Falls_-_Cherokee_National_Forest%2C_Tennessee_--_4K_-_Drone_--_DJI_Mavic_Pro_2_footage.webm",
     "CC BY 3.0", "nature/drone"),
    ("whitewater_falls_drone_clip.webm", "Whitewater Falls - Nantahala National Forest, NC -- 4K Drone",
     "https://upload.wikimedia.org/wikipedia/commons/6/65/Whitewater_Falls_-_Nantahala_National_Forest%2C_North_Carolina_--4K_Drone_--_DJI_Mavic_Pro_2._Footage.webm",
     "CC BY 3.0", "nature/drone"),
    ("mykonos_walk_clip.webm", "MYKONOS, a walking tour of this Greek island (in 4K)",
     "https://upload.wikimedia.org/wikipedia/commons/8/80/MYKONOS_%2C_a_walking_tour_of_this_Greek_island_%28in_4K%29.webm",
     "CC BY 3.0", "city/handheld"),
    ("dubai_walk_clip.webm", "Dubai 4K Al Rigga Streets Walking Tour 2026 - Deira Dubai",
     "https://upload.wikimedia.org/wikipedia/commons/0/00/Dubai_4K_Al_Rigga_Streets_Walking_Tour_2026_-_Deira_Dubai_Daytime_Walk.webm",
     "CC BY 4.0", "city/handheld"),
    ("tehran_walk_pocket3_clip.webm", "Tehran's Cultural Heartbeat Walking Tour - 4K 60FPS - DJI Pocket 3",
     "https://upload.wikimedia.org/wikipedia/commons/9/90/Tehran%27s_Cultural_Heartbeat_Walking_Tour-_4K_60FPS_-_DJI_Pocket_3.webm",
     "CC BY 3.0", "city/handheld"),
    ("xian_walk_hdr_clip.webm", "China Xi'an Walking Tour - Xi'an ancient city wall - 4K HDR",
     "https://upload.wikimedia.org/wikipedia/commons/1/16/China_Xi%27an_Walking_Tour_-_China_Metro_in_Xi%27an_-_Xi%27an_ancient_city_wall_-_Walking_China_4K_HDR.webm",
     "CC BY 3.0", "city/handheld"),
    ("kassel_walk_clip.webm", "Walking in KASSEL, Germany - 4K",
     "https://upload.wikimedia.org/wikipedia/commons/e/ea/Walking_in_KASSEL%2C_Germany_%F0%9F%87%A9%F0%9F%87%AA_-_4K-00.00.00.000-00.22.00.000.webm",
     "CC BY 3.0", "city/handheld"),
    ("toledo_walk_rain_clip.webm", "Walking in TOLEDO - Spain - Rainy winter tour - 4K 60fps",
     "https://upload.wikimedia.org/wikipedia/commons/d/d1/Walking_in_TOLEDO_-_Spain_-_Rainy_winter_tour_-_4K_60fps_%28UHD%29.webm",
     "CC BY 3.0", "city/handheld"),
    ("bangkok_walk_clip.webm", "Walking in BANGKOK - Thailand - Modern City Center Tour (2019) - 4K 60fps",
     "https://upload.wikimedia.org/wikipedia/commons/d/de/Walking_in_BANGKOK_-_Thailand_-_Modern_City_Center_Tour_%282019%29_-_4K_60fps_%28UHD%29.webm",
     "CC BY 3.0", "city/handheld"),
    ("ljubljana_market.webm", "Christmas market in Ljubljana - part 2; accordion",
     "https://upload.wikimedia.org/wikipedia/commons/c/c0/Christmas_market_in_Ljubljana_-_part_2%3B_accordion.webm",
     "CC BY 3.0", "people/event"),
    ("madrid_calle_preciados.ogv", "Calle preciados (Madrid street scene)",
     "https://upload.wikimedia.org/wikipedia/commons/0/0b/Calle_preciados.ogv",
     "CC BY-SA 3.0", "street/handheld"),
    ("nairobi_timelapse.webm", "Nairobi - A Timelapse Portrait",
     "https://upload.wikimedia.org/wikipedia/commons/e/e1/Nairobi-_A_Timelapse_Portrait.webm",
     "CC BY 3.0", "city/timelapse"),
    ("newdelhi_park_phone.webm", "Video clip of Central park New Delhi VID_20210411_175657",
     "https://upload.wikimedia.org/wikipedia/commons/0/0b/Video_clip_of_Central_park_New_Delhi_VID_20210411_175657.webm",
     "CC BY-SA 4.0", "people/phone"),
]

NOTE_ALL = ("Downloaded via HTTP range request (partial fetch, first ~150-260MB) then "
            "trimmed with `ffmpeg -c copy` where the source exceeds S4's clip budget; "
            "full source is much longer than the fixture.")


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-show_entries", "format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True)
    d = json.loads(out.stdout)
    st = d["streams"][0]
    w, h = st["width"], st["height"]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    dur = float(d["format"]["duration"])
    return w, h, fps, dur


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAIL:", " ".join(cmd), file=sys.stderr)
        print(r.stderr[-2000:], file=sys.stderr)
        return False
    return True


ENCODERS = {
    "h264_8bit": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "veryfast"],
    "hevc_8bit": ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "veryfast",
                  "-tag:v", "hvc1", "-x265-params", "log-level=error"],
    "hevc_10bit": ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-crf", "26", "-preset", "veryfast",
                   "-tag:v", "hvc1", "-profile:v", "main10", "-x265-params", "log-level=error"],
}

manifest_rows = []
gen_id = 0
vfr_budget = 5
corrupt_budget = 2

# recipe: (codec_key, res_mode, fps, is_vfr, is_corrupt, seg_choice)
# res_mode: "native" | "1080p" | "4k"
BASE_RECIPES = [
    ("h264_8bit", "native", "native", False, False, 0),
    ("h264_8bit", "1080p", 30, False, False, 1),
    ("hevc_8bit", "native", "native", False, False, 0),
    ("hevc_10bit", "native", 25, False, False, 1),
    ("hevc_10bit", "4k", 30, False, False, 0),
    ("h264_8bit", "native", "native", False, False, 1),
]

VFR_SOURCES = ["mykonos_walk_clip.webm", "dubai_walk_clip.webm", "newdelhi_park_phone.webm",
               "madrid_calle_preciados.ogv", "tehran_walk_pocket3_clip.webm"]
CORRUPT_SOURCES = ["kassel_walk_clip.webm", "toledo_walk_rain_clip.webm"]

jobs = []
for fname, title, url, lic, category in SOURCES:
    src_path = os.path.join(RAW, fname)
    if not os.path.exists(src_path):
        print("MISSING SOURCE", fname, file=sys.stderr)
        continue
    sw, sh, sfps, sdur = probe(src_path)
    stem = os.path.splitext(fname)[0]

    seg_len_a = min(max(20, int(sdur * 0.8)), 90, int(sdur) - 1) if sdur > 21 else max(5, int(sdur) - 1)
    seg_len_b = min(seg_len_a, max(15, int(sdur * 0.5)))
    segments = [
        (0, seg_len_a),
        (max(0, int(sdur - seg_len_b - 1)), seg_len_b),
    ]

    recipes = list(BASE_RECIPES)
    if fname in VFR_SOURCES and vfr_budget > 0:
        recipes.append(("h264_8bit", "native", "native", True, False, 0))
        vfr_budget -= 1
    if fname in CORRUPT_SOURCES and corrupt_budget > 0:
        recipes.append(("h264_8bit", "native", "native", False, True, 0))
        corrupt_budget -= 1

    for codec_key, res_mode, fps, is_vfr, is_corrupt, seg_idx in recipes:
        gen_id += 1
        start, length = segments[seg_idx % len(segments)]
        if length < 3:
            continue
        jobs.append(dict(
            gen_id=gen_id, src_path=src_path, stem=stem, title=title, url=url, lic=lic,
            category=category, sw=sw, sh=sh, sfps=sfps,
            codec_key=codec_key, res_mode=res_mode, fps=fps,
            is_vfr=is_vfr, is_corrupt=is_corrupt, start=start, length=length,
        ))


def process_job(job):
    sw, sh = job["sw"], job["sh"]
    codec_key, res_mode, fps = job["codec_key"], job["res_mode"], job["fps"]
    is_vfr, is_corrupt = job["is_vfr"], job["is_corrupt"]
    gen_id = job["gen_id"]

    vf_parts = []
    out_w, out_h = sw, sh
    if res_mode == "1080p" and sh > 1080:
        vf_parts.append("scale=-2:1080")
        out_w, out_h = round(sw * 1080 / sh / 2) * 2, 1080
    elif res_mode == "4k" and sh < 2160:
        vf_parts.append("scale=-2:2160")
        out_w, out_h = round(sw * 2160 / sh / 2) * 2, 2160

    out_fps = job["sfps"] if fps == "native" else fps
    vfr_tag = "vfr" if is_vfr else "cfr"
    ext = "mov" if codec_key == "hevc_10bit" else "mp4"
    out_name = f"{job['stem']}__{codec_key}_{res_mode}_{int(round(out_fps))}fps_{vfr_tag}_{gen_id:03d}.{ext}"
    out_path = os.path.join(GEN, out_name)

    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(job["start"]), "-i", job["src_path"],
           "-t", str(job["length"]), "-threads", "3"]

    if is_vfr:
        vf_parts.append("setpts=PTS+random(1)*0.02")
        if vf_parts:
            cmd += ["-vf", ",".join(vf_parts)]
        cmd += ENCODERS[codec_key]
        cmd += ["-fps_mode", "vfr"]
    else:
        if vf_parts:
            cmd += ["-vf", ",".join(vf_parts)]
        cmd += ENCODERS[codec_key]
        cmd += ["-r", str(out_fps)]

    cmd += ["-c:a", "aac", "-b:a", "128k", out_path]

    ok = run(cmd)
    if not ok:
        return None

    if is_corrupt:
        sz = os.path.getsize(out_path)
        keep = int(sz * 0.7)
        with open(out_path, "r+b") as f:
            f.truncate(keep)

    try:
        ow, oh, ofps, odur = probe(out_path)
    except Exception:
        ow, oh, ofps, odur = out_w, out_h, out_fps, -1

    row = {
        "id": f"F{gen_id:03d}",
        "filename": out_name,
        "category": job["category"],
        "codec": codec_key,
        "pix_fmt": "yuv420p10le" if codec_key == "hevc_10bit" else "yuv420p",
        "resolution": f"{ow}x{oh}",
        "fps": round(ofps, 2) if isinstance(ofps, float) else ofps,
        "vfr": is_vfr,
        "corrupted": is_corrupt,
        "duration_s": round(odur, 2) if odur and odur > 0 else "",
        "size_bytes": os.path.getsize(out_path),
        "source_title": job["title"],
        "source_url": job["url"],
        "license": job["lic"],
        "notes": NOTE_ALL + (" | truncated to ~70% of encoded size to simulate corrupt tail" if is_corrupt else ""),
    }
    print(f"[{gen_id:03d}] {out_name}  {ow}x{oh} {round(out_fps,1) if isinstance(out_fps,(int,float)) else out_fps}fps "
          f"{'VFR' if is_vfr else 'CFR'} {'CORRUPT' if is_corrupt else ''}", flush=True)
    return row


if __name__ == "__main__":
    import multiprocessing as mp

    print(f"Running {len(jobs)} encode jobs with 4 parallel workers ({ENCODERS.keys()})...", flush=True)
    with mp.get_context("spawn").Pool(processes=4) as pool:
        for row in pool.imap_unordered(process_job, jobs):
            if row is not None:
                manifest_rows.append(row)

    fieldnames = ["id", "filename", "category", "codec", "pix_fmt", "resolution", "fps", "vfr",
                  "corrupted", "duration_s", "size_bytes", "source_title", "source_url", "license", "notes"]
    write_header = not os.path.exists(MANIFEST) or os.path.getsize(MANIFEST) == 0
    with open(MANIFEST, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        if write_header:
            w.writeheader()
        for row in sorted(manifest_rows, key=lambda r: r["id"]):
            w.writerow(row)

    total_bytes = sum(r["size_bytes"] for r in manifest_rows)
    print(f"\nGenerated {len(manifest_rows)} fixtures, {total_bytes/1e9:.2f} GB")
