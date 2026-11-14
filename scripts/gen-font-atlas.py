"""Regenerates src/venture-engine/font-atlas.ts: python3 scripts/gen-font-atlas.py src/venture-engine/font-atlas.ts (needs Pillow and the Inter fonts)."""
import sys, zlib, base64, struct
from PIL import Image, ImageDraw, ImageFont
fonts = [("bold", "/usr/share/fonts/opentype/inter/Inter-Bold.otf", 64), ("regular", "/usr/share/fonts/opentype/inter/Inter-Regular.otf", 36)]
chars = [chr(c) for c in range(32, 127)] + ["£", "·", "’", "“", "”", "–"]
out = bytearray(); meta = {}
for name, path, size in fonts:
    f = ImageFont.truetype(path, size)
    asc, desc = f.getmetrics()
    glyphs = {}
    for ch in chars:
        adv = round(f.getlength(ch))
        bb = f.getbbox(ch)  # relative to origin at top (ascender)
        w, h = max(0, bb[2]-bb[0]), max(0, bb[3]-bb[1])
        off = len(out)
        if w and h:
            im = Image.new("L", (w, h), 0); ImageDraw.Draw(im).text((-bb[0], -bb[1]), ch, font=f, fill=255)
            out += im.tobytes()
        glyphs[ch] = [adv, bb[0], bb[1], w, h, off]
    meta[name] = {"size": size, "ascent": asc, "descent": desc, "glyphs": glyphs}
import json
data = base64.b64encode(zlib.compress(bytes(out), 9)).decode()
src = "/**\n * Generated glyph atlas (Inter Bold 64px, Inter Regular 36px; Inter is licensed under the SIL Open Font License 1.1,\n * which allows embedding). Each glyph: [advance, x offset, y offset from the top, width, height, byte offset].\n * Alpha bitmaps are deflated and base64-encoded. Regenerate with scripts outside the app; do not edit by hand.\n */\n\n"
src += "export const ATLAS_META = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + " as const;\n"
src += "export const ATLAS_DATA =\n" + "\n".join(f'  "{data[i:i+120]}"' + (" +" if i+120 < len(data) else ";") for i in range(0, len(data), 120)) + "\n"
open(sys.argv[1], "w").write(src)
print(len(out), len(data))
