#!/bin/zsh
# 旅剪工作台分发打包:构建 .app → 内嵌 libmpv 依赖树(dylibbundler) → 重签 → DMG。
# 背景:二进制硬链接 /opt/homebrew 的 libmpv,分发到无 Homebrew 机器启动即崩(alpha.3 实报)。
# LGPL 合规:libmpv 及依赖以动态库形式随包分发,源码见 https://github.com/mpv-player/mpv。
set -euo pipefail

# 非交互 shell(后台任务、CI、agent)不读用户 profile,PATH 里没有 cargo,
# tauri 会以 "failed to run cargo metadata" 失败。这里显式补上工具链目录。
for TOOL_DIR in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin" /opt/homebrew/bin; do
  [ -d "$TOOL_DIR" ] && PATH="$TOOL_DIR:$PATH"
done
export PATH
command -v cargo >/dev/null || { echo "ERROR: PATH 里找不到 cargo"; exit 1; }
for REQUIRED_COMMAND in npm python3 otool dylibbundler codesign hdiutil shasum file dwarfdump rg brew; do
  command -v "$REQUIRED_COMMAND" >/dev/null || {
    echo "ERROR: PATH 里找不到 $REQUIRED_COMMAND"
    exit 1
  }
done
[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: DMG 只能在 macOS 上构建"; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "ERROR: 当前发行基线只支持 arm64"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_LOCK_FILE="$ROOT/src-tauri/target/.tripcut-package-dmg.lock"
mkdir -p "$ROOT/src-tauri/target"
if [ "${TRIPCUT_PACKAGE_LOCKED:-0}" != "1" ]; then
  /usr/bin/lockf -s -t 0 "$PACKAGE_LOCK_FILE" \
    env TRIPCUT_PACKAGE_LOCKED=1 "$0" "$@" || {
      lock_exit=$?
      [ "$lock_exit" -ne 75 ] || echo "ERROR: 已有 TripCut 打包任务持有锁：$PACKAGE_LOCK_FILE"
      exit "$lock_exit"
    }
  exit 0
fi
APP="$ROOT/src-tauri/target/release/bundle/macos/旅剪工作台.app"
BIN="$APP/Contents/MacOS/tripcut-studio"
FRAMEWORKS="$APP/Contents/Frameworks"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
BUILD_STAMP="${TRIPCUT_BUILD_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if ! echo "$BUILD_STAMP" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "ERROR: TRIPCUT_BUILD_STAMP 只能包含字母、数字、点、下划线和连字符"
  exit 1
fi
PACKAGE_MODE="${TRIPCUT_PACKAGE_MODE:-qa}"
case "$PACKAGE_MODE" in
  qa|preview|pre-notary|release) ;;
  *) echo "ERROR: TRIPCUT_PACKAGE_MODE 必须是 qa、preview、pre-notary 或 release"; exit 1 ;;
esac
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
DMG_OUT="$DMG_DIR/旅剪工作台_${VERSION}_${BUILD_STAMP}_${PACKAGE_MODE}_aarch64.dmg"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
ALLOW_ADHOC="${TRIPCUT_ALLOW_ADHOC:-0}"
NOTARY_PROFILE="${TRIPCUT_NOTARY_PROFILE:-}"
STAGE=""
DMG_TMP=""
BUNDLE_LOG=""

mkdir -p "$ROOT/src-tauri/target" "$DMG_DIR"
cleanup() {
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  [ -z "$DMG_TMP" ] || rm -f "$DMG_TMP"
  [ -z "$BUNDLE_LOG" ] || rm -f "$BUNDLE_LOG"
}
trap cleanup EXIT HUP INT TERM

if [ -e "$DMG_OUT" ]; then
  echo "ERROR: 输出已存在，拒绝覆盖：$DMG_OUT"
  exit 1
fi

if [ "$PACKAGE_MODE" = "qa" ] || [ "$PACKAGE_MODE" = "preview" ]; then
  if [ -z "$SIGNING_IDENTITY" ]; then SIGNING_IDENTITY="-"; fi
  if [ "$SIGNING_IDENTITY" = "-" ] && [ "$ALLOW_ADHOC" != "1" ]; then
    echo "ERROR: ad-hoc QA 包必须显式设置 TRIPCUT_ALLOW_ADHOC=1"
    exit 1
  fi
