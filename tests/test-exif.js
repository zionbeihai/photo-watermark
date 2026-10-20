'use strict';

/**
 * test-exif.js —— 真实运行 EXIF 工具测试
 *
 * 依赖 tests/fixtures/ 中由 make_fixtures.py 生成的样本图：
 *   sample-orient6.jpg     Pillow 写入 Orientation=6（大端 MM）
 *   sample-normal.jpg      无 EXIF
 *   sample-orient6-le.jpg  手工小端 II EXIF，Orientation=6
 *   sample-orient6-be.jpg  手工大端 MM EXIF，Orientation=6
 *
 * 输出文件写入 tests/out/，最后调用 Pillow 独立验证 JPEG 可打开、尺寸和像素不变。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ExifTool = require('../js/exif.js');

const HERE = __dirname;
const FIXTURES = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out');

let passCount = 0;

function ok(name, detail) {
  passCount++;
  console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : ''));
}

function assertTrue(name, value, detail) {
  if (!value) {
    throw new Error('断言失败：' + name + (detail ? '（' + detail + '）' : ''));
  }
  ok(name, detail);
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error('断言失败：' + name + '，期望 ' + String(expected) +
      '，实际 ' + String(actual));
  }
  ok(name, String(actual));
}

function assertThrows(name, fn, pattern) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  if (!error) throw new Error('断言失败：' + name + '，预期抛异常但没有抛出');
  const message = String(error && error.message);
  if (pattern && !pattern.test(message)) {
    throw new Error('断言失败：' + name + '，异常信息不符合预期：' + message);
  }
  ok(name, message);
}

function readFixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

function byteOrderOf(app1) {
  return String.fromCharCode(app1[6], app1[7]);
}

function hasExifHeader(bytes, offset) {
  return bytes[offset] === 0x45 && bytes[offset + 1] === 0x78 &&
    bytes[offset + 2] === 0x69 && bytes[offset + 3] === 0x66 &&
    bytes[offset + 4] === 0x00 && bytes[offset + 5] === 0x00;
}

/** 测试自带的 JPEG 头部段扫描器，用于独立检查模块输出。 */
function listHeaderSegments(bytes) {
  const list = [];
  let pos = 2;
  while (pos + 2 <= bytes.length) {
    if (bytes[pos] !== 0xFF) {
      throw new Error('测试解析器：偏移 ' + pos + ' 处不是 0xFF');
    }
    const marker = bytes[pos + 1];
    if (marker === 0xD9 || marker === 0xDA) {
      list.push({ marker: marker, start: pos, payloadStart: pos + 2, end: pos + 2 });
      return list;
    }
    if (marker === 0xFF) {
      pos += 1;
      continue;
    }
    if (pos + 4 > bytes.length) {
      throw new Error('测试解析器：段长度字段越界');
    }
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    list.push({ marker: marker, start: pos, payloadStart: pos + 4, end: pos + 2 + length });
    pos = pos + 2 + length;
  }
  throw new Error('测试解析器：没有找到 SOS/EOI');
}

function isExifSegment(bytes, segment) {
  return segment.marker === 0xE1 && hasExifHeader(bytes, segment.payloadStart);
}

function countExifSegments(bytes) {
  return listHeaderSegments(bytes).filter((s) => isExifSegment(bytes, s)).length;
}

/** 返回 SOS/EOI 标记的位置，用于比较熵编码数据是否被原样保留。 */
function findStopOffset(bytes) {
  const segments = listHeaderSegments(bytes);
  return segments[segments.length - 1].start;
}

function writeOut(name, bytes) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function writeU16(buf, offset, value, little) {
  if (little) buf.writeUInt16LE(value, offset);
  else buf.writeUInt16BE(value, offset);
}

function writeU32(buf, offset, value, little) {
  if (little) buf.writeUInt32LE(value, offset);
  else buf.writeUInt32BE(value, offset);
}

/** 写一个只含 Orientation 的 IFD（18 字节：count + entry + next）。 */
function writeIfd(buf, offset, orientation, next, little) {
  writeU16(buf, offset, 1, little);
  writeU16(buf, offset + 2, 0x0112, little);
  writeU16(buf, offset + 4, 3, little);       // SHORT
  writeU32(buf, offset + 6, 1, little);
  writeU16(buf, offset + 10, orientation, little);
  writeU16(buf, offset + 12, 0, little);      // 值字段补齐
  writeU32(buf, offset + 14, next, little);
}

