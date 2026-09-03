#!/bin/zsh
# Assemble a complete, reviewable GitHub Preview release directory without
# committing, pushing, changing repository visibility, or creating a Release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG="${1:-}"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
OUTPUT="${2:-$ROOT/dist/github-preview/v${VERSION}-preview}"
case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$ROOT/$OUTPUT" ;;
esac
FFMPEG_ARCHIVE="${FFMPEG_SOURCE_ARCHIVE:-/tmp/ffmpeg-lgpl/ffmpeg.tar.xz}"
MPV_SOURCE_ROOT="${MPV_SOURCE_ROOT:-/tmp/mpv-lgpl/mpv}"
LIBPLACEBO_ARCHIVE="${LIBPLACEBO_SOURCE_ARCHIVE:-/tmp/libplacebo-tripcut/downloads/libplacebo-v7.360.1.tar.bz2}"
WHISPER_ARCHIVE="${WHISPER_SOURCE_ARCHIVE:-/tmp/whisper-static/whisper.cpp-v1.9.2.tar.gz}"
RELEASE_NOTES_SOURCE="${TRIPCUT_RELEASE_NOTES:-$ROOT/docs/releases/v0.1.md}"
MPV_COMMIT="41f6a645068483470267271e1d09966ca3b9f413"
FFMPEG_SHA256="de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f"
LIBPLACEBO_SHA256="937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6"
WHISPER_SHA256="a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd"

[ -n "$DMG" ] || { echo "usage: $0 /absolute/path/*_preview_aarch64.dmg [output-directory]"; exit 2; }
DMG="$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"
[ -f "$DMG" ] || { echo "ERROR: DMG 不存在：$DMG"; exit 1; }
echo "$(basename "$DMG")" | grep -q '_preview_aarch64\.dmg$' || {
  echo "ERROR: 只接受由 preview 模式生成的 *_preview_aarch64.dmg"; exit 1
}
[ ! -e "$OUTPUT" ] || { echo "ERROR: 输出目录已存在，拒绝覆盖：$OUTPUT"; exit 1; }

for REQUIRED in git tar shasum python3 node hdiutil codesign gitleaks; do
  command -v "$REQUIRED" >/dev/null || { echo "ERROR: 缺少 $REQUIRED"; exit 1; }
done
for REQUIRED_FILE in \
  "$ROOT/LICENSE" \
  "$ROOT/README.md" \
  "$ROOT/SECURITY.md" \
  "$ROOT/CONTRIBUTING.md" \
  "$ROOT/docs/UNSIGNED_PREVIEW.md" \
  "$RELEASE_NOTES_SOURCE" \
  "$ROOT/docs/THIRD_PARTY_NOTICES.txt" \
  "$FFMPEG_ARCHIVE" \
  "$LIBPLACEBO_ARCHIVE" \
  "$WHISPER_ARCHIVE"; do
  [ -s "$REQUIRED_FILE" ] || { echo "ERROR: 缺少发布材料：$REQUIRED_FILE"; exit 1; }
done
[ -d "$MPV_SOURCE_ROOT/.git" ] || { echo "ERROR: 缺少 mpv Git 源码：$MPV_SOURCE_ROOT"; exit 1; }
[ "$(git -C "$MPV_SOURCE_ROOT" rev-parse HEAD)" = "$MPV_COMMIT" ] || {
  echo "ERROR: mpv 提交与发行固定值不符"; exit 1
}

echo "$FFMPEG_SHA256  $FFMPEG_ARCHIVE" | shasum -a 256 -c -s
echo "$LIBPLACEBO_SHA256  $LIBPLACEBO_ARCHIVE" | shasum -a 256 -c -s
echo "$WHISPER_SHA256  $WHISPER_ARCHIVE" | shasum -a 256 -c -s

STAGE="$(mktemp -d -t tripcut-github-preview.XXXXXX)"
AUDIT="$(mktemp -d -t tripcut-github-preview-audit.XXXXXX)"
cleanup() { rm -rf "$STAGE" "$AUDIT"; }
trap cleanup EXIT HUP INT TERM

mkdir -p "$OUTPUT/sources" "$STAGE/tripcut-studio-$VERSION" "$STAGE/mpv-v0.41.0-tripcut"

# Include tracked and new, non-ignored source files from the exact working tree.
# Build output, QA runs and local databases remain excluded by .gitignore.
cd "$ROOT"
git ls-files -co --exclude-standard -z \
  | tar --null -T - -cf - \
  | tar -C "$STAGE/tripcut-studio-$VERSION" -xf -

gitleaks dir --timeout 60 --redact --no-banner \
  --config "$STAGE/tripcut-studio-$VERSION/.gitleaks.toml" \
  "$STAGE/tripcut-studio-$VERSION"

tar -czf "$OUTPUT/sources/tripcut-studio-$VERSION-source.tar.gz" \
  -C "$STAGE" "tripcut-studio-$VERSION"

# Preserve both the exact patched mpv tree and a reviewable patch against the
# pinned upstream v0.41.0 commit.
cd "$MPV_SOURCE_ROOT"
git ls-files -z | tar --null -T - -cf - | tar -C "$STAGE/mpv-v0.41.0-tripcut" -xf -
git diff HEAD --binary > "$OUTPUT/sources/mpv-v0.41.0-tripcut.patch"
[ -s "$OUTPUT/sources/mpv-v0.41.0-tripcut.patch" ] || {
  echo "ERROR: mpv 的发行修复补丁为空"; exit 1
}
tar -cJf "$OUTPUT/sources/mpv-v0.41.0-tripcut-source.tar.xz" \
  -C "$STAGE" mpv-v0.41.0-tripcut

