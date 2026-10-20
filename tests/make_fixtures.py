# -*- coding: utf-8 -*-
"""
生成 EXIF 测试样本（需要 Pillow）。

用法：
    python tests/make_fixtures.py

产物（保留在 tests/fixtures/）：
    sample-orient6.jpg      Pillow 写入 EXIF Orientation=6（当前 Pillow 为大端 MM）
    sample-normal.jpg       普通 JPEG，无 EXIF
    sample-orient6-le.jpg   手工构造的小端 II 最小 TIFF，Orientation=6

另外生成 sample-orient6-be.jpg（手工大端），便于不依赖 Pillow 字节序策略。
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

WIDTH, HEIGHT = 200, 120


def make_pattern():
    """画一张方向明显的图：四色块 + 黑边框 + TOP/箭头标记。"""
    img = Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    draw.rectangle([0, 0, 99, 59], fill=(220, 40, 40))       # 左上：红
    draw.rectangle([100, 0, 199, 59], fill=(40, 160, 70))    # 右上：绿
    draw.rectangle([0, 60, 99, 119], fill=(40, 80, 200))     # 左下：蓝
    draw.rectangle([100, 60, 199, 119], fill=(240, 200, 40)) # 右下：黄

    draw.rectangle([0, 0, WIDTH - 1, HEIGHT - 1], outline=(0, 0, 0), width=4)
    draw.line([0, 0, WIDTH - 1, HEIGHT - 1], fill=(0, 0, 0), width=3)
    draw.line([WIDTH - 1, 0, 0, HEIGHT - 1], fill=(0, 0, 0), width=3)

    font = None
    for candidate in (
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(candidate):
            try:
                font = ImageFont.truetype(candidate, 30)
                break
            except OSError:
                pass
    if font is None:
        font = ImageFont.load_default()

    draw.text((58, 36), "TOP", fill=(0, 0, 0), font=font)
    draw.line([100, 8, 100, 28], fill=(0, 0, 0), width=4)
    draw.polygon([(100, 4), (92, 16), (108, 16)], fill=(0, 0, 0))
    return img


def build_minimal_tiff_exif(little, orientation):
    """构造只含 IFD0 一个 Orientation 条目的最小 TIFF，并加上 Exif 头。"""
    p16 = "<H" if little else ">H"
    p32 = "<I" if little else ">I"
    header = (b"II" if little else b"MM") + struct.pack(p16, 42) + struct.pack(p32, 8)
    ifd0 = (
        struct.pack(p16, 1)                    # 条目数
        + struct.pack(p16, 0x0112)             # tag：Orientation
        + struct.pack(p16, 3)                  # type：SHORT
        + struct.pack(p32, 1)                  # count：1
        + struct.pack(p16, orientation)        # value
        + b"\x00\x00"                          # 值字段补齐到 4 字节
        + struct.pack(p32, 0)                  # 下一个 IFD 偏移：0
    )
    return b"Exif\x00\x00" + header + ifd0


def build_app1(tiff_payload):
    length = len(tiff_payload) + 2
    if length > 0xFFFF:
        raise ValueError("EXIF 过大")
    return b"\xff\xe1" + struct.pack(">H", length) + tiff_payload


def insert_after_app0(jpeg, app1_segment):
    """把 APP1 插到 JPEG 的 APP0(JFIF) 之后；没有 APP0 则紧随 SOI。"""
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("不是 JPEG")
    if jpeg[2:4] == b"\xff\xe0":
        seg_len = struct.unpack(">H", jpeg[4:6])[0]
        end = 4 + seg_len
        return jpeg[:end] + app1_segment + jpeg[end:]
    return jpeg[:2] + app1_segment + jpeg[2:]


def find_exif_app1(jpeg):
    """简单扫描 JPEG 头部，返回 APP1 Exif 负载（含 Exif 头）。"""
    pos = 2
    while pos + 4 <= len(jpeg):
        if jpeg[pos] != 0xFF:
            raise ValueError("JPEG 段结构异常")
        marker = jpeg[pos + 1]
        if marker == 0xD9 or marker == 0xDA:
            return None
        if marker == 0xFF:
            pos += 1
            continue
        seg_len = struct.unpack(">H", jpeg[pos + 2:pos + 4])[0]
        if seg_len < 2:
            raise ValueError("段长度非法")
        payload_start = pos + 4
        payload_end = pos + 2 + seg_len
        if marker == 0xE1 and jpeg[payload_start:payload_start + 6] == b"Exif\x00\x00":
            return jpeg[payload_start:payload_end]
        pos = payload_end
    return None


def exif_byte_order(app1):
    return app1[6:8].decode("ascii")


def verify(path, expected_orientation):
    with Image.open(path) as im:
        im.load()
        if im.size != (WIDTH, HEIGHT):
            raise AssertionError("%s 尺寸错误：%r" % (path, im.size))
        if im.format != "JPEG":
            raise AssertionError("%s 格式不是 JPEG：%r" % (path, im.format))
        orientation = im.getexif().get(0x0112)
    if expected_orientation is None:
        if orientation is not None:
            raise AssertionError("%s 不应包含 Orientation，实际为 %r" % (path, orientation))
    elif orientation != expected_orientation:
        raise AssertionError("%s Orientation 应为 %d，实际为 %r" %
                             (path, expected_orientation, orientation))
    with open(path, "rb") as f:
        raw = f.read()
    app1 = find_exif_app1(raw)
    print("  %-24s size=%d bytes  orientation=%r  exif=%s" % (
        os.path.basename(path), len(raw), orientation,
        ("%d bytes / %s" % (len(app1), exif_byte_order(app1))) if app1 else "无"))


def main():
    os.makedirs(FIXTURES, exist_ok=True)
    pattern = make_pattern()

    # 1) Pillow 生成带 Orientation=6 的 JPEG（Pillow 12 写大端 MM）
    exif = Image.Exif()
    exif[0x0112] = 6
    path_orient6 = os.path.join(FIXTURES, "sample-orient6.jpg")
    pattern.save(path_orient6, "JPEG", quality=92, exif=exif)

    # 2) 无 EXIF 的普通 JPEG
    path_normal = os.path.join(FIXTURES, "sample-normal.jpg")
    pattern.save(path_normal, "JPEG", quality=92)

    with open(path_normal, "rb") as f:
        normal_bytes = f.read()

    # 3) 手工构造的小端 II 最小 TIFF，插入到普通 JPEG 里
    le_app1 = build_minimal_tiff_exif(True, 6)
    path_le = os.path.join(FIXTURES, "sample-orient6-le.jpg")
    with open(path_le, "wb") as f:
        f.write(insert_after_app0(normal_bytes, build_app1(le_app1)))

    # 4) 手工构造的大端 MM 最小 TIFF，作为独立覆盖（不依赖 Pillow 行为）
    be_app1 = build_minimal_tiff_exif(False, 6)
    path_be = os.path.join(FIXTURES, "sample-orient6-be.jpg")
    with open(path_be, "wb") as f:
        f.write(insert_after_app0(normal_bytes, build_app1(be_app1)))

    print("生成完成：")
    verify(path_orient6, 6)
    verify(path_normal, None)
    verify(path_le, 6)
    verify(path_be, 6)

    # 额外确认：无 EXIF 样本里确实没有 APP1 Exif
    with open(path_normal, "rb") as f:
        raw = f.read()
    assert find_exif_app1(raw) is None, "sample-normal.jpg 不应有 EXIF APP1"
    print("全部样本校验通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
