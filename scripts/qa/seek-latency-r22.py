#!/usr/bin/env python3
"""Bounded decoder-only diagnostic. Does NOT measure the Tauri monitor/render path.
Uses a generated HEVC fixture and an isolated, no-config mpv process. No user media.
"""
import json
import pathlib
import shutil
import socket
import statistics
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'qa/perf/r22-hevc-decoder.json'
result = {'scope': 'decoder-only surrogate; not Tauri/render/drag acceptance', 'source': 'synthetic HEVC 1080p30, 10 bit, GOP 120', 'samples_ms': []}
player = None
try:
    with tempfile.TemporaryDirectory(prefix='tripcut-r22-hevc-') as work:
        source = pathlib.Path(work) / 'hevc.mp4'
        encode = subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-f', 'lavfi', '-i',
            'testsrc2=size=1920x1080:rate=30:duration=8', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265',
            '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=2:keyint=120:min-keyint=120:scenecut=0:log-level=error',
            '-y', str(source)], capture_output=True, timeout=90)
        if encode.returncode: raise RuntimeError(encode.stderr.decode()[-1000:])
        ipc = pathlib.Path(work) / 'mpv.sock'
        log = open(pathlib.Path(work) / 'mpv.log', 'wb')
        player = subprocess.Popen([shutil.which('mpv'), '--no-config', '--vo=null', '--ao=null', '--hwdec=videotoolbox-copy',
            '--pause=yes', '--keep-open=yes', '--idle=yes', '--input-ipc-server=' + str(ipc), str(source)], stdout=log, stderr=log)
        deadline = time.monotonic() + 10
        while not ipc.exists() and time.monotonic() < deadline:
            if player.poll() is not None: raise RuntimeError('mpv exited: ' + (pathlib.Path(work) / 'mpv.log').read_text()[-1000:])
            time.sleep(0.05)
        conn = socket.socket(socket.AF_UNIX); conn.settimeout(10); conn.connect(str(ipc))
        stream = conn.makefile('rb')
        request = 0
        def command(args):
            global request
            request += 1
            conn.sendall((json.dumps({'command': args, 'request_id': request}) + '\n').encode())
            while True:
                response = json.loads(stream.readline())
                if response.get('request_id') == request: return response
        for _ in range(100):
            if command(['get_property', 'duration']).get('data', 0) > 0: break
            time.sleep(.05)
        result['hwdec_current'] = command(['get_property', 'hwdec-current'])
        for seconds in [0.3, 3.7, 1.2, 6.9, 2.6, 7.3, 4.4, 0.7, 5.8, 3.1]:
            started = time.perf_counter()
            response = command(['seek', seconds, 'absolute+exact'])
            if response.get('error') != 'success': raise RuntimeError(str(response))
            while True:
                event = json.loads(stream.readline())
                if event.get('event') == 'playback-restart': break
            result['samples_ms'].append(round((time.perf_counter() - started) * 1000, 3))
        ordered = sorted(result['samples_ms'])
        result.update(p50_ms=round(statistics.median(ordered), 3), p95_ms=ordered[-1], completed=True)
        conn.close()
except Exception as error:
    result.update(completed=False, blocked=str(error))
finally:
    if player and player.poll() is None:
        player.terminate()
        try: player.wait(timeout=3)
        except subprocess.TimeoutExpired: player.kill(); player.wait()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
