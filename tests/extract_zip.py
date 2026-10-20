# -*- coding: utf-8 -*-
"""
Expand-Archive 失败时的备用解压（Python zipfile）。

用法：
    python tests/extract_zip.py <zip> <目标目录>
"""
import sys
import zipfile


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    zip_path, destination = sys.argv[1], sys.argv[2]
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(destination)
        print("[Python] 已解压 %d 个条目到 %s" % (len(zf.infolist()), destination))
    return 0


if __name__ == "__main__":
    sys.exit(main())
