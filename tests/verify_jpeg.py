# -*- coding: utf-8 -*-
"""
用 Pillow 独立验证 JPEG 输出：能否打开、尺寸、EXIF Orientation、像素是否与参照一致。

用法：
    python tests/verify_jpeg.py <文件> <宽> <高> <orientation|any> [参照文件]
"""
import hashlib
import sys

from PIL import Image


def fail(message):
    print("[FAIL] " + message)
    return 1


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        return 2

    path = sys.argv[1]
    width = int(sys.argv[2])
    height = int(sys.argv[3])
    expected_orientation = sys.argv[4]
    compare = sys.argv[5] if len(sys.argv) > 5 else None

    try:
        with Image.open(path) as im:
            im.load()
            actual_format = im.format
            actual_size = im.size
            actual_orientation = im.getexif().get(0x0112)
            pixels = im.convert("RGB").tobytes()
    except Exception as exc:  # noqa: BLE001 - 测试脚本需要如实报告任何打开失败
        return fail("%s Pillow 无法打开：%s" % (path, exc))

    if actual_format != "JPEG":
        return fail("%s 格式不是 JPEG：%r" % (path, actual_format))
    if actual_size != (width, height):
        return fail("%s 尺寸应为 %dx%d，实际为 %r" % (path, width, height, actual_size))
    if expected_orientation != "any":
        if actual_orientation != int(expected_orientation):
            return fail("%s Orientation 应为 %s，实际为 %r" %
                        (path, expected_orientation, actual_orientation))

    digest = hashlib.sha256(pixels).hexdigest()[:16]
    compare_info = ""
    if compare:
        try:
            with Image.open(compare) as ref:
                ref.load()
                ref_pixels = ref.convert("RGB").tobytes()
        except Exception as exc:  # noqa: BLE001
            return fail("参照图 %s 无法打开：%s" % (compare, exc))
        if pixels != ref_pixels:
            return fail("%s 解码后的像素与参照图 %s 不一致" % (path, compare))
        compare_info = "，像素与 %s 完全一致" % compare

    print("[OK] %s：JPEG %dx%d，orientation=%r，像素 sha256=%s…%s" % (
        path, actual_size[0], actual_size[1], actual_orientation, digest, compare_info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
