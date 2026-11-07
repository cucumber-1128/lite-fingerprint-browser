"""生成应用图标（Pillow）。改设计后跑一次：python scripts/gen-icons.py"""

import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src-tauri", "icons")
S = 1024
BG = (14, 17, 22, 255)
LINE = (38, 45, 56, 255)
GREEN = (63, 185, 80, 255)
GREEN_DIM = (35, 110, 55, 255)


def arc(draw, cx, cy, r, start, end, width, color):
    box = [cx - r, cy - r, cx + r, cy + r]
    draw.arc(box, start=start, end=end, fill=color, width=width)


def render() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底板
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=BG, outline=LINE, width=6)

    cx, cy = S // 2, int(S * 0.54)
    # 上半圈同心弧，越靠外越淡
    rings = [
        (400, 26, GREEN_DIM),
        (330, 30, GREEN),
        (260, 34, GREEN),
        (190, 38, GREEN),
        (120, 40, GREEN),
    ]
    for r, w, color in rings:
        arc(d, cx, cy, r, 200, 340, w, color)

    # 下面对称收口的两段，做出"指纹"的闭环感
    for r, w in ((400, 26), (330, 30)):
        arc(d, cx, cy, r, 25, 155, w, GREEN_DIM if r == 400 else GREEN)

    # 底部一条"设备"横线，别让图标太抽象
    d.rounded_rectangle(
        [int(S * 0.30), int(S * 0.84), int(S * 0.70), int(S * 0.86) + 10],
        radius=5,
        fill=GREEN_DIM,
    )
    return img


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    base = render()
    base.save(os.path.join(OUT, "icon.png"))
    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon-512.png": 512,
    }
    for name, size in sizes.items():
        base.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    base.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icons ->", OUT)


if __name__ == "__main__":
    main()
