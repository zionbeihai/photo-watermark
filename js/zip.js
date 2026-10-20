/**
 * zip.js —— 零依赖的 ZIP 打包工具（仅 STORE，不压缩）
 *
 * 浏览器里把多张照片打成一个 ZIP 下载，避免手机浏览器拦截连续多次下载。
 * 照片本身已经是 JPEG 压缩数据，再用 DEFLATE 压缩几乎不会变小，
 * 因此这里使用 STORE（压缩方法 0），实现简单、速度快、内存占用可控。
 *
 * 浏览器中暴露为 window.ZipBuilder，Node 中可通过 require 使用。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ZipBuilder = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var LOCAL_HEADER_SIZE = 30;
  var CENTRAL_HEADER_SIZE = 46;
  var EOCD_SIZE = 22;
  var UTF8_FLAG = 0x0800;        // 通用标志位 bit 11：文件名为 UTF-8
  var VERSION_NEEDED = 20;       // 2.0，支持 STORE 与 UTF-8 名称
  var DOS_TIME = 0x0000;         // 固定时间 00:00:00
  var DOS_DATE = 0x0021;         // 固定日期 1980-01-01（DOS 日期最小值）
  var MAX_UINT16 = 0xFFFF;
  var MAX_UINT32 = 0xFFFFFFFF;

  /** CRC32 查表（多项式 0xEDB88320，与 ZIP/PNG 使用的 CRC-32 一致）。 */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  /** 计算字节数组的 CRC32，返回无符号 32 位整数。 */
  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 手写 UTF-8 编码（不依赖 TextEncoder）。
   * 孤立代理项替换为 U+FFFD，避免生成非法 UTF-8 字节。
   */
  function utf8Encode(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
        } else {
          code = 0xFFFD;
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        code = 0xFFFD;
      }

      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code < 0x10000) {
        bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      } else {
        bytes.push(
          0xF0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3F),
          0x80 | ((code >> 6) & 0x3F),
          0x80 | (code & 0x3F)
        );
      }
    }
    return new Uint8Array(bytes);
  }

  /** 把字符串 / ArrayBuffer / Uint8Array（含其它 ArrayBuffer 视图）统一成字节数组。 */
  function toDataBytes(data, index) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === 'string') return utf8Encode(data);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError('createZip: entries[' + index +
      '].data 必须是 Uint8Array、ArrayBuffer 或字符串');
  }

  /** 规范化条目名：统一使用 "/" 分隔，去掉开头的 "/"，拒绝空名与目录条目。 */
  function normalizeName(name, index) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('createZip: entries[' + index + '].name 必须是非空字符串');
    }
    var normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.length === 0) {
      throw new TypeError('createZip: entries[' + index + '].name 规范化后为空');
    }
    if (normalized.charAt(normalized.length - 1) === '/') {
      throw new TypeError('createZip: 不支持目录条目（' + name + '），请直接列出文件');
    }
    return normalized;
  }

  /** 校验并整理输入条目，同时预计算名称字节、CRC 和大小。 */
  function prepareEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError('createZip: entries 必须是数组');
    }
    if (entries.length > MAX_UINT16) {
      throw new RangeError('createZip: 条目数量超过 ' + MAX_UINT16 + '，当前实现不支持 ZIP64');
    }

    var prepared = [];
    var localSize = 0;
    var centralSize = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry !== 'object') {
        throw new TypeError('createZip: entries[' + i + '] 必须是对象');
      }
      var name = normalizeName(entry.name, i);
      var nameBytes = utf8Encode(name);
      if (nameBytes.length > MAX_UINT16) {
        throw new RangeError('createZip: 文件名 UTF-8 长度超过 65535 字节');
      }
      var data = toDataBytes(entry.data, i);
      if (data.length > MAX_UINT32) {
        throw new RangeError('createZip: entries[' + i + '].data 超过 4GB，当前实现不支持 ZIP64');
      }
      localSize += LOCAL_HEADER_SIZE + nameBytes.length + data.length;
      centralSize += CENTRAL_HEADER_SIZE + nameBytes.length;
      prepared.push({
        nameBytes: nameBytes,
        data: data,
        crc: crc32(data),
        offset: 0
      });
    }

    if (localSize + centralSize + EOCD_SIZE > MAX_UINT32) {
      throw new RangeError('createZip: 总大小超过 4GB，当前实现不支持 ZIP64');
    }
    return {
      list: prepared,
      localSize: localSize,
      centralSize: centralSize,
      totalSize: localSize + centralSize + EOCD_SIZE
    };
  }

  /**
   * 生成 ZIP 字节，返回 Uint8Array。
   * entries: [{ name: string, data: Uint8Array | ArrayBuffer | string }]
   */
  function createZipBytes(entries) {
    var prepared = prepareEntries(entries);
    var list = prepared.list;
    var out = new Uint8Array(prepared.totalSize);
    var view = new DataView(out.buffer);

    function writeU16(offset, value) {
      view.setUint16(offset, value, true);
    }
    function writeU32(offset, value) {
      view.setUint32(offset, value, true);
    }

    // 第一遍：写 local file header + 文件数据
    var offset = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      item.offset = offset;
      writeU32(offset, 0x04034B50);              // local file header 签名
      writeU16(offset + 4, VERSION_NEEDED);      // 解压所需版本
      writeU16(offset + 6, UTF8_FLAG);           // 通用标志位：UTF-8 文件名
      writeU16(offset + 8, 0);                   // 压缩方法：STORE
      writeU16(offset + 10, DOS_TIME);           // 修改时间
      writeU16(offset + 12, DOS_DATE);           // 修改日期
      writeU32(offset + 14, item.crc);           // CRC32
      writeU32(offset + 18, item.data.length);   // 压缩后大小
      writeU32(offset + 22, item.data.length);   // 原始大小
      writeU16(offset + 26, item.nameBytes.length);
      writeU16(offset + 28, 0);                  // extra field 长度
      out.set(item.nameBytes, offset + LOCAL_HEADER_SIZE);
      out.set(item.data, offset + LOCAL_HEADER_SIZE + item.nameBytes.length);
      offset += LOCAL_HEADER_SIZE + item.nameBytes.length + item.data.length;
    }

    // 第二遍：写 central directory
    var centralOffset = offset;
    for (var j = 0; j < list.length; j++) {
      var file = list[j];
      writeU32(offset, 0x02014B50);              // central directory header 签名
      writeU16(offset + 4, VERSION_NEEDED);      // version made by（MS-DOS）
      writeU16(offset + 6, VERSION_NEEDED);      // version needed
      writeU16(offset + 8, UTF8_FLAG);           // 通用标志位
      writeU16(offset + 10, 0);                  // 压缩方法：STORE
      writeU16(offset + 12, DOS_TIME);
      writeU16(offset + 14, DOS_DATE);
      writeU32(offset + 16, file.crc);
      writeU32(offset + 20, file.data.length);
      writeU32(offset + 24, file.data.length);
      writeU16(offset + 28, file.nameBytes.length);
      writeU16(offset + 30, 0);                  // extra field 长度
      writeU16(offset + 32, 0);                  // 注释长度
      writeU16(offset + 34, 0);                  // 起始磁盘号
      writeU16(offset + 36, 0);                  // 内部属性
      writeU32(offset + 38, 0);                  // 外部属性
      writeU32(offset + 42, file.offset);        // 对应 local header 的偏移
      out.set(file.nameBytes, offset + CENTRAL_HEADER_SIZE);
      offset += CENTRAL_HEADER_SIZE + file.nameBytes.length;
    }
    var centralSize = offset - centralOffset;

    // 第三遍：写 EOCD（end of central directory）
    writeU32(offset, 0x06054B50);
    writeU16(offset + 4, 0);                     // 当前磁盘号
    writeU16(offset + 6, 0);                     // central directory 起始磁盘号
    writeU16(offset + 8, list.length);           // 本磁盘条目数
    writeU16(offset + 10, list.length);          // 总条目数
    writeU32(offset + 12, centralSize);          // central directory 大小
    writeU32(offset + 16, centralOffset);        // central directory 偏移
    writeU16(offset + 20, 0);                    // 注释长度
    offset += EOCD_SIZE;

    if (offset !== out.length) {
      throw new Error('createZip: 内部错误，写入长度与预分配大小不一致');
    }
    return out;
  }

  /**
   * 生成 ZIP 并包装成 Blob（MIME 为 application/zip）。
   * 浏览器里可直接交给 URL.createObjectURL 触发下载。
   */
  function createZip(entries) {
    var bytes = createZipBytes(entries);
    if (typeof Blob === 'undefined') {
      throw new Error('createZip: 当前环境没有 Blob，请改用 createZipBytes');
    }
    return new Blob([bytes], { type: 'application/zip' });
  }

  var api = {
    createZip: createZip,
    createZipBytes: createZipBytes
  };
  return api;
});
