'use strict';

/**
 * test-zip.js —— 真实生成 ZIP、真实解压、逐字节比对
 *
 * 流程：
 *   1. 用 createZipBytes 生成 tests/out/test.zip（含中文名、随机二进制、空文件等）
 *   2. 独立解析 EOCD / central directory / local header，校验 offset、size、CRC
 *   3. 用 Windows 自带 Expand-Archive 真实解压；失败时改用 Python zipfile 并如实报告
 *   4. 逐个文件比较 SHA-256 与字节内容，并检查中文文件名无乱码
 *   5. 再用 Python zipfile 交叉验证 CRC、UTF-8 标志和内容
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const ZipBuilder = require('../js/zip.js');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const ZIP_PATH = path.join(OUT, 'test.zip');
const EXPECTED_DIR = path.join(OUT, 'expected');
const UNZIP_DIR = path.join(OUT, 'unzipped');

let passCount = 0;

function check(label, condition, detail) {
  if (!condition) {
    throw new Error('断言失败：' + label + (detail ? '（' + detail + '）' : ''));
  }
  passCount++;
  console.log('  PASS  ' + label + (detail ? '  [' + detail + ']' : ''));
}

function need(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
}

function assertThrows(label, fn, pattern) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  if (!error) throw new Error('断言失败：' + label + '，预期抛异常但没有抛出');
  const message = String(error && error.message);
  if (pattern && !pattern.test(message)) {
    throw new Error('断言失败：' + label + '，异常信息不符合预期：' + message);
  }
  check(label, true, message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function crc32Ref(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  // 旧版 Node 没有 zlib.crc32 时，用逐位算法独立计算
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 独立解析 ZIP 结构，校验 EOCD 中 central directory 的 offset/size 与每个条目。 */
function inspectZip(bytes, label) {
  need(bytes.length >= 22, label + ' 长度不足 22 字节');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);

  let eocd = -1;
  const minOffset = Math.max(0, bytes.length - 22 - 0xFFFF);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (u32(i) === 0x06054B50 && i + 22 + u16(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  check(label + '：EOCD 签名可定位', eocd >= 0, 'offset=' + eocd);
  need(u16(eocd + 4) === 0 && u16(eocd + 6) === 0, label + ' 磁盘号字段非 0');

  const countOnDisk = u16(eocd + 8);
  const totalCount = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  check(label + '：EOCD 条目数一致', countOnDisk === totalCount,
    countOnDisk + ' / ' + totalCount);
  check(label + '：central directory 的 offset + size 等于 EOCD 起点',
    centralOffset + centralSize === eocd,
    centralOffset + ' + ' + centralSize + ' = ' + eocd);

  const entries = [];
  let pos = centralOffset;
  for (let i = 0; i < totalCount; i++) {
    need(pos + 46 <= bytes.length, label + ' central directory 越界');
    need(u32(pos) === 0x02014B50, label + ' central directory 签名错误');

    const flags = u16(pos + 8);
    const method = u16(pos + 10);
    const crc = u32(pos + 16);
    const compressedSize = u32(pos + 20);
    const uncompressedSize = u32(pos + 24);
    const nameLength = u16(pos + 28);
    const extraLength = u16(pos + 30);
    const commentLength = u16(pos + 32);
    const localOffset = u32(pos + 42);
    const nameBytes = bytes.slice(pos + 46, pos + 46 + nameLength);
    const name = Buffer.from(nameBytes).toString('utf8');

    need((flags & 0x0800) !== 0, label + ' 条目未设置 UTF-8 标志：' + name);
    need(method === 0, label + ' 条目不是 STORE：' + name);
    need(compressedSize === uncompressedSize, label + ' 条目压缩前后大小不一致：' + name);

    need(localOffset + 30 <= bytes.length, label + ' local header 越界：' + name);
    need(u32(localOffset) === 0x04034B50, label + ' local header 签名错误：' + name);
    const localFlags = u16(localOffset + 6);
    const localMethod = u16(localOffset + 8);
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    need((localFlags & 0x0800) !== 0, label + ' local header 未设置 UTF-8 标志：' + name);
    need(localMethod === 0, label + ' local header 不是 STORE：' + name);
    need(localNameLength === nameLength, label + ' 两处文件名长度不一致：' + name);
    const localName = bytes.slice(localOffset + 30, localOffset + 30 + localNameLength);
    need(Buffer.compare(Buffer.from(localName), Buffer.from(nameBytes)) === 0,
      label + ' 两处文件名不一致：' + name);

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + uncompressedSize);
    need(data.length === uncompressedSize, label + ' 条目数据越界：' + name);
    need(crc32Ref(data) === crc, label + ' CRC32 不匹配：' + name +
      '（头部 0x' + crc.toString(16) + '，实际 0x' + crc32Ref(data).toString(16) + '）');

    check(label + '：条目结构/CRC 正确：' + name, true,
      'flags=0x' + flags.toString(16) + ', offset=' + localOffset + ', ' +
      uncompressedSize + 'B');
    entries.push({
      name: name,
      flags: flags,
      method: method,
      crc: crc,
      size: uncompressedSize,
      localOffset: localOffset,
      data: data
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  need(pos === centralOffset + centralSize,
    label + ' central directory 实际长度与 EOCD 记录不一致');

  return {
    eocdOffset: eocd,
    centralOffset: centralOffset,
    centralSize: centralSize,
    entries: entries
  };
}

function walkFiles(dir, prefix) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(full, relative));
    } else {
      result.push(relative);
    }
  }
  return result;
}

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push('python');
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes',
      'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'));
  }
  for (const command of candidates) {
    const result = spawnSync(command, ['-c', 'from PIL import Image'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.status === 0) return command;
  }
  return null;
}

