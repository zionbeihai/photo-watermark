'use strict';
// 临时冒烟测试：模拟浏览器 <script src> 环境（没有 module，只有 window）
const fs = require('fs');
const vm = require('vm');

const sandbox = {
  window: {},
  console: console,
  Uint8Array: Uint8Array,
  ArrayBuffer: ArrayBuffer,
  DataView: DataView,
  Blob: Blob,
  Math: Math,
  isFinite: isFinite,
  Error: Error,
  TypeError: TypeError,
  RangeError: RangeError
};
sandbox.globalThis = sandbox.window;
vm.createContext(sandbox);

for (const file of ['js/exif.js', 'js/zip.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

console.log('window.ExifTool 方法：', Object.keys(sandbox.window.ExifTool).join(', '));
console.log('window.ZipBuilder 方法：', Object.keys(sandbox.window.ZipBuilder).join(', '));
console.log('浏览器方式读取 Orientation：',
  sandbox.window.ExifTool.readJpegOrientation(
    new Uint8Array(fs.readFileSync('tests/fixtures/sample-orient6.jpg'))));
const zipBytes = sandbox.window.ZipBuilder.createZipBytes([
  { name: '测试.txt', data: 'hi' }
]);
console.log('浏览器方式生成空/小 ZIP 字节数：', zipBytes.length);
