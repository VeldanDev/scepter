"""Render an animated terminal demo GIF for Scepter's README.

Headless, no terminal needed: draws frames with Pillow using Consolas and the
Scepter palette, then assembles a looping GIF. Illustrative example output
(matches the README), representing real tool behaviour.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# --- palette ---
BG = (20, 19, 18)
BAR = (28, 26, 24)
RULE = (58, 54, 47)
FG = (237, 232, 224)
DIM = (139, 132, 122)
BRASS = (198, 161, 91)
OK = (127, 166, 99)
WARN = (201, 162, 75)
BAD = (201, 122, 107)
DOTS = [(201, 122, 107), (201, 162, 75), (127, 166, 99)]

# --- fonts ---
FONT_DIR = Path("C:/Windows/Fonts")
SIZE = 16
reg = ImageFont.truetype(str(FONT_DIR / "consola.ttf"), SIZE)
boldp = FONT_DIR / "consolab.ttf"
bold = ImageFont.truetype(str(boldp), SIZE) if boldp.exists() else reg

# --- geometry ---
PAD = 26
BAR_H = 40
LINE_H = 26
COLS = 60
CH_W = reg.getlength("m")
W = int(PAD * 2 + CH_W * COLS)
CMD = "scepter check acme/weather-mcp"
MARK_X = PAD + CH_W * 2  # where the check/warn glyph is drawn (shape, not font)

# Output lines: (mark, segments). mark in {None,"ok","warn","bad"} is drawn as a
# vector shape (Consolas has no check glyph). Marked lines pad their label with
# 4 leading spaces so text clears the drawn mark.
OUT = [
    (None, [("  acme/weather-mcp ", FG, bold), ("(github)", DIM, reg)]),
    (None, [("  A Model Context Protocol server for weather data", DIM, reg)]),
    (None, [("", FG, reg)]),
    ("ok", [("    Activity     ", FG, reg), ("active (8 days ago)", DIM, reg)]),
    ("ok", [("    Maintained   ", FG, reg), ("license MIT, has releases, linked source", DIM, reg)]),
    ("warn", [("    Provenance   ", FG, reg), ("142 stars, 6 open issues", DIM, reg)]),
    ("ok", [("    MCP fit      ", FG, reg), ("declares itself an MCP server", DIM, reg)]),
    (None, [("", FG, reg)]),
    (None, [("  SCORE 88/100 \u00b7 HEALTHY", OK, bold)]),
]


def draw_mark(d, y, kind):
    """Draw a crisp check / bang / cross as a shape at the mark column."""
    x = MARK_X
    cy = y + SIZE / 2 + 1
    if kind == "ok":
        d.line([(x, cy), (x + 4, cy + 4), (x + 11, cy - 6)], fill=OK, width=2, joint="curve")
    elif kind == "warn":
        d.line([(x + 5, y + 3), (x + 5, y + SIZE - 4)], fill=WARN, width=2)
        d.ellipse([x + 4, y + SIZE - 1, x + 6, y + SIZE + 1], fill=WARN)
    elif kind == "bad":
        d.line([(x, cy - 5), (x + 10, cy + 5)], fill=BAD, width=2)
        d.line([(x, cy + 5), (x + 10, cy - 5)], fill=BAD, width=2)

CONTENT_TOP = BAR_H + 18
H = CONTENT_TOP + LINE_H * (len(OUT) + 3) + 10


def new_frame():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # title bar
    d.rectangle([0, 0, W, BAR_H], fill=BAR)
    d.line([0, BAR_H, W, BAR_H], fill=RULE)
    for i, col in enumerate(DOTS):
        cx = PAD + i * 20
        cy = BAR_H // 2
        d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=col)
    d.text((PAD + 74, BAR_H // 2 - SIZE // 2 - 1), "scepter", font=reg, fill=DIM)
    return img, d


def draw_segments(d, y, segments):
    x = PAD
    for text, color, font in segments:
        if text:
            d.text((x, y), text, font=font, fill=color)
            x += font.getlength(text)


def draw_cmd(d, typed, cursor=True):
    y = CONTENT_TOP
    d.text((PAD, y), "$ ", font=reg, fill=BRASS)
    x = PAD + reg.getlength("$ ")
    d.text((x, y), typed, font=reg, fill=FG)
    if cursor:
        cx = x + reg.getlength(typed)
        d.rectangle([cx, y + 2, cx + CH_W - 2, y + SIZE + 3], fill=BRASS)


frames = []
durations = []


def add(img, ms):
    frames.append(img.convert("P", palette=Image.ADAPTIVE, colors=64))
    durations.append(ms)


# Phase 1: type the command
for i in range(0, len(CMD) + 1, 2):
    img, d = new_frame()
    draw_cmd(d, CMD[:i], cursor=True)
    add(img, 55)
# small hold with cursor
img, d = new_frame()
draw_cmd(d, CMD, cursor=True)
add(img, 500)

def render_output(d, count):
    y = CONTENT_TOP + LINE_H * 2
    for mark, segs in OUT[:count]:
        if mark:
            draw_mark(d, y, mark)
        draw_segments(d, y, segs)
        y += LINE_H


# Phase 2: reveal output lines progressively
for n in range(1, len(OUT) + 1):
    img, d = new_frame()
    draw_cmd(d, CMD, cursor=False)
    render_output(d, n)
    add(img, 150)

# Phase 3: long hold on the finished frame
img, d = new_frame()
draw_cmd(d, CMD, cursor=False)
render_output(d, len(OUT))
add(img, 2600)

out = Path(__file__).resolve().parent.parent / "assets" / "demo.gif"
out.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(frames)} frames, {W}x{H})")
