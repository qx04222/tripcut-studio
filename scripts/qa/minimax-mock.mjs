#!/usr/bin/env node
// Local mock of the MiniMax v2 video-generation API, for offline Rust
// integration tests (src-tauri/tests/minimax_client.rs). Node built-ins only.
//
// Usage:
//   node minimax-mock.mjs --port 4010 --outcome succeeded [--delay-ms 0]
//     [--fixture /path/to/some.mp4] [--record /path/to/requests.jsonl]
//     [--retry-after 3]
//
// --outcome:
//   succeeded      create -> 200 {task_id}; query -> succeeded + content.url
//   failed         create -> 200 {task_id}; query -> failed + error message
//   slow           create -> 200 {task_id} after --delay-ms; query as
//                  succeeded; the /files/ download response ALSO waits
//                  --delay-ms before writing its first byte (Finding 2:
//                  used to drive the Rust client's download-stall detector).
//   auth           create/query -> 401 regardless of header (also the
//                  fallback behaviour whenever Authorization is missing/blank)
//   image-rejected create -> 400 mentioning the image_url field
//   rate-limited   create -> 429 with Retry-After header (see --retry-after)
//
// --fixture <path>: serve this file's bytes for /files/ download responses
//   instead of the ffmpeg-generated (or placeholder) fixture. Useful for
//   feeding a real, ffprobe-valid sample clip without depending on ffmpeg
//   being on PATH.
// --record <path>: append one JSON line per incoming request (method, path,
//   whether Authorization was present, and the raw request body) to this
//   file. Never includes the Authorization header value itself.
// --retry-after <value>: the Retry-After header value sent by the
//   rate-limited outcome. Defaults to "3" (integer seconds); pass an RFC
//   1123 HTTP-date string (e.g. "Wed, 21 Oct 2026 07:28:00 GMT") to exercise
//   the date-form parser on the Rust side.
//
// Every request is logged to stdout as one JSON line. The Authorization
// header value itself is never logged, only whether it was present.

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { port: 0, outcome: 'succeeded', delayMs: 0, fixture: null, record: null, retryAfter: '3' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--outcome') out.outcome = argv[++i];
    else if (a === '--delay-ms') out.delayMs = Number(argv[++i]);
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--record') out.record = argv[++i];
    else if (a === '--retry-after') out.retryAfter = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function log(entry) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function makeFixtureMp4() {
  const dir = mkdtempSync(path.join(tmpdir(), 'minimax-mock-'));
  const file = path.join(dir, 'fixture.mp4');
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x480:d=4:r=15',
    '-pix_fmt', 'yuv420p', file,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (result.status !== 0 || !existsSync(file)) {
    // Fall back to a minimal placeholder so the server can still start;
    // download-size tests will still see bytes > 0 even if it is not a
    // strictly valid mp4 (ffmpeg is expected to be present in dev/CI).
    writeFileSync(file, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  }
  return file;
}

const fixturePath = args.fixture ?? makeFixtureMp4();
let taskCounter = 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function recordRequest(method, pathname, authPresent, bodyBuffer) {
  if (!args.record) return;
  let body;
  try {
    body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf8')) : null;
  } catch {
    body = bodyBuffer.toString('utf8');
  }
  const entry = { ts: new Date().toISOString(), method, path: pathname, authorization: authPresent ? 'present' : 'missing', body };
  appendFileSync(args.record, JSON.stringify(entry) + '\n');
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function hasBearer(req) {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && /^Bearer\s+\S+/.test(auth);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authPresent = hasBearer(req);
  log({ method: req.method, path: url.pathname, authorization: authPresent ? 'present' : 'missing' });

  const isFileDownload = req.method === 'GET' && /^\/files\//.test(url.pathname);

  if (!isFileDownload) {
    if (!authPresent) {
      sendJson(res, 401, { error: { message: 'missing or invalid Authorization header' } });
      return;
    }
    if (args.outcome === 'auth') {
      sendJson(res, 401, { error: { message: 'invalid API key' } });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/v2/video_generation') {
    const requestBody = await readBody(req);
    recordRequest(req.method, url.pathname, authPresent, requestBody);

    if (args.outcome === 'rate-limited') {
      sendJson(res, 429, { error: { message: 'rate limit exceeded' } }, { 'Retry-After': args.retryAfter });
      return;
    }
    if (args.outcome === 'image-rejected') {
      sendJson(res, 400, {
        error: { field: 'content[].image_url', message: 'image_url data URI is not supported for this account' },
      });
      return;
    }

    const dispatch = () => {
      taskCounter += 1;
      const taskId = `mock-task-${taskCounter}`;
      sendJson(res, 200, { task_id: taskId });
    };

    if (args.outcome === 'slow' && args.delayMs > 0) {
      setTimeout(dispatch, args.delayMs);
    } else {
      dispatch();
    }
    return;
  }

  const queryMatch = url.pathname.match(/^\/v2\/query\/video_generation\/(.+)$/);
  if (req.method === 'GET' && queryMatch) {
    const taskId = queryMatch[1];

    if (args.outcome === 'failed') {
      sendJson(res, 200, { task_id: taskId, status: 'failed', error: { message: 'content policy violation' } });
      return;
    }
    if (args.outcome === 'succeeded' || args.outcome === 'slow') {
      const fileUrl = `http://${req.headers.host}/files/${taskId}.mp4`;
      sendJson(res, 200, { task_id: taskId, status: 'succeeded', content: { url: fileUrl } });
      return;
    }
    // Default / unrecognised outcome: report queued so callers can observe
    // an in-flight state without a terminal transition.
    sendJson(res, 200, { task_id: taskId, status: 'queued' });
    return;
  }

  const fileMatch = url.pathname.match(/^\/files\/(.+\.mp4)$/);
  if (req.method === 'GET' && fileMatch) {
    recordRequest(req.method, url.pathname, authPresent, Buffer.alloc(0));
    // Headers go out immediately (and are flushed explicitly, since Node
    // otherwise buffers them until the first body write) so that a
    // reqwest::blocking `.send()` on the Rust side returns right away --
    // Finding 2's stall detector is about a gap in the *body* bytes, not
    // about the client waiting on response headers.
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const pipeFile = async () => {
      // node:fs streams (createReadStream/pipe) -- unrelated to the Rust
      // side's reqwest "stream" Cargo feature (removed; see Cargo.toml),
      // and still exactly the right tool here: this is Node serving a file
      // to a socket, not the Rust client consuming one.
      const fs = await import('node:fs');
      fs.createReadStream(fixturePath).pipe(res);
    };
    // Finding 2: delay the first *body* byte so the Rust client's
    // download-stall detector has something real to fire against.
    if (args.outcome === 'slow' && args.delayMs > 0) {
      setTimeout(pipeFile, args.delayMs);
    } else {
      await pipeFile();
    }
    return;
  }

  sendJson(res, 404, { error: { message: 'not found' } });
});

server.listen(args.port, '127.0.0.1', () => {
  const addr = server.address();
  log({ event: 'listening', port: addr.port, outcome: args.outcome });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
