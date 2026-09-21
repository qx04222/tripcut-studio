# HEIC direction fixture (tests only)

`orientation-6.heic` derives from libheif's synthetic `tests/data/rainbow-451x461.heic`.
Source: https://github.com/strukturag/libheif/blob/master/tests/data/rainbow-451x461.heic
Original Git blob: `6691f50f39bd69871a2abe284de2ef9f5243bc66`.
Original SHA-256: `4b2ce727f093944975f143ba2b39c4c64511b766d94552f8d51a755916e7f983`.

The fixture adds an essential `irot=3` property to primary item 1, updates the
ipma property association, enclosing box sizes and iloc offsets. Coded dimensions
remain 451x461; the display is rotated clockwise to 461x451. No source image
pixels were re-encoded. Tests assert the exported JPEG pixel dimensions and sRGB
profile using sips. This fixture uses the same ImageIO orientation-transform path
as EXIF orientation; the TIFF-based test additionally checks EXIF orientation 6.

libheif's license is included in COPYING.libheif. No libheif library, source code,
encoder, or runtime dependency is added to TripCut.