elif [ -z "$SIGNING_IDENTITY" ] || [ "$SIGNING_IDENTITY" = "-" ]; then
  echo "ERROR: $PACKAGE_MODE 模式必须设置 Developer ID Application 签名身份"
  exit 1
fi
if [ "$SIGNING_IDENTITY" = "-" ] && [ "$PACKAGE_MODE" = "qa" ]; then
  SIGNING_IDENTITY="-"
  echo "WARN: 本次是 ad-hoc 签名的 QA 候选，不可对外发布"
elif [ "$SIGNING_IDENTITY" = "-" ]; then
  echo "WARN: 本次是公开测试用的未签名预览包；必须附校验和、源码附件和 Gatekeeper 风险说明"
fi
if [ "$PACKAGE_MODE" = "release" ] && [ -z "$NOTARY_PROFILE" ]; then
  echo "ERROR: release 模式必须设置 TRIPCUT_NOTARY_PROFILE"
  exit 1
fi

LGPL_MPV="${LGPL_MPV:-/tmp/mpv-lgpl/out}"
LGPL_FFMPEG="${LGPL_FFMPEG:-/tmp/ffmpeg-lgpl/out}"
LIBPLACEBO_OUT="${LIBPLACEBO_OUT:-/tmp/libplacebo-tripcut/out-v7.360.1-opengl}"
MPV_TAG="${MPV_TAG:-v0.41.0}"
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.5}"
MPV_SOURCE_ROOT="${MPV_SOURCE_ROOT:-$(dirname "$LGPL_MPV")/mpv}"
FFMPEG_SOURCE_ROOT="${FFMPEG_SOURCE_ROOT:-$(dirname "$LGPL_FFMPEG")/ffmpeg-$FFMPEG_VERSION}"
FFMPEG_SOURCE_ARCHIVE="${FFMPEG_SOURCE_ARCHIVE:-$(dirname "$LGPL_FFMPEG")/ffmpeg.tar.xz}"
[ -f "$LGPL_MPV/lib/libmpv.2.dylib" ] || { echo "ERROR: 缺少 libmpv：$LGPL_MPV/lib/libmpv.2.dylib"; exit 1; }
[ -f "$LIBPLACEBO_OUT/lib/libplacebo.360.dylib" ] || { echo "ERROR: 缺少 TripCut 专用 libplacebo：$LIBPLACEBO_OUT"; exit 1; }
for REQUIRED in "$LGPL_FFMPEG/bin/ffmpeg" "$LGPL_FFMPEG/bin/ffprobe"; do
  [ -f "$REQUIRED" ] && [ -x "$REQUIRED" ] || {
    echo "ERROR: 缺少可执行的 LGPL 产物：$REQUIRED"
    exit 1
  }
done

FFMPEG_VERSION_ACTUAL="$($LGPL_FFMPEG/bin/ffmpeg -version 2>/dev/null | sed -n 's/^ffmpeg version \([^ ]*\).*/\1/p')"
FFMPEG_CONFIGURATION="$($LGPL_FFMPEG/bin/ffmpeg -version 2>/dev/null | sed -n 's/^configuration: //p')"
[ "$FFMPEG_VERSION_ACTUAL" = "$FFMPEG_VERSION" ] || {
  echo "ERROR: FFmpeg 版本不符：期望 $FFMPEG_VERSION，实际 ${FFMPEG_VERSION_ACTUAL:-unknown}"; exit 1
}
[ -s "$FFMPEG_SOURCE_ARCHIVE" ] || { echo "ERROR: 缺少 FFmpeg 源码归档：$FFMPEG_SOURCE_ARCHIVE"; exit 1; }
FFMPEG_SOURCE_SHA256="$(shasum -a 256 "$FFMPEG_SOURCE_ARCHIVE" | awk '{print $1}')"
[ -n "$FFMPEG_CONFIGURATION" ] || { echo "ERROR: 无法取得 FFmpeg configuration，拒绝打包"; exit 1; }
if echo "$FFMPEG_CONFIGURATION" | grep -qE -- "--enable-(gpl|version3|nonfree)|--enable-libx26[45]"; then
  echo "ERROR: $LGPL_FFMPEG 里的 ffmpeg 含 GPL/version3/nonfree/x264/x265 组件，拒绝打包"
  exit 1
