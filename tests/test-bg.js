'use strict';
/* 证件照换底算法单测（Node，无需浏览器 / Pillow） */

const path = require('path');
const BgReplace = require(path.join(__dirname, '..', 'js', 'bg.js'));

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n[ ' + t + ' ]'); }

/* ---------- 造一张合成证件照：纯色背景 + 居中的人像矩形 ---------- */
function makePhoto(opts) {
  const W = opts.w || 200, H = opts.h || 260;
  const data = new Uint8ClampedArray(W * H * 4);
  const bg = BgReplace.hexToRgb(opts.bg);
  const fg = BgReplace.hexToRgb(opts.fg || '#E0B090');
  const px0 = Math.floor(W * 0.25), px1 = Math.floor(W * 0.75);
  const py0 = Math.floor(H * 0.25), py1 = Math.floor(H * 0.85);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isFg = x >= px0 && x < px1 && y >= py0 && y < py1;
      const c = isFg ? fg : bg;
      data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H, px0, px1, py0, py1 };
}

function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}
function dist(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
function rgbHex(c) {
  return '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ---------- 1. 背景色估计 ---------- */
section('1. 背景色自动估计');
{
  const img = makePhoto({ bg: '#438EDB' });
  const est = BgReplace.estimateBackground(img.data, img.width, img.height);
  ok(est.r === 0x43 && est.g === 0x8E && est.b === 0xDB,
    '纯蓝背景估计为 #438EDB', rgbHex(est));
  ok(est.samples > 1000, '采样点足够多 (' + est.samples + ')');

  const img2 = makePhoto({ bg: '#FFFFFF' });
  const est2 = BgReplace.estimateBackground(img2.data, img2.width, img2.height);
  ok(rgbHex(est2) === '#FFFFFF', '白底估计正确', rgbHex(est2));

  const img3 = makePhoto({ bg: '#D9001B' });
  const est3 = BgReplace.estimateBackground(img3.data, img3.width, img3.height);
  ok(rgbHex(est3) === '#D9001B', '红底估计正确', rgbHex(est3));
}

/* ---------- 2. 蓝底换白底 ---------- */
section('2. 蓝底 -> 白底');
{
  const img = makePhoto({ bg: '#438EDB' });
  const out = BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#FFFFFF', tolerance: 40, feather: 20
  });
  const corner = pixelAt({ data: out.data, width: img.width }, 2, 2);
  const center = pixelAt({ data: out.data, width: img.width }, 100, 140);
  ok(rgbHex(corner) === '#FFFFFF', '左上角背景变成纯白', rgbHex(corner));
  ok(dist(pixelAt(img, 100, 140), center) < 1, '人像中心像素保持不变',
    { before: rgbHex(pixelAt(img, 100, 140)), after: rgbHex(center) });
  ok(out.stats.replacedRatio > 0.45 && out.stats.replacedRatio < 0.82,
    '背景替换比例合理 (' + (out.stats.replacedRatio * 100).toFixed(1) + '%)');
  ok(pixelAt({ data: out.data, width: img.width }, 100, 140).a === 255, 'alpha 通道保持 255');
}

/* ---------- 3. 白底换蓝底（反向） ---------- */
section('3. 白底 -> 标准蓝底');
{
  const img = makePhoto({ bg: '#FFFFFF' });
  const out = BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#438EDB', tolerance: 40, feather: 20
  });
  const corner = pixelAt({ data: out.data, width: img.width }, 2, 2);
  ok(rgbHex(corner) === '#438EDB', '角落背景变成标准蓝', rgbHex(corner));
  const center = pixelAt({ data: out.data, width: img.width }, 100, 140);
  ok(dist(pixelAt(img, 100, 140), center) < 1, '人像中心不受影响', rgbHex(center));
}

/* ---------- 4. 边缘羽化 ---------- */
section('4. 边缘羽化（不是硬切）');
{
  // 合成图的边界是硬切的开/关，做不出过渡带；
  // 这里手工构造「背景色 / 中间混合色 / 前景色」三带图，验证羽化区间的插值。
  const W = 30, H = 30;
  const data = new Uint8ClampedArray(W * H * 4);
  const bg = { r: 0x43, g: 0x8E, b: 0xDB };
  const fg = { r: 0xE0, g: 0xB0, b: 0x90 };
  const midColor = { r: 129, g: 155, b: 249 }; // 介于 bg 与 fg 之间，距离约 70
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const c = x < 10 ? bg : (x < 20 ? midColor : fg);
      data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 255;
    }
  }
  const img = { data, width: W, height: H };
  const stats = BgReplace.replaceInPlace({
    data, width: W, height: H,
    color: '#FFFFFF', tolerance: 40, feather: 60, bgColor: bg
  });
  ok(stats.partialPixels > 0, '存在过渡带像素 (' + stats.partialPixels + ' 个)');
  ok(stats.replacedPixels > 0, '纯背景区被完整替换 (' + stats.replacedPixels + ')');

  const bgPx = pixelAt(img, 2, 15);
  ok(rgbHex(bgPx) === '#FFFFFF', '纯背景像素 -> 纯目标色', rgbHex(bgPx));

  const midPx = pixelAt(img, 15, 15);
  const isEmpty = rgbHex(midPx) !== '#FFFFFF' && rgbHex(midPx) !== '#81' + '9BF9';
  ok(isEmpty && dist(midPx, { r: 255, g: 255, b: 255 }) > 10 &&
     dist(midPx, midColor) > 10,
    '混合像素被部分混合（既非纯底色也非纯前景）', rgbHex(midPx));

  const fgPx = pixelAt(img, 27, 15);
  ok(rgbHex(fgPx) === rgbHex(fg), '明显前景像素保持不变', rgbHex(fgPx));
}

