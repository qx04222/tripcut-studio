"""Deterministic, original 64x48 uncompressed RGB TIFF/DNG test fixture.
No camera RAW claim: exercises ImageIO's DNG container, orientation and fallback.
"""
from pathlib import Path
import struct

entries = [(254,4,1,0),(256,4,1,64),(257,4,1,48),(258,3,3,0),
           (259,3,1,1),(262,3,1,2),(273,4,1,0),(274,3,1,6),
           (277,3,1,3),(278,4,1,48),(279,4,1,64*48*3),(284,3,1,1),
           (50706,1,4,0x00000401),(50707,1,4,0x00000101)]
end = 8+2+len(entries)*12+4
entries[3] = (258,3,3,end)
entries[6] = (273,4,1,end+6)
data = bytearray(b'II\x2a\x00\x08\x00\x00\x00')
data += struct.pack('<H',len(entries))
for entry in entries:
    data += struct.pack('<HHII',*entry)
data += struct.pack('<IHHH',0,8,8,8)
for y in range(48):
    for x in range(64):
        data += bytes((220 if x<32 else 20, 180 if y<24 else 30, 60))
Path(__file__).with_name('minimal-rgb.dng').write_bytes(data)
