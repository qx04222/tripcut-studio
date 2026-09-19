#!/usr/bin/env node
/**
 * E-06(R19 perf 车道续)取证夹具:构造 A18-01「首启 7 分钟无响应」的复现条件——
 * `docs/qa/2026-09-15-unattended-r18.md` §2 记的是「27 条素材 × 4 类任务重排,
 * 机器 load 30+」。这里只造前半句(不需要真实素材,直接写 sqlite `clips`/`jobs`
 * 两张表):27 条素材,4 类任务(full_hash / analyze_l1 / analyze_motion /
 * thumbnail)各 27 条 pending job = 108 条待认领任务,外加素材本身缺齐分析产物
 * (不建 clip_analysis/clip_motion/moments 行),让真机 `startup_backfill()`
 * 里的 6 个 `enqueue_missing_*` 也会真的各自发现「有活要干」,而不是空跑。
 *
 * 用法:
 *   node qa/perf/a18-01/make-reorder-profile.mjs --db <profile>/default/project.db
 *
 * 前置:先用目标 .app 起一次空库(生成 default/project.db 的完整 schema),再对
 * 这个 db 跑本脚本——本脚本不建表,只 INSERT,建表交给真实 migrations。
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const dbPath = argument("--db");
if (!dbPath || !existsSync(dbPath)) {
  console.error("用法: node make-reorder-profile.mjs --db <profile>/default/project.db(db 必须已由真机起过一次空库生成)");
  process.exit(2);
}

const CLIP_COUNT = 27;
const JOB_KINDS = ["full_hash", "analyze_l1", "analyze_motion", "thumbnail"];
const VOLUME_UUID = "A18-01-FIXTURE";

const statements = [];
statements.push(
  `INSERT OR IGNORE INTO volumes(uuid, label, fs_type, last_seen_at) VALUES ('${VOLUME_UUID}', 'A18-01 取证卷', 'apfs', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
);
for (let i = 1; i <= CLIP_COUNT; i += 1) {
  const relPath = `A18-01/clip_${String(i).padStart(3, "0")}.mp4`;
  // 27 条分布在四类相机常见的 tb/fps 组合上,duration 6–48s,与真实导入库形状接近;
  // 不需要磁盘上真的有这个文件——backfill 只查数据库行,不解码文件。
  statements.push(
    `INSERT INTO clips(volume_uuid, rel_path, byte_size, tb_num, tb_den, duration_ticks, fps_num, fps_den, codec, width, height, captured_at, imported_at) VALUES ` +
      `('${VOLUME_UUID}', '${relPath}', ${10_000_000 + i * 137}, 1, 1000, ${6000 + (i % 8) * 3000}, 30, 1, 'h264', 3840, 2160, ` +
      `'2026-09-01T${String(7 + (i % 12)).padStart(2, "0")}:00:00+08:00', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
  );
}
// 4 类任务 × 27 条 = 108 条 pending job,payload 里的 clip_id 用刚插入素材的 id
// (SQLite AUTOINCREMENT 语义下,本库是空库时就是 1..27——用 last_insert_rowid()
// 系列不方便批量算,这里改用子查询按 rel_path 精确定位,不依赖 id 连续这件事)。
for (let i = 1; i <= CLIP_COUNT; i += 1) {
  const relPath = `A18-01/clip_${String(i).padStart(3, "0")}.mp4`;
  for (const kind of JOB_KINDS) {
    statements.push(
      `INSERT INTO jobs(kind, payload, payload_hash, status, attempt, next_attempt_at, created_at, updated_at) ` +
        `SELECT '${kind}', json_object('clip_id', id), '${kind}-' || id, 'pending', 0, ` +
        `strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') ` +
        `FROM clips WHERE volume_uuid = '${VOLUME_UUID}' AND rel_path = '${relPath}';`,
    );
  }
}

const sql = statements.join("\n");
execFileSync("sqlite3", [dbPath], { input: sql, stdio: ["pipe", "inherit", "inherit"] });

const [clipCount, jobCount] = execFileSync("sqlite3", [dbPath, "-batch", "-noheader",
  `SELECT (SELECT count(*) FROM clips WHERE volume_uuid='${VOLUME_UUID}') || '|' || (SELECT count(*) FROM jobs WHERE payload_hash LIKE '%-%' AND status='pending');`,
], { encoding: "utf8" }).trim().split("|");
console.log(`写入完成:${clipCount} 条素材(卷 ${VOLUME_UUID})、${jobCount} 条 pending job(应为 ${CLIP_COUNT * JOB_KINDS.length})`);