fi
if otool -L "$LGPL_MPV/lib/libmpv.2.dylib" | grep -qE "/opt/homebrew/(opt/ffmpeg|Cellar/ffmpeg)"; then
  echo "ERROR: $LGPL_MPV 的 libmpv 仍链接 Homebrew ffmpeg，拒绝打包"
  exit 1
fi

WHISPER_SRC="${WHISPER_CLI:-/tmp/whisper-static/out/bin/whisper-cli}"
WHISPER_BUILD_MANIFEST="${WHISPER_BUILD_MANIFEST:-$(dirname "$(dirname "$WHISPER_SRC")")/build-manifest.json}"
if [ -z "$WHISPER_SRC" ] || [ ! -x "$WHISPER_SRC" ]; then
  echo "ERROR: 缺少发行所需的固定 whisper-cli；请先运行 scripts/build-whisper.sh"
  exit 1
fi
[ -s "$WHISPER_BUILD_MANIFEST" ] || { echo "ERROR: 缺少 whisper 构建清单：$WHISPER_BUILD_MANIFEST"; exit 1; }
if otool -L "$WHISPER_SRC" | grep -qE '/opt/homebrew|/usr/local'; then
  echo "ERROR: whisper-cli 仍链接构建机路径，拒绝打包"; exit 1
fi
if rg -a -q '/opt/homebrew/Cellar/ggml|GGML_BACKEND_PATH' "$WHISPER_SRC"; then
  echo "ERROR: whisper-cli 仍可发现外部 ggml backend，拒绝打包"; exit 1
fi
for LEGAL_SOURCE in \
  "$ROOT/LICENSE" \
  "$ROOT/docs/THIRD_PARTY_NOTICES.txt" \
  "$ROOT/docs/third_party/whisper.cpp-LICENSE" \
  "$MPV_SOURCE_ROOT/LICENSE.LGPL" \
  "$MPV_SOURCE_ROOT/Copyright" \
  "$FFMPEG_SOURCE_ROOT/LICENSE.md" \
  "$FFMPEG_SOURCE_ROOT/COPYING.LGPLv2.1"; do
  [ -f "$LEGAL_SOURCE" ] || { echo "ERROR: 缺少发行法务材料：$LEGAL_SOURCE"; exit 1; }
done

echo "==> tauri build (app only)"
cd "$ROOT"
# 让主二进制链到 LGPL libmpv(而非 Homebrew 的 GPL 版);build.rs 读这个变量。
export LGPL_MPV_LIB="$LGPL_MPV/lib"
echo "    链接 LGPL libmpv:$LGPL_MPV_LIB"
npm run tauri build -- --bundles app

echo "==> staging bundled executables (LGPL ffmpeg / whisper-cli)"
mkdir -p "$FRAMEWORKS"

# LGPL ffmpeg:Homebrew 版带 --enable-gpl/libx264/x265,打包分发会 GPLv3 传染。
cp "$LGPL_FFMPEG/bin/ffmpeg" "$APP/Contents/MacOS/ffmpeg"
cp "$LGPL_FFMPEG/bin/ffprobe" "$APP/Contents/MacOS/ffprobe"
echo "    LGPL ffmpeg/ffprobe 已就位"

# whisper-cli(MIT)
cp "$WHISPER_SRC" "$APP/Contents/MacOS/whisper-cli"
echo "    whisper-cli 已就位：$WHISPER_SRC"

