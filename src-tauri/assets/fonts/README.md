# TripCutHanSansSC-Regular.otf

CJK-capable embedded font for the contact-sheet PDF (`core/contact_sheet.rs`,
R4 Task 2). Licensed under the SIL Open Font License 1.1 — see
`LICENSE-SourceHanSans.txt` (copied verbatim from the release zip). This is a
**Modified Version** of Adobe's Source Han Sans SC, renamed per OFL §3 — see
[关于改名](#关于改名) below before assuming the upstream name still applies.

## Source

- Project: Source Han Sans (Adobe) — https://github.com/adobe-fonts/source-han-sans
- Release tag: `2.005R`
- Asset used: `09_SourceHanSansSC.zip` (the SC-only, per-language OTF package —
  not the multi-region `05_SourceHanSansSubsetOTF.zip`, whose `SC`-equivalent
  folder is actually named `CN` in this release and is Adobe's own reduced
  repertoire, not what we wanted here), file
  `OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf`
- Download URL: `https://github.com/adobe-fonts/source-han-sans/releases/download/2.005R/09_SourceHanSansSC.zip`
- **Original file sha256**: `f1d8611151880c6c336aabeac4640ef434fa13cbfbf1ffe82d0a71b2a5637256`
  (of the extracted `SourceHanSansSC-Regular.otf`, 16,529,832 bytes)

## Subsetting

Built with `fonttools` (`pyftsubset`) in a throwaway venv — not installed into
system Python:

```sh
python3 -m venv /tmp/fontenv
/tmp/fontenv/bin/pip install fonttools brotli

/tmp/fontenv/bin/pyftsubset SourceHanSansSC-Regular.otf \
  --output-file=SourceHanSansSC-Regular.subset.otf \
  --unicodes=U+0020-007E,U+00A0-00FF,U+2013-2026,U+3000-303F,U+4E00-9FFF,U+FF00-FFEF \
  --layout-features= \
  --glyph-names \
  --no-hinting \
  --drop-tables+=BASE,JSTF,MATH,vhea,vmtx,VORG
```

Kept ranges (per task spec): basic Latin + Latin-1 supplement (U+0020-007E,
U+00A0-00FF), general punctuation dashes/ellipsis (U+2013-2026), CJK symbols
and punctuation (U+3000-303F), the full CJK Unified Ideographs block
(U+4E00-9FFF), and halfwidth/fullwidth forms (U+FF00-FFEF).

`--layout-features=` (empty) drops GSUB/GPOS feature lookups — the contact
sheet only needs static, unshaped horizontal Latin/CJK glyph placement, no
ligatures or vertical layout, so this is a safe size cut versus `--layout-features='*'`.
Hinting is dropped (irrelevant for print/PDF rasterization at fixed size).
CFF subroutinization is left in place (i.e. **no** `--desubroutinize`) because
desubroutinizing a CFF table *inflates* it — verified empirically here it added
~250KB with the full ideograph block kept, with no benefit.

## Result

- **Subset file sha256** (`SourceHanSansSC-Regular.subset.otf`, intermediate
  artifact before the rename below, no longer shipped): `1256fa9ec24772eeeb7f631701ef8416a4a94ad4cc2059aa1b9735d2b50a820b`
- Size: 5,053,224 bytes (~4.82 MiB)
- Glyph count: 21,484

## 关于改名

The upstream OFL license (`LICENSE-SourceHanSans.txt`, copyright line) declares
a **Reserved Font Name**: `'Source'`. OFL §3 says:

> No Modified Version of the Font Software may use the Reserved Font Name(s)
> ... in its name.

The subset produced above (`--unicodes=...`, `--layout-features=`,
`--drop-tables+=...`, hinting stripped) is a Modified Version under the OFL's
own definition ("any derivative made by ... subsetting"), and its `name` table
still read `Source Han Sans SC` / `SourceHanSansSC-Regular` — i.e. it presented
the Reserved Font Name for a font Adobe did not produce this exact byte layout
of. That is the violation this rename fixes.

The font was **not** re-subset; only the OpenType `name` table was rewritten
in place with `fontTools`, using the same throwaway venv as the subsetting
step:

```sh
/tmp/fontenv/bin/python - <<'PY'
from fontTools.ttLib import TTFont

f = TTFont("SourceHanSansSC-Regular.subset.otf")
name = f["name"]

RENAMES = {
    1: "TripCut Han Sans SC",                                              # family
    4: "TripCut Han Sans SC Regular",                                      # full name
    6: "TripCutHanSansSC-Regular",                                         # PostScript name
    3: "TripCutHanSansSC-Regular;subset-of-SourceHanSansSC-2.005R",        # unique id
}
for nameID, value in RENAMES.items():
    for rec in [n for n in name.names if n.nameID == nameID]:
        name.setName(value, nameID, rec.platformID, rec.platEncID, rec.langID)
# nameID 16 (typographic family) was not present in the subset — not invented.
# nameID 0 (copyright, keeps the 'Reserved Font Name Source' notice) and
# nameID 13/14 (OFL license notice/URL — not present in this build either)
# are left untouched.

f.save("TripCutHanSansSC-Regular.otf")
PY
```

What changed vs. what didn't:

- **Changed** (nameIDs 1, 3, 4, 6 — family/full/unique-id/PostScript name):
  `Source Han Sans SC` / `SourceHanSansSC-Regular` → `TripCut Han Sans SC` /
  `TripCutHanSansSC-Regular`. nameID 16 was absent from the source font and
  was not added.
- **Unchanged**: nameID 0 (copyright — still reads `© 2014-2025 Adobe
  (http://www.adobe.com/), with Reserved Font Name 'Source'.`), all glyph
  outlines, cmap, hinting/layout state from the subsetting step above. The
  original attribution and OFL notice are not stripped — only the presented
  font *name* changes, which is exactly what OFL §3 requires of a Modified
  Version that carries a Reserved Font Name.
- **File renamed**: `SourceHanSansSC-Regular.subset.otf` →
  `TripCutHanSansSC-Regular.otf` (the intermediate subset file is not shipped;
  only the renamed file is committed).

**Renamed (shipped) file sha256**: `4d6fb8d90b39a1b27761f499dc0382bfa42ded4f0de87e827d5a68d85191413e`
Size: 5,053,316 bytes (~4.82 MiB)

Verification of the renamed `name` table (no `Source` in nameIDs 1/4/6/16):

```sh
/tmp/fontenv/bin/python -c "from fontTools.ttLib import TTFont; f=TTFont('TripCutHanSansSC-Regular.otf'); print([ (n.nameID, n.toUnicode()) for n in f['name'].names if n.nameID in (1,3,4,6,16)])"
# [(1, 'TripCut Han Sans SC'), (3, 'TripCutHanSansSC-Regular;subset-of-SourceHanSansSC-2.005R'),
#  (4, 'TripCut Han Sans SC Regular'), (6, 'TripCutHanSansSC-Regular')]
```

### Deviation from the ≤2.5 MB target

The task resolutions listed a ≤2.5 MB target *and* "keep ranges ... U+4E00-9FFF"
(the entire CJK Unified Ideographs block, ~20,900 assigned code points). Those
two constraints are mutually exclusive for this typeface: even after dropping
GSUB/GPOS, hinting, and non-essential tables, subsetting to the *full* ideograph
block bottoms out at ~4.8 MB — the CFF outline data for ~21k ideograph glyphs
dominates the file regardless of table-level trimming (measured floor with
`--desubroutinize` was ~5.3 MB; without it, ~4.82 MB — see below for a smaller
option).

Decision made here: keep the full U+4E00-9FFF range and accept ~4.82 MB, because
travel-clip file names and chapter titles are arbitrary user text (place names,
personal names) and are not guaranteed to fall inside a "common characters"
list — Task 2's `missing_glyphs()` fallback exists to make *rare* gaps visible,
not to be the primary coverage strategy for everyday full-block Hanzi. Bundle
size wise, ~4.82 MB next to the app's other native payloads (mpv/ffmpeg/whisper
dylibs, tens of MB) is a comparatively small addition.

