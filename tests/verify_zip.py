# -*- coding: utf-8 -*-
"""
用 Python 标准库 zipfile 交叉验证 ZIP：UTF-8 标志、CRC、文件名解码、内容。

用法：
    python tests/verify_zip.py tests/out/test.zip tests/out/expected
"""
import os
import sys
import zipfile


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    zip_path, expected_dir = sys.argv[1], sys.argv[2]
    failures = 0

    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        print("[Python] 读取 %s，条目数 %d" % (zip_path, len(infos)))

        bad = zf.testzip()
        if bad is not None:
            print("[FAIL] CRC 校验失败，首个损坏条目：%r" % bad)
            return 1
        print("[Python] testzip() 已校验所有条目 CRC，全部通过")

        for info in infos:
            data = zf.read(info)
            target = os.path.join(expected_dir, *info.filename.split("/"))
            try:
                with open(target, "rb") as handle:
                    raw = handle.read()
            except OSError as exc:
                print("[FAIL] 读取期望文件失败：%s（%s）" % (target, exc))
                failures += 1
                continue

            utf8_flag = bool(info.flag_bits & 0x0800)
            stored = info.compress_type == zipfile.ZIP_STORED
            same = data == raw
            print("[Python] %-24s size=%-5d crc=%08X utf8=%s store=%s 内容一致=%s" % (
                info.filename, info.file_size, info.CRC, utf8_flag, stored, same))
            if not utf8_flag:
                print("[FAIL] 条目未设置 UTF-8 标志位：%r" % info.filename)
                failures += 1
            if not stored:
                print("[FAIL] 条目不是 STORE：%r" % info.filename)
                failures += 1
            if not same:
                print("[FAIL] 内容不一致：%r" % info.filename)
                failures += 1

    if failures:
        print("[FAIL] Python 交叉验证失败：%d 处问题" % failures)
        return 1
    print("[Python] 交叉验证通过：文件名（含中文）、CRC、STORE 方式、内容全部正确")
    return 0


if __name__ == "__main__":
    sys.exit(main())