echo "==> staging license materials"
LEGAL_DIR="$APP/Contents/Resources/legal"
mkdir -p "$LEGAL_DIR/mpv" "$LEGAL_DIR/ffmpeg" "$LEGAL_DIR/whisper.cpp" "$LEGAL_DIR/libplacebo" "$LEGAL_DIR/native"
cp "$ROOT/LICENSE" "$LEGAL_DIR/TRIPCUT-LICENSE.txt"
cp "$ROOT/docs/THIRD_PARTY_NOTICES.txt" "$LEGAL_DIR/THIRD_PARTY_NOTICES.txt"
cp "$MPV_SOURCE_ROOT/LICENSE.LGPL" "$LEGAL_DIR/mpv/LICENSE.LGPL"
cp "$MPV_SOURCE_ROOT/Copyright" "$LEGAL_DIR/mpv/Copyright"
cp "$FFMPEG_SOURCE_ROOT/LICENSE.md" "$LEGAL_DIR/ffmpeg/LICENSE.md"
cp "$FFMPEG_SOURCE_ROOT/COPYING.LGPLv2.1" "$LEGAL_DIR/ffmpeg/COPYING.LGPLv2.1"
cp "$ROOT/docs/third_party/whisper.cpp-LICENSE" "$LEGAL_DIR/whisper.cpp/LICENSE"
cp "$LIBPLACEBO_OUT/LICENSE" "$LEGAL_DIR/libplacebo/LICENSE"
cp "$LIBPLACEBO_OUT/build-manifest.txt" "$LEGAL_DIR/libplacebo/build-manifest.txt"

# Homebrew 提供每个 bottle 的 SPDX 文件；同时复制所选许可证全文/署名材料。
# 未知新增 dylib 会在下方 native-sbom 生成时直接红灯，不能靠黑名单静默放行。
python3 - "$LEGAL_DIR/native" "$FFMPEG_SOURCE_ROOT/COPYING.LGPLv2.1" <<'PY'
import pathlib, shutil, sys
target, lgpl = map(pathlib.Path, sys.argv[1:])
components = {
    "libass": ["COPYING"],
    "freetype": ["LICENSE.TXT"],
    "fribidi": ["COPYING", "AUTHORS"],
    "glib": ["LGPL-2.1-or-later.txt"],
    "graphite2": ["LICENSE", "COPYING"],
    "harfbuzz": ["COPYING", "AUTHORS"],
    "gettext": ["COPYING", "AUTHORS"],
    "jpeg-turbo": ["LICENSE.md", "share/doc/libjpeg-turbo/README.ijg"],
    "little-cms2": ["LICENSE", "AUTHORS"],
    "pcre2": ["LICENCE.md", "AUTHORS.md"],
    "libpng": ["LICENSE", "AUTHORS"],
    "uchardet": ["COPYING", "AUTHORS"],
    "libunibreak": ["LICENCE", "AUTHORS"],
}
for formula, files in components.items():
    source = pathlib.Path("/opt/homebrew/opt") / formula
    destination = target / formula
    destination.mkdir(parents=True, exist_ok=True)
    sbom = source / "sbom.spdx.json"
    if not sbom.is_file():
        raise SystemExit(f"missing Homebrew SPDX SBOM: {sbom}")
    shutil.copy2(sbom, destination / "homebrew-sbom.spdx.json")
    for relative in files:
        evidence = source / relative
        if not evidence.is_file():
            raise SystemExit(f"missing license evidence: {evidence}")
        shutil.copy2(evidence, destination / pathlib.Path(relative).name)
# libintl is LGPL; Homebrew's top-level gettext COPYING is GPL for its tools.
# Preserve both upstream package evidence and the exact LGPL text elected for libintl.
shutil.copy2(lgpl, target / "gettext" / "COPYING.LIB")
PY

# LGPL libmpv:Homebrew 的 libmpv 链接 GPL 版 libavcodec,会把 x264/x265 拖进包里。
# 自编版链到 /tmp/ffmpeg-lgpl,依赖树零 GPL(见 scripts/build-lgpl-mpv.sh)。
MPV_SEARCH_PATH="$LGPL_MPV/lib"
echo "    使用 LGPL libmpv:$LGPL_MPV"

echo "==> bundling all dependency trees in one pass"
# 必须一次处理全部可执行文件:libmpv 与 ffmpeg 共享 libav*/SDL2 等库,
# 分多次调用时后一次会撞上前一次的产物直接报错中止(dylibbundler 不覆盖)。
BUNDLE_TARGETS=(-x "$BIN")
for EXE in ffmpeg ffprobe whisper-cli; do
  [ -f "$APP/Contents/MacOS/$EXE" ] && BUNDLE_TARGETS+=(-x "$APP/Contents/MacOS/$EXE")
