#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「照片水印 / Photo Watermark」PWA 应用图标。

设计要点（全部参数以画布边长的比例表示，便于多尺寸复用同一构图）：
  - 深色对角渐变背景 #0b1220 -> #1a2740
  - 浅色圆角相片卡片 #e8eef7，居中略微左上偏移
  - 卡片右下区域 3 条 -35° 半透明深色条纹，代表叠加的水印
  - 4x 超采样绘制后 LANCZOS 缩小，保证抗锯齿
"""

import math
import os

import numpy as np
from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "icons"))

SS = 4  # 超采样倍数

# ---- 调色板 ---------------------------------------------------------------
BG_TL = (11, 18, 32)      # #0b1220 渐变起点（左上）
BG_BR = (26, 39, 64)      # #1a2740 渐变终点（右下）
CARD = (232, 238, 247)    # #e8eef7 相片卡片
STRIPE = (9, 15, 26)      # #090f1a 水印条纹
STRIPE_ALPHA = 0.34       # 条纹不透明度
FAV_BASE = (2, 5, 10)     # #02050a favicon 四角底色（不透明，略暗于渐变起点以显出圆角）

# ---- 构图参数 -------------------------------------------------------------
CORNER_R = 0.22           # 圆角方块圆角半径 / 画布
CARD_R = 0.16             # 卡片圆角半径 / min(卡片宽, 卡片高)

STRIPE_ANGLE = -35.0      # 条纹角度（屏幕坐标，y 向下）
STRIPE_HALF_LEN = 0.290   # 条纹半长 / 卡片宽
STRIPE_HALF_W = 0.034     # 条纹半宽 / 卡片宽
STRIPE_GAP = 0.054        # 相邻条纹间隙 / 卡片宽
STRIPE_COUNT = 3
STRIPE_CX = 0.110         # 条纹组中心相对卡片中心的偏移 / 卡片宽
STRIPE_CY = 0.100         # 同上 / 卡片高

# 每种模式：卡片尺寸与中心偏移（画布比例）
CFG = {
    # 常规 icon：圆角背景、透明四角
    "icon": {"card_w": 0.540, "card_h": 0.460, "off_x": -0.010, "off_y": -0.010},
    # maskable：背景铺满，内容收进中心 80% 直径安全圆
    "maskable": {"card_w": 0.540, "card_h": 0.460, "off_x": 0.000, "off_y": 0.000},
    # apple-touch：铺满无透明，构图同常规 icon
    "apple": {"card_w": 0.540, "card_h": 0.460, "off_x": -0.010, "off_y": -0.010},
}

# favicon 极简版：相框轮廓
FAV_FRAME_W = 0.640
FAV_FRAME_H = 0.580
FAV_FRAME_R = 0.110
FAV_STROKE = 0.072
FAV_OFF_X = -0.008
FAV_OFF_Y = -0.008


def hex_rgb(c):
    return c


def diagonal_gradient(size, c0, c1):
    """左上 -> 右下的线性渐变。"""
    lin = np.linspace(0.0, 1.0, size, dtype=np.float32)
    t = (lin[None, :] + lin[:, None]) * 0.5
    t = t[:, :, None]
    a = np.asarray(c0, dtype=np.float32)
    b = np.asarray(c1, dtype=np.float32)
    arr = a + (b - a) * t
    return Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8), "RGB")


def rounded_mask(size, box, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def stripe_shape_mask(size, cx, cy, cw, ch):
    """画出 3 条 -35° 圆头条纹，返回 L 模式覆盖图。"""
    half_len = STRIPE_HALF_LEN * cw
    half_w = STRIPE_HALF_W * cw
    gap = STRIPE_GAP * cw
    pitch = 2 * half_w + gap

    ang = math.radians(STRIPE_ANGLE)
    ux, uy = math.cos(ang), math.sin(ang)
    nx, ny = -uy, ux

    sx = cx + STRIPE_CX * cw
    sy = cy + STRIPE_CY * ch

    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)

    offset = (STRIPE_COUNT - 1) / 2.0
    for k in range(STRIPE_COUNT):
        t = (k - offset) * pitch
        px = sx + nx * t
        py = sy + ny * t
        quad = [
            (px - ux * half_len - nx * half_w, py - uy * half_len - ny * half_w),
            (px + ux * half_len - nx * half_w, py + uy * half_len - ny * half_w),
            (px + ux * half_len + nx * half_w, py + uy * half_len + ny * half_w),
            (px - ux * half_len + nx * half_w, py - uy * half_len + ny * half_w),
        ]
        d.polygon(quad, fill=255)
        for s in (-1, 1):
            ex = px + ux * half_len * s
            ey = py + uy * half_len * s
            d.ellipse([ex - half_w, ey - half_w, ex + half_w, ey + half_w], fill=255)
    return m, half_w, pitch, sx, sy


def render_photo_card(size, cw, ch, cx, cy):
    """渲染一张带水印条纹的相片卡片，返回 RGBA 图层。"""
    box = [cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2]
    card_mask = rounded_mask(size, box, CARD_R * min(cw, ch))

    card = Image.new("RGBA", (size, size), CARD + (0,))
    card.putalpha(card_mask)

    shape, _, _, _, _ = stripe_shape_mask(size, cx, cy, cw, ch)
    shape = ImageChops.multiply(shape, card_mask)
    stripe = Image.new("RGBA", (size, size), STRIPE + (0,))
    stripe.putalpha(ImageChops.multiply(shape, Image.new("L", (size, size), int(round(255 * STRIPE_ALPHA)))))
    card.alpha_composite(stripe)
    return card


def render_icon(size, mode):
    S = size * SS
    bg = diagonal_gradient(S, BG_TL, BG_BR).convert("RGBA")

    if mode == "icon":
        canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        canvas.paste(bg, (0, 0), rounded_mask(S, [0, 0, S - 1, S - 1], CORNER_R * S))
    elif mode in ("maskable", "apple"):
        canvas = bg.copy()
    else:
        raise ValueError(mode)

    c = CFG[mode]
    cw, ch = c["card_w"] * S, c["card_h"] * S
    cx = (0.5 + c["off_x"]) * S
    cy = (0.5 + c["off_y"]) * S
    canvas.alpha_composite(render_photo_card(S, cw, ch, cx, cy))

    out = canvas.resize((size, size), Image.LANCZOS)
    if mode == "icon":
        return out.convert("RGBA")
    return out.convert("RGB")


def render_favicon(size):
    S = size * SS
    bg = diagonal_gradient(S, BG_TL, BG_BR).convert("RGBA")

    canvas = Image.new("RGBA", (S, S), FAV_BASE + (255,))
    canvas.paste(bg, (0, 0), rounded_mask(S, [0, 0, S - 1, S - 1], CORNER_R * S))

    fw, fh = FAV_FRAME_W * S, FAV_FRAME_H * S
    cx = (0.5 + FAV_OFF_X) * S
    cy = (0.5 + FAV_OFF_Y) * S
    outer_box = [cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2]
    t = FAV_STROKE * S
    inner_box = [outer_box[0] + t, outer_box[1] + t, outer_box[2] - t, outer_box[3] - t]

    outer = rounded_mask(S, outer_box, FAV_FRAME_R * S)
    inner = rounded_mask(S, inner_box, max(1.0, (FAV_FRAME_R - FAV_STROKE * 0.8) * S))
    frame = ImageChops.subtract(outer, inner)

    frame_layer = Image.new("RGBA", (S, S), CARD + (0,))
    frame_layer.putalpha(frame)
    canvas.alpha_composite(frame_layer)

    return canvas.resize((size, size), Image.LANCZOS).convert("RGB")


TARGETS = [
    ("icon-192.png", 192, "icon"),
    ("icon-512.png", 512, "icon"),
    ("icon-maskable-192.png", 192, "maskable"),
    ("icon-maskable-512.png", 512, "maskable"),
    ("apple-touch-icon-180.png", 180, "apple"),
    ("favicon-32.png", 32, "favicon"),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size, mode in TARGETS:
        img = render_favicon(size) if mode == "favicon" else render_icon(size, mode)
        path = os.path.join(OUT_DIR, name)
        img.save(path, "PNG", optimize=True)
        print(f"{name:26s} {img.size[0]}x{img.size[1]}  {img.mode}  {os.path.getsize(path):6d} B  -> {path}")


if __name__ == "__main__":
    main()