If a hard 2.5 MB ceiling turns out to matter (e.g. for a lighter DMG target),
the fallback is restricting the ideograph range to the GB 2312 common-use set
(6,763 characters — covers the overwhelming majority of modern Simplified
Chinese text) instead of the full block:

```sh
# generate the codepoint list once
python3 -c "
chars=set()
for b1 in range(0xB0,0xF8):
    for b2 in range(0xA1,0xFF):
        try:
            c=bytes([b1,b2]).decode('gb2312')
            if len(c)==1 and '一'<=c<='鿿': chars.add(c)
        except Exception: pass
open('gb2312_hanzi.txt','w').write(''.join(sorted(chars)))
"
/tmp/fontenv/bin/pyftsubset SourceHanSansSC-Regular.otf \
  --output-file=SourceHanSansSC-Regular.subset.otf \
  --unicodes=U+0020-007E,U+00A0-00FF,U+2013-2026,U+3000-303F,U+FF00-FFEF \
  --text-file=gb2312_hanzi.txt \
  --layout-features= --no-hinting \
  --drop-tables+=BASE,JSTF,MATH,vhea,vmtx,VORG
```

That variant measured 1,532,028 bytes (~1.46 MiB) in a side-by-side test but was
**not** shipped, since it would silently drop uncommon Hanzi (rarer surnames,
place names) that a travel-clip filename could plausibly contain. Not shipped
here; documented for future use if size pressure requires it.

## Glyph coverage verification

Run against the subset before renaming (glyph outlines/cmap are untouched by
the rename, so the result is identical for the shipped `TripCutHanSansSC-Regular.otf`):

```sh
/tmp/fontenv/bin/python3 - <<'PY'
from fontTools.ttLib import TTFont
f = TTFont('TripCutHanSansSC-Regular.otf')
cmap = f.getBestCmap()
for word in ["旅剪工作台", "第一章"]:
    missing = [c for c in word if ord(c) not in cmap]
    print(word, "OK" if not missing else f"MISSING {missing}")
PY
```

Output:

```
旅剪工作台 OK
第一章 OK
```