done
BUNDLE_LOG="$(mktemp -t tripcut-dylibbundler.XXXXXX)"
dylibbundler -od -b \
  "${BUNDLE_TARGETS[@]}" \
  -d "$FRAMEWORKS" \
  -p '@executable_path/../Frameworks/' \
  -s "$MPV_SEARCH_PATH" -s "$LGPL_FFMPEG/lib" -s "$LIBPLACEBO_OUT/lib" -s /opt/homebrew/lib \
  -i /usr/lib > "$BUNDLE_LOG" 2>&1 || {
    echo "ERROR: dylibbundler 失败：$BUNDLE_LOG"
    tail -10 "$BUNDLE_LOG"
    exit 1
  }
echo "    $(ls "$FRAMEWORKS"/*.dylib | wc -l | tr -d ' ') 个依赖库已内嵌"

echo "==> deduplicating LC_RPATH (tauri already ships @executable_path/../Frameworks/)"
for EXE in "$BIN" "$APP/Contents/MacOS/whisper-cli" "$APP/Contents/MacOS/ffmpeg" "$APP/Contents/MacOS/ffprobe"; do
  [ -f "$EXE" ] || continue
  RPATH_COUNT=$(otool -l "$EXE" | grep -A2 LC_RPATH | grep -c "@executable_path/../Frameworks/" || true)
  while [ "$RPATH_COUNT" -gt 1 ]; do
    install_name_tool -delete_rpath '@executable_path/../Frameworks/' "$EXE"
    RPATH_COUNT=$((RPATH_COUNT - 1))
  done
done

