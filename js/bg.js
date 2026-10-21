/* 照片水印 · 证件照换底色
 *
 * 原理（纯浏览器端，无 AI 模型、无网络请求）：
 *   1. 从图片四条边采样，用直方图中位数估计「当前底色」
 *   2. 逐像素计算与底色的 RGB 距离
 *   3. 距离 < 容差 → 判为背景，替换成目标底色
 *     距离 > 容差 + 羽化 → 判为前景，保留原样
 *     中间区间 → 线性过渡（避免头发/肩膀边缘出现硬锯齿）
 *
 * 局限（必须在 UI 里告知用户）：
 *   只适用于纯色或近似纯色背景。背景有纹理、杂物、明暗渐变时效果会差；
 *   如果衣服颜色与背景很接近（白衬衫 + 白底），也会被一起替换。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BgReplace = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* 证件照常用底色 */
  var PRESETS = [
    { id: 'blue', name: '标准蓝', color: '#438EDB' },
    { id: 'deepblue', name: '深蓝', color: '#2A5CAA' },
    { id: 'lightblue', name: '浅蓝', color: '#A6C9EC' },
    { id: 'white', name: '白', color: '#FFFFFF' },
    { id: 'red', name: '标准红', color: '#D9001B' },
    { id: 'darkred', name: '深红', color: '#A50D1F' },
    { id: 'gray', name: '浅灰', color: '#D9D9D9' }
  ];

  var DEFAULTS = {
    enabled: false,
    color: '#438EDB',
    tolerance: 40,   // 背景判定阈值（RGB 欧氏距离）
    feather: 20      // 边缘过渡带宽度
  };

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 255, b: 255 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  /* 从四条边带采样，用每通道的直方图中位数估计背景色。
   * 用中位数而不是平均值：对局部阴影、边缘杂色更稳。 */
  function estimateBackground(data, w, h) {
    var bandX = Math.max(1, Math.min(Math.floor(w * 0.04), 120));
    var bandY = Math.max(1, Math.min(Math.floor(h * 0.04), 120));
    var histR = new Uint32Array(256);
    var histG = new Uint32Array(256);
    var histB = new Uint32Array(256);
    var n = 0;

    function sampleAt(x, y) {
      var i = (y * w + x) * 4;
      histR[data[i]]++;
      histG[data[i + 1]]++;
      histB[data[i + 2]]++;
      n++;
    }

    var x, y;
    for (y = 0; y < h; y++) {
      for (x = 0; x < bandX; x++) {
        sampleAt(x, y);
        sampleAt(w - 1 - x, y);
      }
    }
    for (x = 0; x < w; x++) {
      for (y = 0; y < bandY; y++) {
        sampleAt(x, y);
        sampleAt(x, h - 1 - y);
      }
    }

    function median(hist) {
      var half = n / 2;
      var sum = 0;
      for (var v = 0; v < 256; v++) {
        sum += hist[v];
        if (sum >= half) return v;
      }
      return 0;
    }

    return { r: median(histR), g: median(histG), b: median(histB), samples: n };
  }

  /* 原地替换。返回统计信息。
   * opts: { data, width, height, color:'#rrggbb', tolerance, feather, bgColor? }
   * 传 bgColor 可跳过自动估计（复用上一张的结果）。 */
  function replaceInPlace(opts) {
    var data = opts.data;
    var w = opts.width;
    var h = opts.height;
    var target = hexToRgb(opts.color);
    var tol = Math.max(0, Number(opts.tolerance) || 0);
    var feather = Math.max(1, Number(opts.feather) || 1);
    var bg = opts.bgColor || estimateBackground(data, w, h);

    var t0 = tol;
    var t1 = tol + feather;
    var t0sq = t0 * t0;
    var t1sq = t1 * t1;

    var bgR = bg.r, bgG = bg.g, bgB = bg.b;
    var tR = target.r, tG = target.g, tB = target.b;
    var replaced = 0;
    var partial = 0;
    var total = w * h;

    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var dr = r - bgR, dg = g - bgG, db = b - bgB;
      var d2 = dr * dr + dg * dg + db * db;

      if (d2 <= t0sq) {
        // 判为背景：直接换成目标色
        data[i] = tR;
        data[i + 1] = tG;
        data[i + 2] = tB;
        replaced++;
      } else if (d2 < t1sq) {
        // 过渡带：按距离线性混合，让边缘不出现硬锯齿
        var a = (Math.sqrt(d2) - t0) / (t1 - t0);
        var ia = 1 - a;
        data[i] = r * a + tR * ia;
        data[i + 1] = g * a + tG * ia;
        data[i + 2] = b * a + tB * ia;
        partial++;
      }
      // 其余像素保持原样
    }

    return {
      bgColor: bg,
      replacedPixels: replaced,
      partialPixels: partial,
      replacedRatio: total ? replaced / total : 0,
      partialRatio: total ? partial / total : 0,
      totalPixels: total
    };
  }

  /* 不修改入参的版本（测试 / 需要保留原图时用） */
  function replace(opts) {
    var copy = new Uint8ClampedArray(opts.data);
    var stats = replaceInPlace({
      data: copy,
      width: opts.width,
      height: opts.height,
      color: opts.color,
      tolerance: opts.tolerance,
      feather: opts.feather,
      bgColor: opts.bgColor
    });
    return {
      data: copy,
      width: opts.width,
      height: opts.height,
      stats: stats
    };
  }

  /* 底色亮度（0~1），用来判断白字水印在换底后是否还看得清 */
  function luminanceOf(hex) {
    var c = hexToRgb(hex);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }

  return {
    PRESETS: PRESETS,
    DEFAULTS: DEFAULTS,
    hexToRgb: hexToRgb,
    luminanceOf: luminanceOf,
    estimateBackground: estimateBackground,
    replaceInPlace: replaceInPlace,
    replace: replace
  };
});
