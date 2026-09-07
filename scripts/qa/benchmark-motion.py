#!/usr/bin/env python3
"""Compare the actual pure motion routines with a saved baseline, without Tauri.

Reads only a user-specified raw 160x160 gray / 2fps test fixture. Builds optimized
Rust harnesses from each supplied source and records wall time, max RSS and an
exact output digest. This measures motion processing, not HEVC decode or app RSS.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', required=True, type=Path)
parser.add_argument('--raw', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
args.out.mkdir(parents=True, exist_ok=True)
rustc = shutil.which('rustc') or '/opt/homebrew/opt/rustup/bin/rustc'

def structure(source, name):
    start = source.index('struct ' + name)
    end = source.index('\n}', start) + 2
    return '#[derive(Debug, Clone, PartialEq)]\n' + source[start:end]

results = []
for mode, source_path in [('before', args.baseline), ('after', root / 'src-tauri/src/core/motion.rs')]:
    source = source_path.read_text()
    constants = '\n'.join(line for line in source[:source.index("struct ClipMotion")].splitlines() if re.match(r'(pub )?const ', line) and ': Duration' not in line)
    routines = source[source.index('fn analyze_frames('):source.index('fn persist_motion(')].replace('#[cfg(test)]', '')
    stream = ''
    if mode == 'after':
        stream = source[source.index('fn analyze_frame_stream('):source.index('\n#[cfg(test)]\nfn extract_gray_frames(')]
        run = 'let pairs = analyze_frame_stream(std::fs::File::open(&path).unwrap()).unwrap().unwrap(); let result = aggregate_motion(&pairs).unwrap();'
    else:
        run = 'let bytes = std::fs::read(&path).unwrap(); let frames = bytes.chunks(FRAME_BYTES).map(|frame| frame.to_vec()).collect::<Vec<_>>(); let result = analyze_frames(&frames).unwrap(); std::hint::black_box(&bytes);'
    harness = '''#![allow(dead_code, unused_imports)]
use std::io::Read;
use std::sync::OnceLock;
#[derive(Debug)] enum CoreError { Motion(String) }
type Result<T> = std::result::Result<T, CoreError>;
mod settings { pub const DEFAULT_JITTER_THRESHOLD: f64 = 0.15; }
mod motion {
use super::*;
''' + constants + '\n' + '\n'.join(structure(source, n) for n in ['ClipMotion', 'MotionVector', 'PairMotion']) + '\n' + stream + '\n' + routines + '\npub fn run(path: String) { ' + run + ' println!("{:?}", result); }\n}\nfn main() { motion::run(std::env::args().nth(1).unwrap()); }\n'
    harness_path = args.out / f'{mode}.rs'
    binary = args.out / mode
    harness_path.write_text(harness)
    subprocess.run([rustc, '--edition=2021', '-O', str(harness_path), '-o', str(binary)], check=True)
    samples = []
    for i in range(3):
        start = time.perf_counter()
        result = subprocess.run(['/usr/bin/time', '-l', str(binary), str(args.raw.resolve())], capture_output=True, check=True)
        elapsed = time.perf_counter() - start
        stderr = result.stderr.decode()
        (args.out / f'{mode}-{i}.time.txt').write_text(stderr)
        rss = int(re.search(r'(\d+)\s+maximum resident set size', stderr)[1])
        samples.append({'wall_seconds': elapsed, 'max_rss_bytes': rss, 'output_sha256': hashlib.sha256(result.stdout).hexdigest()})
    results.append({'mode': mode, 'source_sha256': hashlib.sha256(source.encode()).hexdigest(), 'samples': samples})
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
assert len({s['output_sha256'] for r in results for s in r['samples']}) == 1, 'Motion outputs changed'
report = {'fixture': str(args.raw.resolve()), 'fixture_bytes': args.raw.stat().st_size, 'rustc': subprocess.check_output([rustc, '--version'], text=True).strip(), 'results': results, 'outputs_equal': True}
(args.out / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
