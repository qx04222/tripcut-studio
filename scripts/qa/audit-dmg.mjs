#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { auditInfoPlist } from "./native-audit/infoPlist.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args = []) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 127,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function relativeTo(root, path) {
  return path.slice(root.length + 1);
}

function parseVersion(text) {
  const parts = String(text ?? "").trim().split(".").map((part) => Number.parseInt(part, 10));
  return parts.length > 0 && parts.every((part) => Number.isFinite(part)) ? parts : undefined;
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Minimum macOS a Mach-O will load on (dyld refuses anything newer than the
// running OS: "built for macOS 27.0 which is newer than running OS").
// Reads LC_BUILD_VERSION (platform 1 = macOS) or the legacy
// LC_VERSION_MIN_MACOSX; returns undefined when neither is present.
function machoMinimumMacOS(path) {
  const lines = run("otool", ["-l", path]).stdout.split("\n").map((line) => line.trim());
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "cmd LC_BUILD_VERSION") {
      const block = lines.slice(index + 1, index + 8);
      const platform = block.find((line) => line.startsWith("platform "))?.split(/\s+/)[1];
      const minos = block.find((line) => line.startsWith("minos "))?.split(/\s+/)[1];
      const sdk = block.find((line) => line.startsWith("sdk "))?.split(/\s+/)[1];
      if (platform === "1" || platform === "macos") found.push({ command: "LC_BUILD_VERSION", minos, sdk });
    } else if (lines[index] === "cmd LC_VERSION_MIN_MACOSX") {
      const block = lines.slice(index + 1, index + 6);
      const minos = block.find((line) => line.startsWith("version "))?.split(/\s+/)[1];
      const sdk = block.find((line) => line.startsWith("sdk "))?.split(/\s+/)[1];
      found.push({ command: "LC_VERSION_MIN_MACOSX", minos, sdk });
    }
  }
  return found[0];
}

function auditBundledH264(appPath, workDirectory) {
  const ffmpeg = join(appPath, "Contents/MacOS/ffmpeg");
  const ffprobe = join(appPath, "Contents/MacOS/ffprobe");
  const output = join(workDirectory, "videotoolbox-smoke.mp4");
  const rawInput = join(workDirectory, "videotoolbox-smoke.yuv");
  const width = 320;
  const height = 180;
  const frame = Buffer.alloc(width * height * 3 / 2);
  frame.fill(96, 0, width * height);
  frame.fill(128, width * height);
  writeFileSync(rawInput, Buffer.concat(Array.from({ length: 30 }, () => frame)));
  const encode = run(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", `${width}x${height}`,
    "-framerate", "30", "-i", rawInput, "-t", "1", "-an",
    "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "2M",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", "-y", output,
  ]);
  const probe = encode.exitCode === 0
    ? run(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height,bit_rate:format=duration",
      "-of", "json", output,
    ])
    : { command: "not attempted", exitCode: 127, stdout: "", stderr: "encode failed" };
  let metadata;
  let parseError;
  try {
    metadata = JSON.parse(probe.stdout);
  } catch (error) {
    parseError = String(error);
  }
  const stream = metadata?.streams?.[0];
  const duration = Number(metadata?.format?.duration);
  return {
    encode,
    probe,
    metadata,
    parseError,
    pass: encode.exitCode === 0
      && probe.exitCode === 0
      && stream?.codec_name === "h264"
      && stream?.pix_fmt === "yuv420p"
      && stream?.width === 320
      && stream?.height === 180
      && duration >= 0.9
      && duration <= 1.1,
  };
}

