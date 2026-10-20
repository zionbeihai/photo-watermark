/**
 * exif.js —— 零依赖的 JPEG EXIF APP1 读写工具
 *
 * 用途：canvas.toBlob() 导出的 JPEG 会丢失 EXIF，这里负责把原图的 EXIF APP1
 * 原样取出，并在导出后重新插入新 JPEG 的头部。
 *
 * 本文件只处理 JPEG 的“段”和 EXIF APP1 中的 TIFF 结构，不解析、不修改图像像素。
 * 浏览器中暴露为 window.ExifTool，Node 中可通过 require 使用。
 *
 * 所有公开方法的参数都可以是 ArrayBuffer 或 Uint8Array。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ExifTool = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var APP1_MARKER = 0xE1;          // APP1 段标记
  var TAG_ORIENTATION = 0x0112;    // Orientation 标签号
  var TYPE_SHORT = 3;              // EXIF 中 Orientation 的标准类型
  var TYPE_LONG = 4;               // 少数实现会写成 LONG，这里一并兼容
  var EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

  /** 抛出带中文说明的错误，避免调用方拿到难以定位的问题。 */
  function fail(message) {
    throw new Error(message);
  }

  /**
   * 把 ArrayBuffer / Uint8Array（含 Node Buffer、DataView 等视图）统一成 Uint8Array。
   * 注意：返回的可能是原对象本身，公共方法内部不会修改它。
   */
  function toBytes(input, apiName) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    fail(apiName + ': 参数必须是 ArrayBuffer 或 Uint8Array');
  }

  /** 判断是否为 JPEG（只需要检查 SOI 标记）。 */
  function isJpeg(bytes) {
    return bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
  }

  /**
   * 解析 JPEG 的头部段表，直到 SOS(FFDA) 或 EOI(FFD9) 为止。
   *
   * JPEG 中 SOS 之后是熵编码数据，不能继续按“0xFFxx + 长度”解析，所以必须在这里停住。
   * 返回 { segments, stopOffset }：
   *   segments[i] = { marker, start, payloadStart, end }，start/end 为源数组下标，end 不含；
   *   stopOffset 为 SOS/EOI 标记（含其前面的填充 0xFF）在源数组中的起点。
   */
  function parseJpegSegments(bytes) {
    var len = bytes.length;
    if (len < 4) fail('JPEG 解析失败：文件长度不足 4 字节');
    if (!isJpeg(bytes)) fail('JPEG 解析失败：缺少 SOI(FFD8) 起始标记');

    var segments = [];
    var pos = 2;

    while (true) {
      if (pos >= len) fail('JPEG 解析失败：偏移 ' + pos + ' 处意外结束（缺少 SOS 或 EOI）');

      var markerStart = pos;
      if (bytes[pos] !== 0xFF) {
        fail('JPEG 解析失败：偏移 ' + pos + ' 处应为 0xFF 标记，实际为 0x' + bytes[pos].toString(16));
      }
      // JPEG 允许在标记前出现连续的 0xFF 填充字节
      while (pos < len && bytes[pos] === 0xFF) pos++;
      if (pos >= len) fail('JPEG 解析失败：偏移 ' + markerStart + ' 处只有 0xFF 填充，缺少标记字节');

      var marker = bytes[pos];
      pos++; // 此时 pos 指向段长度字段（若该标记有长度）

      // EOI：文件结束，停止解析
      if (marker === 0xD9) {
        return { segments: segments, stopOffset: markerStart };
      }
      // SOS：之后是熵编码数据，停止解析
      if (marker === 0xDA) {
        return { segments: segments, stopOffset: markerStart };
      }
      // TEM 与 RSTn 没有长度字段；正常 JPEG 头部不应出现 RSTn，但跳过是安全的
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        continue;
      }
      if (marker === 0x00) {
        fail('JPEG 解析失败：偏移 ' + markerStart + ' 处出现 0x00，不是合法标记');
      }
      if (marker === 0xD8) {
        fail('JPEG 解析失败：头部出现重复的 SOI 标记');
      }

      // 其余段都有 2 字节大端长度字段，长度包含这 2 个字节本身
      if (pos + 2 > len) {
        fail('JPEG 解析失败：偏移 ' + pos + ' 处的段长度字段越界');
      }
      var segmentLength = (bytes[pos] << 8) | bytes[pos + 1];
      if (segmentLength < 2) {
        fail('JPEG 解析失败：偏移 ' + markerStart + ' 处的段长度为 ' +
          segmentLength + '（合法值必须 >= 2）');
      }
      var segmentEnd = pos + segmentLength;
      if (segmentEnd > len) {
        fail('JPEG 解析失败：偏移 ' + markerStart + ' 处的段（长度 ' + segmentLength +
          '）超出文件末尾');
      }

      segments.push({
        marker: marker,
        start: markerStart,
        payloadStart: pos + 2,
        end: segmentEnd
      });
      pos = segmentEnd;
    }
  }

  /** 判断某个段是否为 EXIF APP1（要求负载以 "Exif\0\0" 开头）。 */
  function isExifApp1(bytes, segment) {
    if (segment.marker !== APP1_MARKER) return false;
    if (segment.end - segment.payloadStart < 6) return false;
    for (var i = 0; i < 6; i++) {
      if (bytes[segment.payloadStart + i] !== EXIF_HEADER[i]) return false;
    }
    return true;
  }

  /**
   * 解析 EXIF APP1 的 TIFF 头，返回带字节序的读取上下文。
   * 这里同时校验 "Exif\0\0"、II/MM 字节序、TIFF 魔数 42 和 IFD0 偏移范围。
   */
  function parseTiff(exifBytes, apiName) {
    var bytes = exifBytes;
    var len = bytes.length;
    if (len < 14) {
      fail(apiName + ': EXIF APP1 内容过短（至少需要 14 字节：6 字节 Exif 头 + 8 字节 TIFF 头）');
    }
    for (var i = 0; i < 6; i++) {
      if (bytes[i] !== EXIF_HEADER[i]) {
        fail(apiName + ': EXIF APP1 内容不以 "Exif\\0\\0" 开头');
      }
    }

    var base = 6; // TIFF 头在 EXIF APP1 中的起始位置
    var byteOrder = (bytes[base] << 8) | bytes[base + 1];
    var little;
    if (byteOrder === 0x4949) {
      little = true;  // "II"
    } else if (byteOrder === 0x4D4D) {
      little = false; // "MM"
    } else {
      fail(apiName + ': 未知的 TIFF 字节序标记 0x' + byteOrder.toString(16) +
        '（只支持 II 或 MM）');
    }

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    function check(offset, size, what) {
      if (offset < base || offset + size > len) {
        fail(apiName + ': TIFF ' + what + ' 越界（相对 TIFF 头偏移 ' +
          (offset - base) + '，长度 ' + size + '）');
      }
    }
    function u16(offset) {
      check(offset, 2, '读取 UInt16');
      return view.getUint16(offset, little);
    }
    function u32(offset) {
      check(offset, 4, '读取 UInt32');
      return view.getUint32(offset, little);
    }

    if (u16(base + 2) !== 42) {
      fail(apiName + ': TIFF 魔数不是 42，数据可能不是合法 EXIF');
    }
    var ifd0Relative = u32(base + 4);
    if (ifd0Relative < 8) {
      fail(apiName + ': IFD0 偏移非法（' + ifd0Relative + '，必须 >= 8）');
    }

    return {
      bytes: bytes,
      little: little,
      base: base,
      length: len,
      u16: u16,
      u32: u32,
      ifd0Relative: ifd0Relative
    };
  }

  /** 读取一个 IFD 的头部信息（条目数、条目区、下一个 IFD 的相对偏移）。 */
  function readIfd(ctx, relativeOffset, apiName, label) {
    if (relativeOffset < 8) {
      fail(apiName + ': ' + label + ' 偏移非法（' + relativeOffset + '，必须 >= 8）');
    }
    var absolute = ctx.base + relativeOffset;
    if (absolute + 2 > ctx.length) {
      fail(apiName + ': ' + label + ' 起始位置越界');
    }
    var count = ctx.u16(absolute);
    var entriesStart = absolute + 2;
    var entriesEnd = entriesStart + count * 12;
    if (count > 4096) {
      fail(apiName + ': ' + label + ' 条目数量异常（' + count + '），拒绝继续解析');
    }
    if (entriesEnd + 4 > ctx.length) {
      fail(apiName + ': ' + label + ' 的条目区越界（条目数 ' + count + '）');
    }
    return {
      count: count,
      entriesStart: entriesStart,
      entriesEnd: entriesEnd,
      nextRelative: ctx.u32(entriesEnd)
    };
  }

  /**
   * 在 IFD 中查找 Orientation 条目。
   * 返回值形如 { entry: 条目绝对偏移, type, value }；找不到返回 null。
   */
  function findOrientationEntry(ctx, ifd, apiName) {
    for (var i = 0; i < ifd.count; i++) {
      var entry = ifd.entriesStart + i * 12;
      if (ctx.u16(entry) !== TAG_ORIENTATION) continue;

      var type = ctx.u16(entry + 2);
      var count = ctx.u32(entry + 4);
      if (count < 1) {
        fail(apiName + ': Orientation 标签的 count 为 0，数据不合法');
      }
      if (type === TYPE_SHORT) {
        return { entry: entry, type: type, value: ctx.u16(entry + 8) };
      }
      if (type === TYPE_LONG) {
        return { entry: entry, type: type, value: ctx.u32(entry + 8) };
      }
      fail(apiName + ': Orientation 标签类型不受支持（type=' + type + '，只支持 SHORT/LONG）');
    }
    return null;
  }

  /** 把 value 写入已有的 Orientation 条目，保持原有类型。 */
  function writeOrientationValue(ctx, entry, value, apiName) {
    var view = new DataView(ctx.bytes.buffer, ctx.bytes.byteOffset, ctx.bytes.byteLength);
    if (entry.type === TYPE_SHORT) {
      view.setUint16(entry.entry + 8, value, ctx.little);
    } else if (entry.type === TYPE_LONG) {
      view.setUint32(entry.entry + 8, value, ctx.little);
    } else {
      fail(apiName + ': 无法写入未知类型的 Orientation 标签');
    }
  }

  /**
   * 取出 JPEG 中的 EXIF APP1 段内容（从 "Exif\0\0" 开始，不含 FFE1 和长度字段）。
   * 没有 EXIF 时返回 null；不是 JPEG 或结构损坏时抛出中文错误。
   */
  function extractExifApp1(jpegBytes) {
    var bytes = toBytes(jpegBytes, 'extractExifApp1');
    var parsed = parseJpegSegments(bytes);
    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      if (isExifApp1(bytes, segment)) {
        // slice 返回副本，调用方后续修改不会影响原图
        return bytes.slice(segment.payloadStart, segment.end);
      }
    }
    return null;
  }

  /**
   * 读取 EXIF APP1 中 IFD0 的 Orientation（tag 0x0112）。
   * 返回 1~8；没有该标签或值不在 1~8 时返回 1（按“不旋转”处理）。
   */
  function readOrientation(exifApp1) {
    var bytes = toBytes(exifApp1, 'readOrientation');
    var ctx = parseTiff(bytes, 'readOrientation');
    var ifd0 = readIfd(ctx, ctx.ifd0Relative, 'readOrientation', 'IFD0');
    var entry = findOrientationEntry(ctx, ifd0, 'readOrientation');
    if (!entry) return 1;
    if (!(entry.value >= 1 && entry.value <= 8)) return 1;
    return entry.value;
  }

  /**
   * 返回一个新的 Uint8Array，把 IFD0 的 Orientation 写成 value。
   * IFD1（缩略图 IFD）里如果也存在 0x0112，会一并同步。
   *
   * 约束：
   * - 不修改传入的数组（内部先做显式拷贝）；
   * - IFD0 必须已经存在 Orientation 标签，否则抛出明确错误（本工具不做条目插入）。
   */
  function setOrientation(exifApp1, value) {
    var source = toBytes(exifApp1, 'setOrientation');
    if (typeof value !== 'number' || !isFinite(value) ||
        Math.floor(value) !== value || value < 1 || value > 8) {
      fail('setOrientation: orientation 必须是 1~8 的整数');
    }

    // 先校验源数据，再复制，确保出错时不会留下“改了一半”的结果
    parseTiff(source, 'setOrientation');
    var result = new Uint8Array(source);
    var ctx = parseTiff(result, 'setOrientation');
    var ifd0 = readIfd(ctx, ctx.ifd0Relative, 'setOrientation', 'IFD0');
    var entry = findOrientationEntry(ctx, ifd0, 'setOrientation');
    if (!entry) {
      fail('setOrientation: IFD0 中不存在 Orientation(0x0112) 标签，无法修改');
    }
    writeOrientationValue(ctx, entry, value, 'setOrientation');

    // 同步 IFD1 及后续 IFD（通常只有 IFD1 存缩略图信息）
    var next = ifd0.nextRelative;
    var visited = {};
    var steps = 0;
    while (next !== 0) {
      if (visited[next]) fail('setOrientation: TIFF IFD 链存在循环引用，已中止');
      visited[next] = true;
      steps++;
      if (steps > 16) fail('setOrientation: TIFF IFD 链过长，已中止');
      var ifd = readIfd(ctx, next, 'setOrientation', 'IFD1/后续 IFD');
      var other = findOrientationEntry(ctx, ifd, 'setOrientation');
      if (other) writeOrientationValue(ctx, other, value, 'setOrientation');
      next = ifd.nextRelative;
    }

    // 自检：写入结果必须能被重新读出，否则不返回疑似损坏的数据
    if (readOrientation(result) !== value) {
      fail('setOrientation: 写入后校验失败（内部错误）');
    }
    return result;
  }

  /** 构造完整的 APP1 段：FFE1 + 2 字节大端长度 + EXIF 负载。 */
  function buildApp1Segment(exifBytes) {
    var ctx = parseTiff(exifBytes, 'spliceExifIntoJpeg');
    // 至少校验 IFD0 能正常读取，避免把结构损坏的 EXIF 塞进新图
    readIfd(ctx, ctx.ifd0Relative, 'spliceExifIntoJpeg', 'IFD0');

    var segmentLength = exifBytes.length + 2;
    if (segmentLength > 0xFFFF) {
      fail('spliceExifIntoJpeg: EXIF 数据过大（' + exifBytes.length +
        ' 字节），APP1 段长度上限为 65533 字节');
    }
    var segment = new Uint8Array(exifBytes.length + 4);
    segment[0] = 0xFF;
    segment[1] = APP1_MARKER;
    segment[2] = (segmentLength >> 8) & 0xFF;
    segment[3] = segmentLength & 0xFF;
    segment.set(exifBytes, 4);
    return segment;
  }

  /** 依次拼接多个 Uint8Array，避免使用大数组展开导致栈溢出。 */
  function concatChunks(chunks) {
    var total = 0;
    var i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  /**
   * 把 exifApp1 插入到一个新的 JPEG 中，返回完整 JPEG。
   *
   * 插入位置：
   * - 如果 SOI 后的第一个段是 APP0(JFIF)，插在 APP0 之后；
   * - 否则紧随 SOI。
   * 新 JPEG 中已有的 EXIF APP1 会先被移除（XMP 等其它 APP1 保留）。
   * SOS 之后的熵编码数据原样复制，不做任何改动。
   */
  function spliceExifIntoJpeg(jpegBytes, exifApp1) {
    var jpeg = toBytes(jpegBytes, 'spliceExifIntoJpeg');
    var exif = toBytes(exifApp1, 'spliceExifIntoJpeg');
    var parsed = parseJpegSegments(jpeg);
    var app1Segment = buildApp1Segment(exif);

    var chunks = [];
    var cursor = 2;
    chunks.push(jpeg.subarray(0, 2)); // SOI

    var first = parsed.segments.length > 0 ? parsed.segments[0] : null;
    if (first && first.marker === 0xE0) {
      // 保留 SOI 到 APP0 末尾的全部字节（包括可能的填充），然后插入 APP1
      chunks.push(jpeg.subarray(2, first.end));
      cursor = first.end;
    }
    chunks.push(app1Segment);

    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      if (segment.end <= cursor) continue; // 已经复制过（APP0）
      if (segment.start > cursor) {
        chunks.push(jpeg.subarray(cursor, segment.start)); // 保留段间填充字节
      }
      if (!isExifApp1(jpeg, segment)) {
        chunks.push(jpeg.subarray(segment.start, segment.end));
      }
      cursor = segment.end;
    }

    // 从 SOS/EOI 开始到文件末尾（含熵编码数据）原样保留
    chunks.push(jpeg.subarray(cursor));
    return concatChunks(chunks);
  }

  /** 便捷方法：直接读取一张 JPEG 的 Orientation，没有 EXIF 时返回 1。 */
  function readJpegOrientation(jpegBytes) {
    var exif = extractExifApp1(jpegBytes);
    if (!exif) return 1;
    return readOrientation(exif);
  }

  var api = {
    extractExifApp1: extractExifApp1,
    readOrientation: readOrientation,
    setOrientation: setOrientation,
    spliceExifIntoJpeg: spliceExifIntoJpeg,
    readJpegOrientation: readJpegOrientation
  };
  return api;
});
