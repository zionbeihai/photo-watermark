# -*- coding: utf-8 -*-
"""验证浏览器实际导出的 ZIP 是否可解压、内部 JPEG 是否带水印、重名是否已去重。

由浏览器端到端测试（ego/Playwright）产出 tests/out/browser-export.zip。
本脚本用 Python 标准库 + Pillow 做独立交叉验证，不依赖被测代码本身。
"""
import os
import sys
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ZIP_PATH = os.path.join(HERE, "out", "browser-export.zip")
OUT_DIR = os.path.join(HERE, "out", "unzipped-browser")

# 输入里有 2 张同名 "重复名.jpg"，导出后第二个应被改成 "重复名-watermark-2.jpg"
EXPECTED = {
    "照片A-watermark.jpg": (900, 600),
    "照片B-watermark.jpg": (700, 900),
    "照片C-watermark.jpg": (640, 480),
    "重复名-watermark.jpg": (500, 500),
    "重复名-watermark-2.jpg": (520, 520),
}


def bright_ratio(img, x_from=0.55, y_from=0.78, step=3):
    px = img.convert("RGB")
    w, h = px.size
    cnt = tot = 0
    for y in range(int(h * y_from), h, step):
        for x in range(int(w * x_from), w, step):
            r, g, b = px.getpixel((x, y))
            tot += 1
            if r > 200 and g > 200 and b > 200:
                cnt += 1
    return cnt / tot if tot else 0.0


def main():
    if not os.path.exists(ZIP_PATH):
        print("FAIL: 找不到 %s" % ZIP_PATH)
        return 1

    zf = zipfile.ZipFile(ZIP_PATH)
    bad = zf.testzip()
    infos = zf.infolist()
    names = [i.filename for i in infos]

    print("ZIP 大小: %d 字节，条目数: %d" % (os.path.getsize(ZIP_PATH), len(names)))
    print("CRC 校验:", "全部通过" if bad is None else "损坏 -> " + str(bad))
    print("条目名唯一:", "是" if len(set(names)) == len(names) else "否 -> " + str(names))
    for n in names:
        print("  -", n)

    os.makedirs(OUT_DIR, exist_ok=True)
    zf.extractall(OUT_DIR)
    zf.close()

    failures = []
    if bad is not None:
        failures.append("ZIP CRC 校验失败")
    if len(set(names)) != len(names):
        failures.append("ZIP 中有重名条目（会互相覆盖）")
    if set(names) != set(EXPECTED):
        failures.append("条目名不符，实际=%s 期望=%s" % (sorted(names), sorted(EXPECTED)))

    print()
    for name, (ew, eh) in EXPECTED.items():
        p = os.path.join(OUT_DIR, name)
        if not os.path.exists(p):
            failures.append("缺少文件 %s" % name)
            continue
        with Image.open(p) as im:
            im.load()
            w, h = im.size
            ratio = bright_ratio(im)
        ok_size = (w, h) == (ew, eh)
        ok_wm = ratio > 0.01
        print("%s: %dx%d %s | 右下角白色像素=%.4f %s"
              % (name, w, h, "尺寸正确" if ok_size else "尺寸错误(期望 %dx%d)" % (ew, eh),
                 ratio, "→ 有水印" if ok_wm else "→ !! 未检测到水印"))
        if not ok_size:
            failures.append("%s 尺寸错误 %dx%d" % (name, w, h))
        if not ok_wm:
            failures.append("%s 右下角未检测到水印" % name)

    print()
    if failures:
        print("FAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("ALL OK: 浏览器导出的 ZIP 可解压、条目名唯一、5 张 JPEG 尺寸正确且均带水印")
    return 0


if __name__ == "__main__":
    sys.exit(main())