function tryExpandArchive(zipPath, destination) {
  const escape = (value) => value.replace(/'/g, "''");
  const command = "Expand-Archive -LiteralPath '" + escape(zipPath) +
    "' -DestinationPath '" + escape(destination) + "' -Force";
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    windowsHide: true
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(EXPECTED_DIR, { recursive: true, force: true });
  fs.rmSync(UNZIP_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXPECTED_DIR, { recursive: true });

  console.log('[环境] Node ' + process.version + '，zlib.crc32=' +
    (typeof zlib.crc32 === 'function' ? '可用' : '不可用，使用逐位算法'));

  // 准备输入：JPEG 风格二进制、随机二进制、空文件、中文字符串、嵌套中文路径
  const jpegData = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    crypto.randomBytes(4096),
    Buffer.from([0xFF, 0xD9])
  ]);
  const randomArrayBuffer = new Uint8Array(crypto.randomBytes(4096)).buffer;
  const emptyData = new Uint8Array(0);
  const textData = '第一行：中文内容测试。\n第二行：文件名与内容都应按 UTF-8 编码。\n';
  const nestedData = '嵌套目录里的中文文件。\n';
  const crcCheckData = '123456789';

  const entries = [
    { name: '测试图片.jpg', data: jpegData },
    { name: 'random.bin', data: randomArrayBuffer },
    { name: 'empty.bin', data: emptyData },
    { name: '说明.txt', data: textData },
    { name: '子目录/嵌套说明.txt', data: nestedData },
    { name: 'crc-check.txt', data: crcCheckData }
  ];

  const expectedMap = new Map(entries.map((entry) => [
    entry.name,
    typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
  ]));

  console.log('\n[1] 生成 ZIP 并检查结构');
  const bytes = ZipBuilder.createZipBytes(entries);
  fs.writeFileSync(ZIP_PATH, bytes);
  check('test.zip 已生成', fs.statSync(ZIP_PATH).size === bytes.length,
    ZIP_PATH + '，' + bytes.length + 'B');

  const info = inspectZip(bytes, 'ZIP');
  check('条目数与输入一致', info.entries.length === entries.length,
    info.entries.length + ' 个');
  check('文件名与输入顺序完全一致、无乱码',
    JSON.stringify(info.entries.map((e) => e.name)) ===
    JSON.stringify(entries.map((e) => e.name)),
    info.entries.map((e) => e.name).join(' | '));

  for (const entry of entries) {
    const zipped = info.entries.find((item) => item.name === entry.name);
    check('ZIP 中内容与输入逐字节一致：' + entry.name,
      Boolean(zipped) &&
      Buffer.compare(Buffer.from(zipped.data), expectedMap.get(entry.name)) === 0,
      expectedMap.get(entry.name).length + 'B');
  }

  const crcEntry = info.entries.find((item) => item.name === 'crc-check.txt');
  check('CRC32 与标准测试值一致（"123456789" -> 0xCBF43926）',
    Boolean(crcEntry) && crcEntry.crc === 0xCBF43926,
    crcEntry ? '0x' + crcEntry.crc.toString(16).toUpperCase() : '缺失');

  console.log('\n[2] createZip 返回 Blob');
  const blob = ZipBuilder.createZip(entries);
  check('Blob 的 MIME 为 application/zip', blob.type === 'application/zip', blob.type);
  check('Blob 大小等于 createZipBytes 输出', blob.size === bytes.length,
    blob.size + 'B');
  const blobBytes = new Uint8Array(await blob.arrayBuffer());
  check('Blob 内容与 createZipBytes 输出完全一致',
    Buffer.compare(Buffer.from(blobBytes), Buffer.from(bytes)) === 0);

  console.log('\n[3] 空 entries 输出合法空 ZIP');
  const emptyZip = ZipBuilder.createZipBytes([]);
  check('空 ZIP 长度为 22 字节（仅 EOCD）', emptyZip.length === 22,
    emptyZip.length + 'B');
  const emptyInfo = inspectZip(emptyZip, '空 ZIP');
  check('空 ZIP 条目数为 0', emptyInfo.entries.length === 0);
  check('空 ZIP 的 central directory offset/size 均为 0',
    emptyInfo.centralOffset === 0 && emptyInfo.centralSize === 0);

  console.log('\n[4] 参数校验');
  assertThrows('entries 不是数组时报错', () => ZipBuilder.createZipBytes(null), /必须是数组/);
  assertThrows('文件名为空时报错', () => ZipBuilder.createZipBytes([
    { name: '', data: new Uint8Array(0) }
  ]), /非空字符串/);
  assertThrows('data 类型非法时报错', () => ZipBuilder.createZipBytes([
    { name: 'a.txt', data: 123 }
  ]), /data 必须是/);
  assertThrows('目录条目（以 / 结尾）明确报错', () => ZipBuilder.createZipBytes([
    { name: '目录/', data: new Uint8Array(0) }
  ]), /不支持目录条目/);

  console.log('\n[5] Windows Expand-Archive 真实解压');
  const python = findPython();
  if (!python) {
    throw new Error('找不到可用的 Python + Pillow，无法执行后续交叉验证');
  }
  console.log('  使用 Python：' + python);

  let extractionMethod = 'Windows PowerShell Expand-Archive';
  const psResult = tryExpandArchive(ZIP_PATH, UNZIP_DIR);
  const psOk = !psResult.error && psResult.status === 0;
  if (!psOk) {
    console.warn('  [WARN] Expand-Archive 失败（' + (psResult.error
      ? psResult.error.message
      : '退出码 ' + psResult.status) + '），改用 Python zipfile 解压');
    fs.rmSync(UNZIP_DIR, { recursive: true, force: true });
    const pyExtract = spawnSync(python, [path.join(HERE, 'extract_zip.py'),
      ZIP_PATH, UNZIP_DIR], { stdio: 'inherit', windowsHide: true });
    if (pyExtract.error || pyExtract.status !== 0) {
      throw new Error('Expand-Archive 与 Python zipfile 解压均失败');
    }
    extractionMethod = 'Python zipfile（Expand-Archive 失败后回退）';
  } else {
    check('Expand-Archive 解压命令执行成功', true, '退出码 0');
  }

  // 写一份期望文件，用于和“真实解压结果”比较
  for (const entry of entries) {
    const target = path.join(EXPECTED_DIR, ...entry.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expectedMap.get(entry.name));
  }

  const extractedFiles = walkFiles(UNZIP_DIR).sort();
  const expectedNames = entries.map((entry) => entry.name).sort();
  check('解压后的文件集合与 ZIP 条目完全一致（含中文路径）',
    JSON.stringify(extractedFiles) === JSON.stringify(expectedNames),
    extractedFiles.join(' | '));

  for (const entry of entries) {
    const extractedPath = path.join(UNZIP_DIR, ...entry.name.split('/'));
    need(fs.existsSync(extractedPath), '解压结果缺少文件：' + entry.name);
    const actual = fs.readFileSync(extractedPath);
    const expected = expectedMap.get(entry.name);
    const actualHash = sha256(actual);
    const expectedHash = sha256(expected);
    check('解压后逐字节一致（SHA-256）：' + entry.name,
      actual.length === expected.length && actualHash === expectedHash,
      expected.length + 'B, ' + actualHash.slice(0, 16) + '…');
  }

  check('中文文件名无乱码：测试图片.jpg', extractedFiles.includes('测试图片.jpg'));
  const emptyStat = fs.statSync(path.join(UNZIP_DIR, 'empty.bin'));
  check('空文件解压后仍是 0 字节', emptyStat.size === 0, emptyStat.size + 'B');

  console.log('\n[6] Python zipfile 交叉验证');
  const verifyResult = spawnSync(python, [path.join(HERE, 'verify_zip.py'),
    ZIP_PATH, EXPECTED_DIR], { stdio: 'inherit', windowsHide: true });
  if (verifyResult.error) throw new Error('无法启动 Python：' + verifyResult.error.message);
  check('Python zipfile 交叉验证通过', verifyResult.status === 0,
    '退出码 ' + verifyResult.status);

  console.log('\n[结果] ZIP 测试全部通过：' + passCount + ' 项断言/验证');
  console.log('[方式] 解压：' + extractionMethod + '；交叉验证：Python zipfile');
  console.log('[产物] ' + ZIP_PATH + '（' + bytes.length + ' 字节）');
}

main().catch((err) => {
  console.error('\n[FAIL] ' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