cp "$FFMPEG_ARCHIVE" "$OUTPUT/sources/ffmpeg-7.1.5-source.tar.xz"
cp "$LIBPLACEBO_ARCHIVE" "$OUTPUT/sources/libplacebo-v7.360.1-source.tar.bz2"
cp "$WHISPER_ARCHIVE" "$OUTPUT/sources/whisper.cpp-v1.9.2-source.tar.gz"
cp "$ROOT/scripts/build-lgpl-ffmpeg.sh" "$OUTPUT/sources/"
cp "$ROOT/scripts/build-libplacebo.sh" "$OUTPUT/sources/"
cp "$ROOT/scripts/build-lgpl-mpv.sh" "$OUTPUT/sources/"
cp "$ROOT/scripts/build-whisper.sh" "$OUTPUT/sources/"
cp "$ROOT/scripts/patches/whisper-no-external-backend.patch" "$OUTPUT/sources/"
cp "$ROOT/LICENSE" "$OUTPUT/TRIPCUT-LICENSE.txt"
cp "$ROOT/docs/THIRD_PARTY_NOTICES.txt" "$OUTPUT/THIRD_PARTY_NOTICES.txt"
cp "$ROOT/docs/UNSIGNED_PREVIEW.md" "$OUTPUT/UNSIGNED_PREVIEW.md"
cp "$DMG" "$OUTPUT/"

node "$ROOT/scripts/qa/audit-dmg.mjs" \
  --dmg "$DMG" \
  --expect-signature adhoc \
  --out "$AUDIT"
python3 - "$AUDIT/dmg-audit.json" "$AUDIT/gate.json" \
  "$OUTPUT/DMG_AUDIT_REPORT.json" "$OUTPUT/DMG_AUDIT_GATE.json" <<'PY'
import json, pathlib, sys

audit_path, gate_path, public_report_path, public_gate_path = sys.argv[1:]
audit = json.loads(pathlib.Path(audit_path).read_text())
gate = json.loads(pathlib.Path(gate_path).read_text())

public_details = {
    "dmg.verify": "hdiutil verification passed",
    "dmg.attach": "read-only attach passed",
    "app.present": "旅剪工作台.app",
    "app.signature-integrity": "codesign deep strict verification passed",
}
checks = []
for check in audit["checks"]:
    checks.append({
        "id": check["id"],
        "pass": check["pass"],
        "detail": public_details.get(check["id"], check["detail"]),
    })

public_report = {
    "schemaVersion": audit["schemaVersion"],
    "kind": "tripcut-public-dmg-audit",
    "capturedAt": audit["capturedAt"],
    "dmg": {
        "file": pathlib.Path(audit["dmg"]["path"]).name,
        "sha256": audit["dmg"]["sha256"],
        "expectedSignature": audit["dmg"]["expectedSignature"],
    },
    "app": {
        "aggregateMachOSha256": audit["app"]["aggregateMachOSha256"],
        "machoCount": len(audit["app"]["macho"]),
        "nativeSbomMismatchCount": len(audit["app"]["nativeSbomMismatches"]),
        "runtimeStringHitCount": len(audit["app"]["runtimeStringHits"]),
        "encoderSmoke": audit["app"]["encoderSmoke"]["metadata"],
    },
    "checks": checks,
}
gate["report"] = pathlib.Path(public_report_path).name
pathlib.Path(public_report_path).write_text(
    json.dumps(public_report, ensure_ascii=False, indent=2) + "\n"
)
pathlib.Path(public_gate_path).write_text(
    json.dumps(gate, ensure_ascii=False, indent=2) + "\n"
)
PY

DMG_NAME="$(basename "$DMG")"
DMG_SHA256="$(shasum -a 256 "$DMG" | awk '{print $1}')"
GIT_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
python3 - "$OUTPUT/SOURCE_MANIFEST.json" "$VERSION" "$DMG_NAME" "$DMG_SHA256" "$GIT_HEAD" "$MPV_COMMIT" <<'PY'
import json, pathlib, sys
output, version, dmg, dmg_sha256, git_head, mpv_commit = sys.argv[1:]
payload = {
    "schemaVersion": 1,
    "channel": "unsigned-preview",
    "version": version,
    "architecture": "arm64",
    "dmg": {"file": dmg, "sha256": dmg_sha256, "signature": "adhoc", "notarized": False},
    "tripcut": {"license": "Apache-2.0", "baseGitHead": git_head, "sourceIncludesWorkingTree": True},
    "thirdPartySources": {
        "ffmpeg": {"version": "7.1.5", "sha256": "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f"},
        "mpv": {"version": "0.41.0", "commit": mpv_commit, "patched": True},
        "libplacebo": {"version": "7.360.1", "sha256": "937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6"},
        "whisper.cpp": {"version": "1.9.2", "sha256": "a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd"},
    },
}
pathlib.Path(output).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

cp "$RELEASE_NOTES_SOURCE" "$OUTPUT/RELEASE_NOTES.md"
cat >> "$OUTPUT/RELEASE_NOTES.md" <<EOF

---

## 下载校验

\`$DMG_SHA256  $DMG_NAME\`

完整文件校验见本 Release 附件 \`SHA256SUMS.txt\`。
EOF

cd "$OUTPUT"
find . -type f ! -name SHA256SUMS.txt -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 > SHA256SUMS.txt

echo "PASS: GitHub Preview 发布目录已生成"
echo "OUTPUT=$OUTPUT"
echo "DMG_SHA256=$DMG_SHA256"
