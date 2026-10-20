/* 照片水印 · 水印绘制引擎
 * 纯 Canvas 2D 绘制，无任何依赖。
 *
 * 单位约定：
 *   所有尺寸都相对「图片短边 S = min(W, H)」的百分比，
 *   这样同一套参数在任意缩放比例的画布上视觉一致
 *   —— 预览用小画布、导出用原图大画布，结果完全一致。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WatermarkEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    serif: '"Songti SC", "SimSun", "Noto Serif SC", Georgia, serif',
    sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Helvetica, Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif SC", serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  };

  var DEG = Math.PI / 180;

  var DEFAULTS = {
    text: {
      enabled: true,
      content: '仅供xx办理xx使用，他用无效',
      font: 'system',
      sizePct: 6,          // 字号 = 短边 × sizePct%
      color: '#ffffff',
      opacity: 0.8,
      rotate: -30,
      pos: 'mc',           // tl tc tr ml mc mr bl bc br | tile
      marginPct: 3,
      bold: true,
      italic: false,
      stroke: false,
      strokeColor: '#000000',
      strokeWidthPct: 8,   // 描边宽度 = 字号 × %
      tileGapPct: 60,      // 平铺间距（相对水印自身尺寸的百分比）
      tileRotate: -30
    },
    logo: {
      enabled: false,
      sizePct: 16,         // 水印图宽度 = 短边 × sizePct%
      opacity: 0.85,
      rotate: 0,
      pos: 'br',
      marginPct: 3,
      tileGapPct: 40
    }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function fontString(fontKey, fontSize, bold, italic) {
    var family = FONTS[fontKey] || FONTS.system;
    var style = (italic ? 'italic ' : '') + (bold ? '700' : '400');
    return style + ' ' + fontSize.toFixed(2) + 'px ' + family;
  }

  /* 九宫格锚点 → 水印块中心的坐标 */
  function anchorCenter(pos, W, H, blockW, blockH, margin) {
    var hw = blockW / 2, hh = blockH / 2;
    var cx, cy;
    switch (pos) {
      case 'tl': cx = margin + hw; cy = margin + hh; break;
      case 'tc': cx = W / 2; cy = margin + hh; break;
      case 'tr': cx = W - margin - hw; cy = margin + hh; break;
      case 'ml': cx = margin + hw; cy = H / 2; break;
      case 'mc': cx = W / 2; cy = H / 2; break;
      case 'mr': cx = W - margin - hw; cy = H / 2; break;
      case 'bl': cx = margin + hw; cy = H - margin - hh; break;
      case 'bc': cx = W / 2; cy = H - margin - hh; break;
      case 'br':
      default:   cx = W - margin - hw; cy = H - margin - hh; break;
    }
    return { cx: cx, cy: cy };
  }

  /* ---------- 文字水印布局 ---------- */
  function measureText(ctx, cfg, S) {
    var content = String(cfg.content == null ? '' : cfg.content);
    var lines = content.split('\n');
    var fontSize = Math.max(6, S * (cfg.sizePct / 100));
    ctx.font = fontString(cfg.font, fontSize, cfg.bold, cfg.italic);

    var maxW = 0;
    for (var i = 0; i < lines.length; i++) {
      var w = ctx.measureText(lines[i]).width;
      if (w > maxW) maxW = w;
    }
    // 全空行时给一个最小宽度，避免除零和退化
    var lineH = fontSize * 1.22;
    return {
      lines: lines,
      fontSize: fontSize,
      lineHeight: lineH,
      width: Math.max(maxW, fontSize * 0.5),
      height: lineH * lines.length
    };
  }

  /* 在 (cx, cy) 为中心的位置画多行文字 */
  function paintTextBlock(ctx, layout, cx, cy, rotateDeg, cfg, fontSize) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rotateDeg) ctx.rotate(rotateDeg * DEG);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontString(cfg.font, fontSize, cfg.bold, cfg.italic);

    var totalH = layout.lineHeight * layout.lines.length;
    var startY = -totalH / 2 + layout.lineHeight / 2;

    if (cfg.stroke) {
      ctx.lineWidth = Math.max(1, fontSize * (cfg.strokeWidthPct / 100));
      ctx.strokeStyle = cfg.strokeColor;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }

    for (var i = 0; i < layout.lines.length; i++) {
      var text = layout.lines[i];
      if (!text) continue;
      var y = startY + i * layout.lineHeight;
      if (cfg.stroke) ctx.strokeText(text, 0, y);
      ctx.fillStyle = cfg.color;
      ctx.fillText(text, 0, y);
    }
    ctx.restore();
  }

  function drawText(ctx, W, H, cfg, S) {
    if (!cfg || cfg.enabled === false) return null;
    var content = String(cfg.content == null ? '' : cfg.content);
    if (!content.trim() || cfg.opacity <= 0) return null;

    var layout = measureText(ctx, cfg, S);
    var margin = S * (cfg.marginPct / 100);

    ctx.save();
    ctx.globalAlpha = clamp(cfg.opacity, 0, 1);

    if (cfg.pos === 'tile') {
      drawTiled(ctx, W, H, cfg, layout.width, layout.height, S, function (x, y) {
        paintTextBlock(ctx, layout, x, y, cfg.tileRotate, cfg, layout.fontSize);
      });
    } else {
      var c = anchorCenter(cfg.pos, W, H, layout.width, layout.height, margin);
      paintTextBlock(ctx, layout, c.cx, c.cy, cfg.rotate || 0, cfg, layout.fontSize);
    }
    ctx.restore();

    return { layout: layout, margin: margin };
  }

  /* ---------- 自由平铺 ----------
   * 先把坐标系旋转到平铺角度，再在覆盖整图的网格上重复绘制。
   * stepY 额外乘 1.6，避免单行文字在纵向挤成一片。
   */
  function drawTiled(ctx, W, H, cfg, itemW, itemH, S, paintAt) {
    var gap = clamp(cfg.tileGapPct == null ? 60 : cfg.tileGapPct, 0, 300) / 100;
    var stepX = Math.max(itemW * (1 + gap), itemW * 1.05);
    var stepY = Math.max(itemH * (1 + gap) * 1.6, itemH * 1.05);
    // 极端参数保护：步长过小会让绘制数量爆炸
    var minStep = Math.max(S * 0.01, 1);
    if (stepX < minStep) stepX = minStep;
    if (stepY < minStep) stepY = minStep;

    var angle = (cfg.tileRotate || 0) * DEG;
    var R = Math.sqrt(W * W + H * H) / 2 + Math.max(itemW, itemH);

    var cols = Math.ceil((2 * R) / stepX) + 1;
    var rows = Math.ceil((2 * R) / stepY) + 1;
    // 防御：超过 4000 个水印没有实际意义，只会卡住设备
    var limit = 4000;
    if (cols * rows > limit) {
      var k = Math.sqrt((cols * rows) / limit);
      stepX *= k; stepY *= k;
      cols = Math.ceil((2 * R) / stepX) + 1;
      rows = Math.ceil((2 * R) / stepY) + 1;
    }

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(angle);
    var x0 = -cols * stepX / 2;
    var y0 = -rows * stepY / 2;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        paintAt(x0 + c * stepX + stepX / 2, y0 + r * stepY + stepY / 2);
      }
    }
    ctx.restore();
  }

  /* ---------- 图片水印 ---------- */
  function logoSize(logo, S, cfg) {
    var targetW = S * (cfg.sizePct / 100);
    var ratio = logo.height / logo.width;
    return { w: targetW, h: targetW * ratio };
  }

  function drawLogo(ctx, W, H, cfg, S) {
    if (!cfg || cfg.enabled === false) return null;
    var img = cfg.image;
    if (!img || !img.width || !img.height) return null;
    if (cfg.opacity <= 0) return null;

    var dim = logoSize(img, S, cfg);
    var margin = S * (cfg.marginPct / 100);

    ctx.save();
    ctx.globalAlpha = clamp(cfg.opacity, 0, 1);

    function paintAt(x, y) {
      ctx.save();
      ctx.translate(x, y);
      if (cfg.rotate) ctx.rotate((cfg.tileRotate != null && cfg.pos === 'tile' ? cfg.tileRotate : cfg.rotate) * DEG);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, -dim.w / 2, -dim.h / 2, dim.w, dim.h);
      ctx.restore();
    }

    if (cfg.pos === 'tile') {
      drawTiled(ctx, W, H, cfg, dim.w, dim.h, S, paintAt);
    } else {
      var c = anchorCenter(cfg.pos, W, H, dim.w, dim.h, margin);
      paintAt(c.cx, c.cy);
    }
    ctx.restore();

    return { width: dim.w, height: dim.h, margin: margin };
  }

  /* ---------- 统一入口 ----------
   * config: { text: {...}, logo: {...} }
   * 返回绘制结果摘要，便于调试和自动化断言。
   */
  function draw(ctx, W, H, config) {
    var S = Math.min(W, H);
    var out = { S: S, text: null, logo: null };
    if (!config) return out;
    if (config.text) out.text = drawText(ctx, W, H, config.text, S);
    if (config.logo) out.logo = drawLogo(ctx, W, H, config.logo, S);
    return out;
  }

  return {
    FONTS: FONTS,
    DEFAULTS: DEFAULTS,
    fontString: fontString,
    anchorCenter: anchorCenter,
    measureText: measureText,
    drawText: drawText,
    drawLogo: drawLogo,
    draw: draw
  };
});
