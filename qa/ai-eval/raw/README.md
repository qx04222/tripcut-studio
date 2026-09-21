# PH-10 synthetic fixture

Run `python3 qa/ai-eval/raw/generate.py` to regenerate `minimal-rgb.dng`.
It is original test data: little-endian TIFF, one IFD, DNGVersion 1.4,
DNGBackwardVersion 1.1, uncompressed 8-bit RGB strips, 64×48 pixels,
Orientation=6. The four colored regions make rotation inspectable.

This is the task's minimal RGB TIFF/DNG fixture, not camera sensor data.
macOS ImageIO identifies this minimal container as TIFF. It verifies the
ARW/DNG extension dispatch, common ImageIO metadata/rendering pipeline,
orientation, decoded preview, persistence and handoff; it does not prove
camera RAW demosaicing, embedded JPEG selection, HDR or camera support.
Real iPhone 16/17 Pro Max ProRAW, A7R III, Leica Q and GR III samples remain
required (paired JPEG, standalone embedded preview, and no-preview cases).