/** 构造 IFD0 + IFD1 都带 Orientation 的最小 EXIF，用来覆盖 IFD1 同步逻辑。 */
function buildExifWithIfd1(little, orientation0, orientation1) {
  const tiff = Buffer.alloc(8 + 18 + 18);
  tiff.write(little ? 'II' : 'MM', 0, 'ascii');
  writeU16(tiff, 2, 42, little);
  writeU32(tiff, 4, 8, little);
  writeIfd(tiff, 8, orientation0, 26, little);
  writeIfd(tiff, 26, orientation1, 0, little);
  return new Uint8Array(Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]));
}

/** 构造没有 Orientation 标签的合法空 IFD0。 */
function buildExifWithoutOrientation() {
  const tiff = Buffer.alloc(14);
  tiff.write('MM', 0, 'ascii');
  writeU16(tiff, 2, 42, false);
  writeU32(tiff, 4, 8, false);
  writeU16(tiff, 8, 0, false);
  writeU32(tiff, 10, 0, false);
  return new Uint8Array(Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]));
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

function pillowVerify(python, file, width, height, orientation, compare) {
  const args = [path.join(HERE, 'verify_jpeg.py'), file, String(width), String(height),
    String(orientation)];
  if (compare) args.push(compare);
  const result = spawnSync(python, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error('无法启动 Python：' + result.error.message);
  if (result.status !== 0) {
    throw new Error('Pillow 验证失败（退出码 ' + result.status + '）：' + path.basename(file));
  }
  passCount++;
  console.log('  PASS  Pillow 验证：' + path.basename(file));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const orient6 = readFixture('sample-orient6.jpg');
  const normal = readFixture('sample-normal.jpg');
  const le = readFixture('sample-orient6-le.jpg');
  const be = readFixture('sample-orient6-be.jpg');

  console.log('[环境] Node ' + process.version);
  console.log('[样本] sample-orient6.jpg=' + orient6.length + 'B, sample-normal.jpg=' +
    normal.length + 'B, sample-orient6-le.jpg=' + le.length + 'B, sample-orient6-be.jpg=' +
    be.length + 'B');

  console.log('\n[1] EXIF 提取与 Orientation 读取');
  const app1 = ExifTool.extractExifApp1(orient6);
  assertTrue('extractExifApp1 返回 Uint8Array', app1 instanceof Uint8Array,
    app1 ? app1.length + ' 字节' : 'null');
  assertTrue('APP1 以 "Exif\\0\\0" 开头', hasExifHeader(app1, 0));
  assertEqual('sample-orient6 的 EXIF 字节序（Pillow）', byteOrderOf(app1), 'MM');
  assertEqual('readOrientation(sample-orient6 EXIF)', ExifTool.readOrientation(app1), 6);
  assertEqual('readJpegOrientation(sample-orient6)', ExifTool.readJpegOrientation(orient6), 6);

  const app1FromArrayBuffer = ExifTool.extractExifApp1(orient6.buffer);
  assertEqual('extractExifApp1 接受 ArrayBuffer', app1FromArrayBuffer.length, app1.length);
  assertEqual('readJpegOrientation 接受 ArrayBuffer',
    ExifTool.readJpegOrientation(orient6.buffer), 6);

  assertEqual('sample-normal 无 EXIF（extract 返回 null）',
    ExifTool.extractExifApp1(normal), null);
  assertEqual('readJpegOrientation(sample-normal) 默认为 1',
    ExifTool.readJpegOrientation(normal), 1);

  const leApp1 = ExifTool.extractExifApp1(le);
  const beApp1 = ExifTool.extractExifApp1(be);
  assertEqual('手工样本 LE 的字节序', byteOrderOf(leApp1), 'II');
  assertEqual('手工样本 BE 的字节序', byteOrderOf(beApp1), 'MM');
  assertEqual('小端 II 读取 Orientation', ExifTool.readJpegOrientation(le), 6);
  assertEqual('大端 MM 读取 Orientation', ExifTool.readJpegOrientation(be), 6);

  const orders = new Set([byteOrderOf(app1), byteOrderOf(leApp1), byteOrderOf(beApp1)]);
  assertTrue('大小端两种字节序均已覆盖', orders.has('MM') && orders.has('II'),
    Array.from(orders).join(','));

  console.log('\n[2] setOrientation');
  const originalSnapshot = Buffer.from(app1);
  const modified = ExifTool.setOrientation(app1, 1);
  assertTrue('返回新的 Uint8Array 且不是同一对象', modified !== app1,
    modified.length + ' 字节');
  assertTrue('未修改传入的 APP1 数组',
    Buffer.compare(Buffer.from(app1), originalSnapshot) === 0);
  assertEqual('修改后 readOrientation 返回 1', ExifTool.readOrientation(modified), 1);
  assertEqual('原 APP1 的 Orientation 仍为 6', ExifTool.readOrientation(app1), 6);

  const modifiedLE = ExifTool.setOrientation(leApp1, 1);
  assertEqual('小端 II 写入后读取为 1', ExifTool.readOrientation(modifiedLE), 1);
  assertEqual('小端 II 原数组仍为 6', ExifTool.readOrientation(leApp1), 6);

  const modifiedBE = ExifTool.setOrientation(beApp1, 1);
  assertEqual('大端 MM 写入后读取为 1', ExifTool.readOrientation(modifiedBE), 1);
  assertEqual('大端 MM 原数组仍为 6', ExifTool.readOrientation(beApp1), 6);

  const modifiedFromArrayBuffer = ExifTool.setOrientation(app1.buffer, 1);
  assertEqual('setOrientation 接受 ArrayBuffer',
    ExifTool.readOrientation(modifiedFromArrayBuffer), 1);

  assertEqual('缺少 Orientation 标签时 readOrientation 返回 1',
    ExifTool.readOrientation(buildExifWithoutOrientation()), 1);

  const ifd1Exif = buildExifWithIfd1(true, 6, 6);
  assertEqual('IFD1 测试样本 IFD0=6', ExifTool.readOrientation(ifd1Exif), 6);
  const ifd1Before = Buffer.from(ifd1Exif);
  const ifd1Changed = ExifTool.setOrientation(ifd1Exif, 8);
  assertEqual('IFD0 写入 8', ExifTool.readOrientation(ifd1Changed), 8);
  const ifd1View = new DataView(ifd1Changed.buffer, ifd1Changed.byteOffset,
    ifd1Changed.byteLength);
  assertEqual('IFD1 中的 Orientation 同步为 8', ifd1View.getUint16(42, true), 8);
  const ifd1OriginalView = new DataView(ifd1Exif.buffer, ifd1Exif.byteOffset,
    ifd1Exif.byteLength);
  assertEqual('IFD1 原数组未被修改', ifd1OriginalView.getUint16(42, true), 6);
  assertTrue('IFD1 测试样本原数组逐字节未变',
    Buffer.compare(Buffer.from(ifd1Exif), ifd1Before) === 0);

  assertThrows('拒绝 0', () => ExifTool.setOrientation(app1, 0), /1~8/);
  assertThrows('拒绝 9', () => ExifTool.setOrientation(app1, 9), /1~8/);
  assertThrows('拒绝小数', () => ExifTool.setOrientation(app1, 1.5), /1~8/);
  assertThrows('拒绝字符串', () => ExifTool.setOrientation(app1, '1'), /1~8/);
  assertThrows('没有 Orientation 标签时明确报错',
    () => ExifTool.setOrientation(buildExifWithoutOrientation(), 1), /不存在 Orientation/);
  assertThrows('损坏的 TIFF 魔数明确报错', () => {
    const broken = new Uint8Array(app1);
    broken[9] = 0x00; // TIFF 头位于 APP1 偏移 6，魔数位于 8~9（MM 为 00 2A）
    ExifTool.readOrientation(broken);
  }, /魔数/);

  console.log('\n[3] spliceExifIntoJpeg');
  const splicedMM = ExifTool.spliceExifIntoJpeg(normal, modified);
  assertEqual('插入后 readJpegOrientation 返回 1',
    ExifTool.readJpegOrientation(splicedMM), 1);
  assertEqual('输出长度 = 原图 + EXIF 段（标记 2 + 长度 2 + 负载）',
    splicedMM.length, normal.length + modified.length + 4);

  const normalSegments = listHeaderSegments(normal);
  assertEqual('原图第一个段是 APP0(JFIF)', normalSegments[0].marker, 0xE0);
  const splicedSegments = listHeaderSegments(splicedMM);
  assertEqual('插入后第一个段仍是 APP0', splicedSegments[0].marker, 0xE0);
  assertTrue('EXIF 插在 APP0 之后', splicedSegments[1].marker === 0xE1 &&
    hasExifHeader(splicedMM, splicedSegments[1].payloadStart));
  assertEqual('输出中只有一个 EXIF APP1', countExifSegments(splicedMM), 1);
  assertTrue('SOS 之后的熵编码数据逐字节未变',
    Buffer.compare(Buffer.from(normal.subarray(findStopOffset(normal))),
      Buffer.from(splicedMM.subarray(findStopOffset(splicedMM)))) === 0);

  const splicedLE = ExifTool.spliceExifIntoJpeg(normal, modifiedLE);
  assertEqual('小端 EXIF 插入后读取为 1', ExifTool.readJpegOrientation(splicedLE), 1);
  assertEqual('小端插入后只有一个 EXIF APP1', countExifSegments(splicedLE), 1);

  const splicedFromArrayBuffer = ExifTool.spliceExifIntoJpeg(normal.buffer, modified.buffer);
  assertEqual('spliceExifIntoJpeg 接受 ArrayBuffer 参数',
    ExifTool.readJpegOrientation(splicedFromArrayBuffer), 1);

  const replaced = ExifTool.spliceExifIntoJpeg(orient6, modified);
  assertEqual('对已有 EXIF 的图重新插入后读取为 1',
    ExifTool.readJpegOrientation(replaced), 1);
  assertEqual('旧 EXIF 被移除，输出中只有一个 EXIF APP1', countExifSegments(replaced), 1);
  assertEqual('替换后文件长度不变（新旧 EXIF 等长）', replaced.length, orient6.length);
  assertTrue('替换后熵编码数据逐字节未变',
    Buffer.compare(Buffer.from(orient6.subarray(findStopOffset(orient6))),
      Buffer.from(replaced.subarray(findStopOffset(replaced)))) === 0);

  const tiny = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
  const splicedTiny = ExifTool.spliceExifIntoJpeg(tiny, modified);
  assertEqual('SOI 后没有 APP0 时紧随 SOI 插入（读取方向）',
    ExifTool.readJpegOrientation(splicedTiny), 1);
  const tinySegments = listHeaderSegments(splicedTiny);
  assertTrue('最小 JPEG 中 EXIF 是 SOI 之后的第一个段',
    tinySegments[0].marker === 0xE1 && hasExifHeader(splicedTiny, tinySegments[0].payloadStart));

  const fileMM = writeOut('exif-spliced-mm.jpg', splicedMM);
  const fileLE = writeOut('exif-spliced-le.jpg', splicedLE);
  const fileReplaced = writeOut('exif-replaced.jpg', replaced);
  console.log('  写出：' + [fileMM, fileLE, fileReplaced]
    .map((f) => path.basename(f)).join(', '));

  console.log('\n[4] 防御性错误处理');
  assertThrows('非 JPEG 输入 extractExifApp1 报错',
    () => ExifTool.extractExifApp1(new Uint8Array([0x01, 0x02, 0x03, 0x04])), /JPEG/);
  assertThrows('非 JPEG 输入 spliceExifIntoJpeg 报错',
    () => ExifTool.spliceExifIntoJpeg(new Uint8Array([0x00, 0x00, 0x00, 0x00]), modified),
    /JPEG/);
  assertThrows('段长度越界的 JPEG 报错', () => ExifTool.extractExifApp1(
    new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x64, 0x00])), /超出|越界/);
  assertThrows('段长度为 1 的 JPEG 报错', () => ExifTool.extractExifApp1(
    new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01, 0x00, 0xFF, 0xD9])), /长度为 1/);
  assertThrows('非 EXIF 负载不能插入',
    () => ExifTool.spliceExifIntoJpeg(normal, new Uint8Array([1, 2, 3, 4])), /Exif/);

  console.log('\n[5] Pillow 独立验证（打开、尺寸、方向、像素）');
  const python = findPython();
  if (!python) {
    throw new Error('找不到可用的 Python + Pillow。请设置 PYTHON 环境变量指向带 Pillow 的解释器。');
  }
  console.log('  使用 Python：' + python);
  pillowVerify(python, path.join(FIXTURES, 'sample-orient6.jpg'), 200, 120, 6);
  pillowVerify(python, fileMM, 200, 120, 1, path.join(FIXTURES, 'sample-normal.jpg'));
  pillowVerify(python, fileLE, 200, 120, 1, path.join(FIXTURES, 'sample-normal.jpg'));
  pillowVerify(python, fileReplaced, 200, 120, 1, path.join(FIXTURES, 'sample-orient6.jpg'));

  console.log('\n[结果] EXIF 测试全部通过：' + passCount + ' 项断言/验证');
}

try {
  main();
} catch (err) {
  console.error('\n[FAIL] ' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  process.exitCode = 1;
}