echo "==> deduplicating LC_RPATH inside bundled dylibs (dyld hard-errors on duplicates)"
for LIB in "$FRAMEWORKS"/*.dylib; do
  N=$(otool -l "$LIB" | grep -A2 LC_RPATH | grep -c "path @executable_path/../Frameworks/" || true)
  while [ "$N" -gt 1 ]; do
    install_name_tool -delete_rpath '@executable_path/../Frameworks/' "$LIB" 2>/dev/null
    N=$((N - 1))
  done
done

echo "==> verifying no /opt/homebrew references remain"
MACHO_EXTERNAL=0
while IFS= read -r -d '' CANDIDATE; do
  file -b "$CANDIDATE" | grep -q "Mach-O" || continue
  while IFS= read -r DEPENDENCY; do
    case "$DEPENDENCY" in
      ""|@*|/System/*|/usr/lib/*) ;;
      *) echo "ERROR: 外部运行时依赖：$CANDIDATE -> $DEPENDENCY"; MACHO_EXTERNAL=$((MACHO_EXTERNAL + 1)) ;;
    esac
  done < <(otool -L "$CANDIDATE" | tail -n +2 | awk '{print $1}')
done < <(find "$APP" -type f -print0)
[ "$MACHO_EXTERNAL" -eq 0 ] || exit 1
echo "    $(ls "$FRAMEWORKS" | wc -l | tr -d ' ') dylibs bundled"

echo "==> re-signing ($SIGNING_IDENTITY)"
NESTED_SIGN_ARGS=(--force --sign "$SIGNING_IDENTITY")
if [ "$SIGNING_IDENTITY" != "-" ]; then
  NESTED_SIGN_ARGS+=(--options runtime --timestamp)
fi
find "$FRAMEWORKS" -name "*.dylib" -exec codesign "${NESTED_SIGN_ARGS[@]}" {} \;
codesign "${NESTED_SIGN_ARGS[@]}" "$BIN"
for EXE in whisper-cli ffmpeg ffprobe; do
  [ -f "$APP/Contents/MacOS/$EXE" ] && codesign "${NESTED_SIGN_ARGS[@]}" "$APP/Contents/MacOS/$EXE"
done

echo "==> recording hashes of the final packaged payloads"
python3 - "$LEGAL_DIR/build-provenance.json" "$MPV_TAG" "$FFMPEG_VERSION_ACTUAL" "$WHISPER_BUILD_MANIFEST" \
  "$APP/Contents/Frameworks/libmpv.2.dylib" "$APP/Contents/MacOS/ffmpeg" \
  "$APP/Contents/MacOS/ffprobe" "$APP/Contents/MacOS/whisper-cli" \
  "$FFMPEG_CONFIGURATION" "$FFMPEG_SOURCE_SHA256" \
  "$APP/Contents/Frameworks/libplacebo.360.dylib" "$LIBPLACEBO_OUT/build-manifest.txt" <<'PY'
import hashlib, json, pathlib, sys
output, mpv_tag, ffmpeg_version, whisper_manifest, mpv, ffmpeg, ffprobe, whisper, configuration, ffmpeg_source_sha256, libplacebo, libplacebo_manifest = sys.argv[1:]
def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
whisper_build = json.loads(pathlib.Path(whisper_manifest).read_text())
payload = {
    "schemaVersion": 2,
    "hashScope": "final-packaged-files-after-rewrite-and-nested-signing",
    "mpv": {"tag": mpv_tag, "path": "Contents/Frameworks/libmpv.2.dylib", "sha256": digest(mpv), "license": "LGPL-2.1-or-later"},
    "ffmpeg": {
        "path": "Contents/MacOS/ffmpeg", "sha256": digest(ffmpeg),
        "ffprobePath": "Contents/MacOS/ffprobe", "ffprobeSha256": digest(ffprobe),
        "version": ffmpeg_version,
        "sourceUrl": f"https://ffmpeg.org/releases/ffmpeg-{ffmpeg_version}.tar.xz",
        "sourceSha256": ffmpeg_source_sha256,
        "configuration": configuration, "license": "LGPL-2.1-or-later"
    },
    "whisperCpp": {
        "path": "Contents/MacOS/whisper-cli", "sha256": digest(whisper),
        "version": whisper_build["version"], "sourceUrl": whisper_build["sourceUrl"],
        "sourceSha256": whisper_build["sourceSha256"], "dynamicBackendLoading": False,
        "sourcePatch": whisper_build["sourcePatch"],
        "sourcePatchSha256": whisper_build["sourcePatchSha256"],
        "license": "MIT"
    },
    "libplacebo": {
        "path": "Contents/Frameworks/libplacebo.360.dylib",
        "sha256": digest(libplacebo),
        "buildManifestSha256": digest(libplacebo_manifest),
        "license": "LGPL-2.1-or-later",
        "unusedBackendsDisabled": ["vulkan", "shaderc", "glslang"]
    },
}
pathlib.Path(output).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

echo "==> generating exact native Mach-O to license SBOM"
python3 - "$APP" "$LEGAL_DIR/native-sbom.json" <<'PY'
import hashlib, json, pathlib, subprocess, sys
app, output = map(pathlib.Path, sys.argv[1:])
frameworks = app / "Contents/Frameworks"
macos = app / "Contents/MacOS"

components = [
    ("TripCut Studio", "PROPRIETARY", ["tripcut-studio"], []),
    ("FFmpeg", "LGPL-2.1-or-later", ["ffmpeg", "ffprobe", "libavcodec.", "libavfilter.", "libavformat.", "libavutil.", "libswresample.", "libswscale."], ["ffmpeg/LICENSE.md", "ffmpeg/COPYING.LGPLv2.1"]),
    ("mpv", "LGPL-2.1-or-later", ["libmpv."], ["mpv/LICENSE.LGPL", "mpv/Copyright"]),
    ("whisper.cpp", "MIT", ["whisper-cli"], ["whisper.cpp/LICENSE"]),
    ("libplacebo", "LGPL-2.1-or-later", ["libplacebo."], ["libplacebo/LICENSE", "libplacebo/build-manifest.txt"]),
    ("libass", "ISC", ["libass."], ["native/libass/COPYING", "native/libass/homebrew-sbom.spdx.json"]),
    ("FreeType", "FTL", ["libfreetype."], ["native/freetype/LICENSE.TXT", "native/freetype/homebrew-sbom.spdx.json"]),
    ("FriBidi library", "LGPL-2.1-or-later", ["libfribidi."], ["native/fribidi/COPYING", "native/fribidi/homebrew-sbom.spdx.json"]),
    ("GLib", "LGPL-2.1-or-later", ["libglib-"], ["native/glib/LGPL-2.1-or-later.txt", "native/glib/homebrew-sbom.spdx.json"]),
    ("Graphite2", "MIT", ["libgraphite2."], ["native/graphite2/LICENSE", "native/graphite2/homebrew-sbom.spdx.json"]),
    ("HarfBuzz", "MIT", ["libharfbuzz."], ["native/harfbuzz/COPYING", "native/harfbuzz/homebrew-sbom.spdx.json"]),
    ("GNU libintl", "LGPL-2.1-or-later", ["libintl."], ["native/gettext/COPYING.LIB", "native/gettext/homebrew-sbom.spdx.json"]),
    ("libjpeg-turbo", "IJG AND Zlib AND BSD-3-Clause", ["libjpeg."], ["native/jpeg-turbo/LICENSE.md", "native/jpeg-turbo/README.ijg", "native/jpeg-turbo/homebrew-sbom.spdx.json"]),
    ("Little CMS", "MIT", ["liblcms2."], ["native/little-cms2/LICENSE", "native/little-cms2/homebrew-sbom.spdx.json"]),
    ("PCRE2", "BSD-3-Clause WITH PCRE2-exception", ["libpcre2-"], ["native/pcre2/LICENCE.md", "native/pcre2/homebrew-sbom.spdx.json"]),
    ("libpng", "libpng-2.0", ["libpng"], ["native/libpng/LICENSE", "native/libpng/homebrew-sbom.spdx.json"]),
    ("uchardet", "MPL-1.1", ["libuchardet."], ["native/uchardet/COPYING", "native/uchardet/homebrew-sbom.spdx.json"]),
    ("libunibreak", "Zlib", ["libunibreak."], ["native/libunibreak/LICENCE", "native/libunibreak/homebrew-sbom.spdx.json"]),
]

files = [macos / name for name in ["tripcut-studio", "ffmpeg", "ffprobe", "whisper-cli"]]
files += sorted(frameworks.glob("*.dylib"))
entries, unknown = [], []
for path in files:
    name = path.name
    matches = [item for item in components if any(name == prefix or name.startswith(prefix) for prefix in item[2])]
    if len(matches) != 1:
        unknown.append(name)
        continue
    component, license_expression, _, evidence = matches[0]
    for relative in evidence:
        if not (app / "Contents/Resources/legal" / relative).is_file():
            raise SystemExit(f"missing license evidence for {name}: {relative}")
    entries.append({
        "path": str(path.relative_to(app)),
        # The outer app signature rewrites the main executable after this embedded
        # manifest is created. Its final hash is therefore recorded by the external
        # DMG audit; nested payload hashes remain stable and are recorded here.
        "sha256": None if name == "tripcut-studio" else hashlib.sha256(path.read_bytes()).hexdigest(),
        "uuid": subprocess.run(["dwarfdump", "--uuid", str(path)], capture_output=True, text=True, check=True).stdout.strip(),
        "component": component,
        "licenseConcluded": license_expression,
        "licenseEvidence": evidence,
    })
if unknown:
    raise SystemExit("unmapped native payloads: " + ", ".join(unknown))
payload = {"schemaVersion": 1, "hashScope": "nested-payloads-before-outer-app-signing; main executable externally audited", "relationship": "FILE CONTAINED_BY COMPONENT", "files": entries}
output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY
if [ "$SIGNING_IDENTITY" = "-" ]; then
  codesign --force --entitlements "$ROOT/src-tauri/entitlements.plist" --sign "$SIGNING_IDENTITY" "$APP"
else
  codesign --force --options runtime --timestamp \
    --entitlements "$ROOT/src-tauri/entitlements.plist" \
    --sign "$SIGNING_IDENTITY" "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> final self-check (critical payloads present)"
for MUST in \
  "$FRAMEWORKS/libmpv.2.dylib" \
  "$APP/Contents/MacOS/ffmpeg" \
  "$APP/Contents/MacOS/ffprobe" \
  "$APP/Contents/MacOS/whisper-cli" \
  "$APP/Contents/Resources/sidecar/clip_service.py" \
  "$APP/Contents/Resources/sidecar/self_test.py"; do
  if [ ! -f "$MUST" ]; then
    echo "ERROR: missing critical payload: $MUST"; exit 1
  fi
done
for LEGAL_PAYLOAD in \
  "$LEGAL_DIR/THIRD_PARTY_NOTICES.txt" \
  "$LEGAL_DIR/mpv/LICENSE.LGPL" \
  "$LEGAL_DIR/ffmpeg/COPYING.LGPLv2.1" \
  "$LEGAL_DIR/whisper.cpp/LICENSE" \
  "$LEGAL_DIR/libplacebo/LICENSE" \
  "$LEGAL_DIR/native-sbom.json" \
  "$LEGAL_DIR/build-provenance.json"; do
  [ -s "$LEGAL_PAYLOAD" ] || { echo "ERROR: missing legal payload: $LEGAL_PAYLOAD"; exit 1; }
done
# 法务自检:包内不得含 GPL 库(x264/x265 等)
GPL_LIBS=$(ls "$FRAMEWORKS" | grep -ciE "libx264|libx265|libdvd(read|nav|css)|libcdio|libSDL|librubberband|libvulkan|libshaderc|libzimg" || true)
if [ "$GPL_LIBS" -gt 0 ]; then
  echo "ERROR: 包内含 $GPL_LIBS 个 GPL 库,分发会导致 GPLv3 传染:"
  ls "$FRAMEWORKS" | grep -iE "libx264|libx265|libdvd(read|nav|css)|libcdio|libSDL|librubberband"
  echo "  修法:先跑 scripts/build-lgpl-ffmpeg.sh 与 scripts/build-lgpl-mpv.sh"
  exit 1
fi

# 数量仅用于观测；Whisper 静态化或媒体选项变化都会合法改变数量。
# 完整性由上面的全 Mach-O 外链扫描和下面的关键库清单共同判定。
DYLIB_COUNT=$(ls "$FRAMEWORKS"/*.dylib | wc -l | tr -d ' ')
echo "    已内嵌 $DYLIB_COUNT 个动态库"

# 确认关键依赖在场(比数数更可靠)
for MUST_LIB in libmpv libavcodec libavformat libavutil; do
  if ! ls "$FRAMEWORKS" | grep -q "$MUST_LIB"; then
    echo "ERROR: 缺少关键依赖 $MUST_LIB"; exit 1
  fi
done

echo "==> packaging DMG"
STAGE="$(mktemp -d -t tripcut-dmg-stage.XXXXXX)"
DMG_NAME="$(basename "$DMG_OUT" .dmg)"
DMG_TMP="$DMG_DIR/.${DMG_NAME}.candidate.$$.dmg"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "旅剪工作台" -srcfolder "$STAGE" -format UDZO "$DMG_TMP" > /dev/null
hdiutil verify "$DMG_TMP"
if [ "$SIGNING_IDENTITY" != "-" ]; then
  codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_TMP"
  codesign --verify --verbose=2 "$DMG_TMP"
fi
if [ "$PACKAGE_MODE" = "release" ]; then
  command -v xcrun >/dev/null || { echo "ERROR: 找不到 xcrun，无法公证"; exit 1; }
  xcrun notarytool submit "$DMG_TMP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_TMP"
  xcrun stapler validate "$DMG_TMP"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_TMP"
fi
[ ! -e "$DMG_OUT" ] || { echo "ERROR: 最终输出已存在，拒绝覆盖：$DMG_OUT"; exit 1; }
mv "$DMG_TMP" "$DMG_OUT"
DMG_TMP=""
shasum -a 256 "$DMG_OUT"
if [ "$PACKAGE_MODE" = "qa" ]; then
  echo "==> QA candidate only: ad-hoc signed, not notarized"
elif [ "$PACKAGE_MODE" = "preview" ]; then
  echo "==> UNSIGNED PREVIEW: ad-hoc signed, not notarized; publish only with source bundle and explicit warning"
elif [ "$PACKAGE_MODE" = "pre-notary" ]; then
  echo "==> Developer ID signed; notarization/stapling gate still required before release"
else
  echo "==> RELEASE: Developer ID signed, notarized and stapled"
fi
echo "==> done: $DMG_OUT"