/* ---------- 5. 容差边界 ---------- */
section('5. 容差行为');
{
  const img = makePhoto({ bg: '#438EDB' });
  const low = BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#FFFFFF', tolerance: 5, feather: 5
  });
  const high = BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#FFFFFF', tolerance: 120, feather: 5
  });
  ok(low.stats.replacedPixels === high.stats.replacedPixels,
    '纯色背景上容差大小不影响替换像素数（都精确命中）',
    { low: low.stats.replacedPixels, high: high.stats.replacedPixels });
}

/* ---------- 6. 目标色 = 原背景色时应几乎不变 ---------- */
section('6. 幂等性：换成相同底色');
{
  const img = makePhoto({ bg: '#438EDB' });
  const out = BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#438EDB', tolerance: 40, feather: 20
  });
  let maxDiff = 0;
  for (let i = 0; i < img.data.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(img.data[i] - out.data[i]));
  }
  ok(maxDiff === 0, '换成相同底色：图像逐字节不变', { maxDiff });
}

/* ---------- 7. 不修改入参 ---------- */
section('7. 不修改传入数据');
{
  const img = makePhoto({ bg: '#438EDB' });
  const before = new Uint8ClampedArray(img.data);
  BgReplace.replace({
    data: img.data, width: img.width, height: img.height,
    color: '#FFFFFF', tolerance: 40, feather: 20
  });
  let same = true;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] !== before[i]) { same = false; break; }
  }
  ok(same, 'replace() 不修改入参数组');
}

/* ---------- 8. replaceInPlace 就地修改 ---------- */
section('8. 就地替换');
{
  const img = makePhoto({ bg: '#438EDB' });
  const before = new Uint8ClampedArray(img.data);
  const stats = BgReplace.replaceInPlace({
    data: img.data, width: img.width, height: img.height,
    color: '#FFFFFF', tolerance: 40, feather: 20
  });
  let changed = false;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] !== before[i]) { changed = true; break; }
  }
  ok(changed, 'replaceInPlace() 确实修改了入参数组');
  ok(stats.replacedPixels > 0, '返回了替换统计', { replaced: stats.replacedPixels });
  ok(rgbHex(pixelAt(img, 2, 2)) === '#FFFFFF', '就地替换后角落为白', rgbHex(pixelAt(img, 2, 2)));
}

/* ---------- 9. 亮度辅助函数 ---------- */
section('9. 底色亮度（用于提示白字水印可见性）');
{
  ok(Math.abs(BgReplace.luminanceOf('#FFFFFF') - 1) < 0.01, '白色亮度≈1',
    BgReplace.luminanceOf('#FFFFFF'));
  ok(Math.abs(BgReplace.luminanceOf('#000000')) < 0.01, '黑色亮度≈0',
    BgReplace.luminanceOf('#000000'));
  const blueLum = BgReplace.luminanceOf('#438EDB');
  ok(blueLum > 0.4 && blueLum < 0.7, '标准蓝亮度居中 (' + blueLum.toFixed(3) + ')');
}

/* ---------- 10. 颜色解析 ---------- */
section('10. hex 解析');
{
  ok(JSON.stringify(BgReplace.hexToRgb('#fff')) === JSON.stringify({ r: 255, g: 255, b: 255 }),
    '#fff 三位简写展开');
  ok(BgReplace.hexToRgb('#438EDB').g === 0x8E, '六位 hex 正确');
  ok(rgbHex(BgReplace.hexToRgb('#bad')) === '#BBAADD', '三位 hex #bad 是合法颜色，正确展开');
  ok(BgReplace.hexToRgb('xyz').r === 255 && BgReplace.hexToRgb('xyz').g === 255,
    '非法输入回退为白色');
}

/* ---------- 11. 预设色 ---------- */
section('11. 预设底色');
{
  ok(BgReplace.PRESETS.length >= 7, '预设数量 ' + BgReplace.PRESETS.length);
  const ids = BgReplace.PRESETS.map(p => p.id);
  ok(ids.includes('blue') && ids.includes('white') && ids.includes('red'), '包含蓝/白/红');
  BgReplace.PRESETS.forEach(p => {
    ok(/^#[0-9A-Fa-f]{6}$/.test(p.color), '预设 ' + p.name + ' 颜色合法 ' + p.color);
  });
}

console.log('\n========================================');
console.log('[结果] 换底算法测试：' + pass + ' 通过, ' + fail + ' 失败');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