function auditApp(appPath, workDirectory) {
  const macho = [];
  const externalDependencies = new Set();
  for (const path of walk(appPath)) {
    const fileType = run("file", ["-b", path]);
    if (!fileType.stdout.includes("Mach-O")) continue;
    const dependencies = run("otool", ["-L", path]).stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
      .filter(Boolean);
    for (const dependency of dependencies) {
      if (
        dependency.startsWith("/")
        && !dependency.startsWith("/System/")
        && !dependency.startsWith("/usr/lib/")
      ) {
        externalDependencies.add(dependency);
      }
    }
    macho.push({
      path: relativeTo(appPath, path),
      sha256: sha256File(path),
      fileType: fileType.stdout,
      uuids: run("dwarfdump", ["--uuid", path]).stdout.split("\n").filter(Boolean),
      dependencies,
      minimumMacOS: machoMinimumMacOS(path) ?? null,
    });
  }
  macho.sort((left, right) => left.path.localeCompare(right.path));
  // dwarfdump appends the temporary mount path to each UUID line. Keep the
  // detailed evidence, but hash only stable bundle-relative identity fields so
  // repeated audits of the same DMG produce the same aggregate.
  const aggregateIdentity = macho.map(({ path, sha256, fileType, dependencies }) => ({
    path,
    sha256,
    fileType,
    dependencies,
  }));
  const aggregate = createHash("sha256").update(JSON.stringify(aggregateIdentity)).digest("hex");
  const signature = run("codesign", ["-dv", "--verbose=4", appPath]);
  const signatureVerification = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const licenseFiles = walk(appPath)
    .map((path) => relativeTo(appPath, path))
    .filter((path) => /(^|\/)(license|copying|notice|thirdpartynotices)(\.|$)/i.test(basename(path)));
  const requiredLegalFiles = [
    "Contents/Resources/legal/TRIPCUT-LICENSE.txt",
    "Contents/Resources/legal/THIRD_PARTY_NOTICES.txt",
    "Contents/Resources/legal/mpv/LICENSE.LGPL",
    "Contents/Resources/legal/mpv/Copyright",
    "Contents/Resources/legal/ffmpeg/LICENSE.md",
    "Contents/Resources/legal/ffmpeg/COPYING.LGPLv2.1",
    "Contents/Resources/legal/whisper.cpp/LICENSE",
    "Contents/Resources/legal/libplacebo/LICENSE",
    "Contents/Resources/legal/libplacebo/build-manifest.txt",
    "Contents/Resources/legal/native-sbom.json",
    "Contents/Resources/legal/build-provenance.json",
  ];
  const missingLegalFiles = requiredLegalFiles.filter((path) => !existsSync(join(appPath, path)));
  let provenance;
  let provenanceError;
  let nativeSbom;
  let nativeSbomError;
  const provenancePath = join(appPath, "Contents/Resources/legal/build-provenance.json");
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch (error) {
    provenanceError = String(error);
  }
  try {
    nativeSbom = JSON.parse(readFileSync(join(appPath, "Contents/Resources/legal/native-sbom.json"), "utf8"));
  } catch (error) {
    nativeSbomError = String(error);
  }
  const nativeSbomPaths = new Set(nativeSbom?.files?.map((entry) => entry.path) ?? []);
  const machoPaths = new Set(macho.map((entry) => entry.path));
  const nativeSbomMismatches = [
    ...[...machoPaths].filter((path) => !nativeSbomPaths.has(path)).map((path) => `Mach-O missing from SBOM: ${path}`),
    ...[...nativeSbomPaths].filter((path) => !machoPaths.has(path)).map((path) => `SBOM file is not a packaged Mach-O: ${path}`),
    ...(nativeSbom?.files ?? []).flatMap((entry) => {
      const path = join(appPath, entry.path ?? "");
      const failures = [];
      if (!entry.component || !entry.licenseConcluded || entry.licenseConcluded === "NOASSERTION") {
        failures.push(`unknown component/license: ${entry.path}`);
      }
      if (!existsSync(path)) failures.push(`missing SBOM payload: ${entry.path}`);
      else if (entry.sha256 && entry.sha256 !== sha256File(path)) failures.push(`SBOM hash mismatch: ${entry.path}`);
      for (const evidence of entry.licenseEvidence ?? []) {
        if (!existsSync(join(appPath, "Contents/Resources/legal", evidence))) {
          failures.push(`missing license evidence: ${entry.path} -> ${evidence}`);
        }
      }
      // Statically linked third parties (e.g. the libass chain inside libmpv)
      // have no Mach-O of their own but the same evidence obligations.
      for (const embedded of entry.embeddedComponents ?? []) {
        if (!embedded.component || !embedded.licenseConcluded || embedded.licenseConcluded === "NOASSERTION") {
          failures.push(`unknown embedded component/license: ${entry.path}`);
        }
        for (const evidence of embedded.licenseEvidence ?? []) {
          if (!existsSync(join(appPath, "Contents/Resources/legal", evidence))) {
            failures.push(`missing license evidence: ${entry.path} [${embedded.component}] -> ${evidence}`);
          }
        }
      }
      return failures;
    }),
  ];
  const provenanceFiles = provenance ? [
    [provenance.mpv?.path, provenance.mpv?.sha256],
    [provenance.ffmpeg?.path, provenance.ffmpeg?.sha256],
    [provenance.ffmpeg?.ffprobePath, provenance.ffmpeg?.ffprobeSha256],
    [provenance.whisperCpp?.path, provenance.whisperCpp?.sha256],
    [provenance.libplacebo?.path, provenance.libplacebo?.sha256],
  ] : [];
  const provenanceMismatches = provenanceFiles.flatMap(([relativePath, expected]) => {
    if (!relativePath || !expected) return [`missing provenance path/hash: ${relativePath ?? "unknown"}`];
    const absolutePath = join(appPath, relativePath);
    if (!existsSync(absolutePath)) return [`missing provenance payload: ${relativePath}`];
    const actual = sha256File(absolutePath);
    return actual === expected ? [] : [`${relativePath}: expected ${expected}, got ${actual}`];
  });
  const runtimeStringPattern = /(\/opt\/homebrew\/Cellar\/ggml|\/usr\/local\/lib\/ggml|GGML_BACKEND_PATH)/i;
  const runtimeStringHits = macho.flatMap((entry) => run("strings", [join(appPath, entry.path)]).stdout
    .split("\n")
    .filter((line) => runtimeStringPattern.test(line))
    .map((line) => `${entry.path}: ${line}`));
  const encoderSmoke = auditBundledH264(appPath, workDirectory);
  const infoPlistPath = join(appPath, "Contents/Info.plist");
  // R18 M-07① / H-07 / H-23:整份 plist 读成 JSON 再判(逐键 -extract 会把"缺键"和"读失败"混成一回事)。
  let infoPlistValues = {};
  let infoPlistError;
  const infoPlistJson = run("plutil", ["-convert", "json", "-o", "-", infoPlistPath]);
  if (infoPlistJson.exitCode === 0) {
    try {
      infoPlistValues = JSON.parse(infoPlistJson.stdout);
    } catch (error) {
      infoPlistError = `Info.plist 读出来不是 JSON:${String(error)}`;
    }
  } else {
    infoPlistError = infoPlistJson.stderr || "plutil 读不了 Info.plist";
  }
  const infoPlistFindings = infoPlistError ? [infoPlistError] : auditInfoPlist(infoPlistValues);
  const infoPlist = run("plutil", ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", infoPlistPath]);
  const declaredMinimumMacOS = infoPlist.exitCode === 0 ? infoPlist.stdout.trim() : undefined;
  let configuredMinimumMacOS;
  try {
    configuredMinimumMacOS = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"))
      ?.bundle?.macOS?.minimumSystemVersion;
  } catch {
    configuredMinimumMacOS = undefined;
  }
  const declaredVersion = parseVersion(declaredMinimumMacOS);
  const minimumMacOSViolations = macho.flatMap((entry) => {
    const minos = parseVersion(entry.minimumMacOS?.minos);
    if (!declaredVersion) return [`${entry.path}: no LSMinimumSystemVersion to compare against`];
    if (!minos) return [`${entry.path}: no LC_BUILD_VERSION/LC_VERSION_MIN_MACOSX`];
    return compareVersions(minos, declaredVersion) > 0
      ? [`${entry.path}: minos ${entry.minimumMacOS.minos} > declared ${declaredMinimumMacOS} (sdk ${entry.minimumMacOS.sdk})`]
      : [];
  });
  return {
    infoPlistFindings,
    declaredMinimumMacOS,
    configuredMinimumMacOS,
    minimumMacOSViolations,
    appPath,
    aggregateMachOSha256: aggregate,
    macho,
    externalDependencies: [...externalDependencies].sort(),
    signature,
    signatureVerification,
    licenseFiles,
    requiredLegalFiles,
    missingLegalFiles,
    provenance,
    provenanceError,
    provenanceMismatches,
    nativeSbom,
    nativeSbomError,
    nativeSbomMismatches,
    runtimeStringHits,
    encoderSmoke,
  };
}

const dmgArgument = argument("--dmg");
if (!dmgArgument) {
  console.error("usage: audit-dmg.mjs --dmg /absolute/path/file.dmg [--out directory] [--expect-signature developer-id|adhoc]");
  process.exit(2);
}
const expectedSignature = argument("--expect-signature") ?? "developer-id";
if (!["developer-id", "adhoc"].includes(expectedSignature)) {
  console.error("--expect-signature must be developer-id or adhoc");
  process.exit(2);
}
const dmgPath = resolve(dmgArgument);
if (!existsSync(dmgPath) || !statSync(dmgPath).isFile()) {
  console.error(`DMG not found: ${dmgPath}`);
  process.exit(2);
}

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputDirectory = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-dmg-audit`));
mkdirSync(outputDirectory, { recursive: true });
const temporaryRoot = mkdtempSync(join(tmpdir(), "tripcut-dmg-audit-"));
const mountPoint = join(temporaryRoot, "mounted");
mkdirSync(mountPoint);

let attach;
let appAudit;
const dmgVerification = run("hdiutil", ["verify", dmgPath]);
try {
  attach = run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath]);
  if (attach.exitCode === 0) {
    const appName = readdirSync(mountPoint).find((name) => name.endsWith(".app"));
    if (appName) appAudit = auditApp(join(mountPoint, appName), temporaryRoot);
  }
} finally {
  if (attach?.exitCode === 0) run("hdiutil", ["detach", mountPoint]);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const bannedPattern = /(libx26[45]|libdvd(read|nav|css)|libSDL|librubberband|\/opt\/homebrew|\/usr\/local)/i;
const bannedHits = appAudit
  ? appAudit.macho.flatMap((entry) => [entry.path, ...entry.dependencies]).filter((value) => bannedPattern.test(value))
  : [];
const signatureText = `${appAudit?.signature.stdout ?? ""}\n${appAudit?.signature.stderr ?? ""}`;
const signatureExpectationPass = expectedSignature === "developer-id"
  ? /Authority=Developer ID Application:/.test(signatureText) && /TeamIdentifier=\w+/.test(signatureText)
  : /Signature=adhoc/.test(signatureText) && /TeamIdentifier=not set/.test(signatureText);
const checks = [
  { id: "dmg.verify", pass: dmgVerification.exitCode === 0, detail: dmgVerification.stderr || dmgVerification.stdout },
  { id: "dmg.attach", pass: attach?.exitCode === 0, detail: attach?.stderr || attach?.stdout || "not attempted" },
  { id: "app.present", pass: Boolean(appAudit), detail: appAudit?.appPath ?? "no .app found" },
  {
    id: "app.signature-integrity",
    pass: appAudit?.signatureVerification.exitCode === 0,
    detail: appAudit?.signatureVerification.stderr || appAudit?.signatureVerification.stdout || "not checked",
  },
  {
    id: "app.expected-signature",
    pass: signatureExpectationPass,
    detail: `expected=${expectedSignature}; ${signatureText.match(/(Authority|TeamIdentifier|Signature)=.*$/gm)?.join("; ") ?? "no signature identity"}`,
  },
  {
    id: "app.no-banned-runtime",
    pass: bannedHits.length === 0,
    detail: bannedHits.join("\n") || "no banned libraries or build-machine paths",
  },
  {
    id: "app.no-external-runtime",
    pass: (appAudit?.externalDependencies.length ?? 1) === 0,
    detail: appAudit?.externalDependencies.join("\n") || "all non-system dependencies use bundle-relative paths",
  },
  {
    id: "app.no-external-backend-discovery",
    pass: (appAudit?.runtimeStringHits.length ?? 1) === 0,
    detail: appAudit?.runtimeStringHits.join("\n") || "no external ggml backend discovery strings",
  },
  {
    id: "app.min-os-version",
    pass: Boolean(appAudit?.declaredMinimumMacOS)
      && appAudit?.declaredMinimumMacOS === appAudit?.configuredMinimumMacOS
      && appAudit?.minimumMacOSViolations.length === 0,
    detail: !appAudit?.declaredMinimumMacOS
      ? "Info.plist has no LSMinimumSystemVersion"
      : appAudit.declaredMinimumMacOS !== appAudit.configuredMinimumMacOS
        ? `Info.plist LSMinimumSystemVersion ${appAudit.declaredMinimumMacOS} != tauri.conf.json minimumSystemVersion ${appAudit.configuredMinimumMacOS}`
        : appAudit.minimumMacOSViolations.length > 0
          ? `${appAudit.minimumMacOSViolations.length}/${appAudit.macho.length} Mach-O newer than declared ${appAudit.declaredMinimumMacOS}:\n${appAudit.minimumMacOSViolations.join("\n")}`
          : `all ${appAudit.macho.length} Mach-O files load on macOS ${appAudit.declaredMinimumMacOS}`,
  },
  {
    // R18 M-07①/H-07/H-23:中文本地化元数据 + 五条文件夹用途说明 + 不再声称需要 Carbon。
    // 判定在 scripts/qa/native-audit/infoPlist.mjs(vitest 里对 0.8.3 实际发出去的那份报过红)。
    id: "app.localization-and-file-access",
    pass: (appAudit?.infoPlistFindings?.length ?? 1) === 0,
    detail: appAudit?.infoPlistFindings?.join("\n")
      || "CFBundleDevelopmentRegion=zh-Hans、CFBundleLocalizations、五条 NS*UsageDescription 齐全",
  },
  {
    id: "app.bundled-h264-videotoolbox",
    pass: appAudit?.encoderSmoke?.pass === true,
    detail: appAudit?.encoderSmoke?.pass
      ? JSON.stringify(appAudit.encoderSmoke.metadata)
      : appAudit?.encoderSmoke?.encode?.stderr
        || appAudit?.encoderSmoke?.probe?.stderr
        || appAudit?.encoderSmoke?.parseError
        || "not checked",
  },
  {
    id: "app.provenance-hashes",
    pass: appAudit?.provenance?.schemaVersion === 2
      && appAudit?.provenanceMismatches.length === 0
      && !appAudit?.provenanceError,
    detail: appAudit?.provenanceError
      || appAudit?.provenanceMismatches.join("\n")
      || "all final packaged payload hashes match provenance",
  },
  {
    id: "app.license-materials",
    pass: appAudit?.missingLegalFiles.length === 0
      && appAudit?.nativeSbom?.schemaVersion === 1
      && appAudit?.nativeSbomMismatches.length === 0
      && !appAudit?.nativeSbomError,
    detail: appAudit?.missingLegalFiles.join("\n")
      || appAudit?.nativeSbomError
      || appAudit?.nativeSbomMismatches.join("\n")
      || `${appAudit?.nativeSbom?.files?.length ?? 0} packaged Mach-O files mapped to license evidence`,
  },
];

const report = {
  schemaVersion: 1,
  kind: "tripcut-dmg-audit",
  capturedAt: new Date().toISOString(),
  dmg: { path: dmgPath, sha256: sha256File(dmgPath), expectedSignature, verification: dmgVerification },
  app: appAudit,
  checks,
};
const failed = checks.filter((check) => !check.pass);
const gate = {
  schemaVersion: 1,
  gate: "dmg-audit",
  status: failed.length === 0 ? "PASS" : "FAIL",
  failed: failed.map(({ id, detail }) => ({ id, detail })),
  report: "dmg-audit.json",
};
writeFileSync(join(outputDirectory, "dmg-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${String(check.detail).split("\n")[0]}`);
}
console.log(`${gate.status} ${outputDirectory}`);
process.exitCode = failed.length === 0 ? 0 : 1;
