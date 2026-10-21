/* 照片水印 · 应用逻辑
 * 全部在浏览器本地运行，没有任何网络请求（除首次加载自身静态资源）。
 */
(function () {
  'use strict';

  var WE = window.WatermarkEngine;

  /* ---------------- 小工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function throttleFrame(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }

  var toastHost = $('#toastHost');
  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    toastHost.appendChild(el);
    var life = ms || 2600;
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 220);
    }, life);
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    items: [],
    active: 0,
    mode: 'text',
    cfg: {
      text: Object.assign({}, WE.DEFAULTS.text),
      logo: Object.assign({}, WE.DEFAULTS.logo, { image: null, name: '' })
    },
    output: {
      format: 'jpeg',
      quality: 92,
      maxSide: 0,
      exif: 'clear'
    },
    bg: {
      enabled: false,
      color: '#438EDB',
      tolerance: 40,
      feather: 20,
      detected: null
    },
    busy: false,
    lastPos: 'mc'
  };

  var MAX_ITEMS = 30;

  /* ---------------- 证件照换底色 ---------------- */
  // 在已绘制好原图的 canvas 上原地换底。W/H 必须是 canvas 的物理像素尺寸。
  // 返回统计信息（含识别到的原底色），失败返回 null。
  function applyBgReplace(ctx, W, H) {
    if (!window.BgReplace || !state.bg.enabled) return null;
    var id;
    try {
      id = ctx.getImageData(0, 0, W, H);
    } catch (e) {
      console.warn('读取像素失败（可能是跨域图片）', e);
      return null;
    }
    var stats = null;
    try {
      stats = window.BgReplace.replaceInPlace({
        data: id.data,
        width: W,
        height: H,
        color: state.bg.color,
        tolerance: state.bg.tolerance,
        feather: state.bg.feather
      });
    } catch (e) {
      console.warn('换底处理失败', e);
      return null;
    }
    ctx.putImageData(id, 0, 0);
    state.bg.detected = stats.bgColor;
    return stats;
  }

  function rgbToHex(c) {
    return '#' + [c.r, c.g, c.b].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }

  /* ---------------- 设备能力 ---------------- */
  function detectLimits() {
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) return { maxPixels: 16.7e6, maxSide: 8192, ios: true };
    if (/Android|Mobile/i.test(ua)) return { maxPixels: 24e6, maxSide: 8192, ios: false };
    return { maxPixels: 80e6, maxSide: 16384, ios: false };
  }
  var LIMITS = detectLimits();

  // 触屏移动设备才优先走系统分享面板（可直接"存储图像"进相册）；
  // 桌面浏览器即使支持 canShare，直接下载也更符合预期。
  var IS_TOUCH_MOBILE = (function () {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    try { return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0; }
    catch (e) { return false; }
  })();

  function canShareFiles() {
    if (!navigator.canShare || !window.File) return false;
    try {
      var f = new File([new Blob(['x'], { type: 'image/jpeg' })], 't.jpg', { type: 'image/jpeg' });
      return navigator.canShare({ files: [f] });
    } catch (e) { return false; }
  }

  /* ---------------- 图片加载 ---------------- */
  function decodeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('无法解码这张图片（格式可能不受浏览器支持）'));
      };
      img.src = url;
    });
  }

  function makeThumb(img, maxSize) {
    var s = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return '';
    }
  }

  function releaseImage(item) {
    if (!item || !item.img) return;
    item.img.src = '';
    item.img = null;
    if (item.url) { URL.revokeObjectURL(item.url); item.url = null; }
  }

  function ensureImage(item) {
    if (item.img) return Promise.resolve(item.img);
    // 同一时刻只保留一张解码后的位图，避免手机内存爆掉
    state.items.forEach(function (it) { if (it !== item) releaseImage(it); });
    return decodeImage(item.file).then(function (res) {
      item.img = res.img;
      item.url = res.url;
      item.w = res.img.naturalWidth;
      item.h = res.img.naturalHeight;
      return res.img;
    });
  }

  /* ---------------- 文件添加 ---------------- */
  var addSeq = 0;

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) {
      toast('没有找到可用的图片文件', 'error');
      return Promise.resolve();
    }

    var room = MAX_ITEMS - state.items.length;
    if (room <= 0) {
      toast('最多同时处理 ' + MAX_ITEMS + ' 张，请先清空一部分', 'error');
      return Promise.resolve();
    }
    if (files.length > room) {
      toast('最多同时处理 ' + MAX_ITEMS + ' 张，已自动忽略多余的 ' + (files.length - room) + ' 张', 'error', 3600);
      files = files.slice(0, room);
    }

    var firstNewIndex = state.items.length;
    var added = 0;
    var chain = Promise.resolve();

    files.forEach(function (file, idx) {
      chain = chain.then(function () {
        return decodeImage(file).then(function (res) {
          var item = {
            id: 'i' + (++addSeq),
            file: file,
            name: file.name || ('照片-' + (addSeq)),
            size: file.size,
            w: res.img.naturalWidth,
            h: res.img.naturalHeight,
            thumb: makeThumb(res.img, 160),
            img: res.img,
            url: res.url,
            done: false
          };
          state.items.push(item);
          added++;
          if (idx < files.length - 1) {
            // 只保留最后一张的解码位图
            releaseImage(item);
          }
        }).catch(function (err) {
          toast('跳过「' + file.name + '」：' + err.message, 'error', 3200);
        });
      });
    });

    return chain.then(function () {
      if (!added) return;
      showStage();
      renderThumbs();
      activate(firstNewIndex);
      toast('已添加 ' + added + ' 张照片', 'ok');
    });
  }

  function showStage() {
    $('#stage').hidden = false;
    $('#dropzone').hidden = true;
    $('#actionDock').hidden = false;
  }

  function showDropzone() {
    $('#stage').hidden = true;
    $('#dropzone').hidden = false;
    $('#actionDock').hidden = true;
  }

  /* ---------------- 激活与预览 ---------------- */
  function activate(index) {
    if (index < 0 || index >= state.items.length) return;
    state.active = index;
    var item = state.items[index];
    $('#exportNote').textContent = '';
    // 先把旧图释放，避免内存叠加
    state.items.forEach(function (it) { if (it !== item) releaseImage(it); });
    ensureImage(item).then(function () {
      renderPreview();
      renderThumbs();
      renderMeta();
    }).catch(function (err) {
      toast('打开失败：' + err.message, 'error');
    });
  }

  var renderPreview = throttleFrame(function () {
    var item = state.items[state.active];
    if (!item || !item.img) return;
    var canvas = $('#previewCanvas');
    var wrap = $('#previewWrap');

    var availW = Math.max(120, wrap.clientWidth - 28);
    // 手机上限制预览高度，避免竖图占满整屏、控件全被推到下面
    var heightFactor = window.innerWidth < 900 ? 0.44 : 0.56;
    var maxCssH = Math.min(window.innerHeight * heightFactor, window.innerWidth < 900 ? 420 : 600);
    var availH = Math.max(120, maxCssH);

    var iw = item.w, ih = item.h;
    var scale = Math.min(1, availW / iw, availH / ih);
    var cssW = Math.max(1, Math.round(iw * scale));
    var cssH = Math.max(1, Math.round(ih * scale));

    // 换底是逐像素运算：启用时按 CSS 像素渲染（不乘 DPR），
    // 否则 2x/3x 屏上运算量会翻 4~9 倍，拖动滑块明显卡顿。
    var dpr = state.bg.enabled ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (state.output.format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cssW, cssH);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(item.img, 0, 0, cssW, cssH);

    if (state.bg.enabled) {
      applyBgReplace(ctx, canvas.width, canvas.height);
    }

    try {
      WE.draw(ctx, cssW, cssH, { text: state.cfg.text, logo: state.cfg.logo });
    } catch (e) {
      console.error('绘制水印失败', e);
    }

    wrap.classList.remove('is-empty');
    $('#stageTitle').textContent = item.name;
    updateBgStatus();
  });

  function renderThumbs() {
    var strip = $('#fileStrip');
    strip.textContent = '';
    state.items.forEach(function (item, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb' + (i === state.active ? ' active' : '') + (item.done ? ' done' : '');
      b.title = item.name;
      var im = document.createElement('img');
      im.src = item.thumb;
      im.alt = '';
      b.appendChild(im);
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(i + 1);
      b.appendChild(badge);
      b.addEventListener('click', function () { activate(i); });
      strip.appendChild(b);
    });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'thumb add';
    add.textContent = '+';
    add.title = '继续添加照片';
    add.addEventListener('click', function () { $('#fileInput').click(); });
    strip.appendChild(add);

    updateDockLabels();
  }

  function computeExportSize(w, h) {
    var scale = 1;
    var maxSide = Number(state.output.maxSide) || 0;
    if (maxSide > 0) scale = Math.min(scale, maxSide / Math.max(w, h));
    var px = w * h * scale * scale;
    if (px > LIMITS.maxPixels) scale *= Math.sqrt(LIMITS.maxPixels / px);
    var longest = Math.max(w, h) * scale;
    if (longest > LIMITS.maxSide) scale *= LIMITS.maxSide / longest;
    scale = Math.min(1, scale);
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
      scale: scale,
      downscaled: scale < 0.999
    };
  }

  function renderMeta() {
    var item = state.items[state.active];
    var meta = $('#previewMeta');
    if (!item) { meta.textContent = ''; return; }

    var out = computeExportSize(item.w, item.h);
    var parts = [];
    parts.push('<span>' + item.w + ' × ' + item.h + '</span>');
    parts.push('<span class="sep">·</span>');
    parts.push('<span>' + fmtBytes(item.size) + '</span>');
    parts.push('<span class="sep">·</span>');
    parts.push('<span>导出 ' + out.w + ' × ' + out.h +
      (out.downscaled ? ' <span style="color:var(--warn)">(已按设备上限缩小)</span>' : '') + '</span>');
    meta.innerHTML = parts.join('');

    var hint = $('#exportNote');
    if (hint) {
      hint.innerHTML = LIMITS.ios
        ? '提示：iOS 上点击保存会打开系统分享面板，选「存储图像」即可进相册'
        : '';
    }
  }

  /* ---------------- 控件同步 ---------------- */
  function activeCfg() {
    // "无水印"模式下位置面板是隐藏的；这里返回文字配置只是为了让同步代码不炸
    return state.mode === 'logo' ? state.cfg.logo : state.cfg.text;
  }

  function rangeFill(el) {
    var min = Number(el.min || 0);
    var max = Number(el.max || 100);
    var v = Number(el.value);
    var pct = ((v - min) / (max - min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  }

  function syncControls() {
    var t = state.cfg.text;
    var l = state.cfg.logo;
    var c = activeCfg();

    $('#textContent').value = t.content;
    $('#textFont').value = t.font;
    $('#textSize').value = t.sizePct;
    $('#textSizeVal').textContent = trimNum(t.sizePct) + '%';
    $('#textColor').value = t.color;
    $('#textOpacity').value = Math.round(t.opacity * 100);
    $('#textOpacityVal').textContent = Math.round(t.opacity * 100) + '%';
    $('#textRotate').value = t.rotate;
    $('#textRotateVal').textContent = t.rotate + '°';
    $('#textBold').checked = !!t.bold;
    $('#textStroke').checked = !!t.stroke;
    $('#strokeRow').hidden = !t.stroke;
    $('#strokeColor').value = t.strokeColor;
    $('#strokeWidth').value = t.strokeWidthPct;
    $('#strokeWidthVal').textContent = trimNum(t.strokeWidthPct) + '%';

    $('#logoSize').value = l.sizePct;
    $('#logoSizeVal').textContent = trimNum(l.sizePct) + '%';
    $('#logoOpacity').value = Math.round(l.opacity * 100);
    $('#logoOpacityVal').textContent = Math.round(l.opacity * 100) + '%';
    $('#logoRotate').value = l.rotate;
    $('#logoRotateVal').textContent = l.rotate + '°';

    // 位置 / 平铺 / 边距 —— 作用于当前模式
    $$('#posGrid .pos-cell').forEach(function (btn) {
      btn.classList.toggle('active', c.pos === btn.getAttribute('data-pos'));
      btn.setAttribute('aria-checked', c.pos === btn.getAttribute('data-pos') ? 'true' : 'false');
    });
    var tileOn = c.pos === 'tile';
    $('#tileToggle').classList.toggle('active', tileOn);
    $('#tileToggle').setAttribute('aria-pressed', tileOn ? 'true' : 'false');
    $('#tileOptions').hidden = !tileOn;
    $('#marginField').hidden = tileOn;

    var gapVal = c.tileGapPct != null ? c.tileGapPct : 60;
    $('#tileGap').value = gapVal;
    $('#tileGapVal').textContent = Math.round(gapVal) + '%';
    var trot = state.mode === 'text' ? state.cfg.text.tileRotate : state.cfg.logo.rotate;
    $('#tileRotate').value = trot;
    $('#tileRotateVal').textContent = Math.round(trot) + '°';
    // Logo 平铺用自身的旋转角度，所以隐藏"平铺角度"这一项
    $('#tileRotateRow').hidden = state.mode === 'logo';

    $('#margin').value = c.marginPct;
    $('#marginVal').textContent = trimNum(c.marginPct) + '%';

    // 颜色色板
    $$('#textSwatches .swatch').forEach(function (s) {
      s.classList.toggle('active', s.getAttribute('data-color').toLowerCase() === t.color.toLowerCase());
    });

    // 模式面板
    $('#textGroup').hidden = state.mode !== 'text';
    $('#logoGroup').hidden = state.mode !== 'logo';
    $('#logoGroup').setAttribute('data-open', state.mode === 'logo' ? 'true' : 'false');
    // 无水印时没有东西可以定位，隐藏位置面板
    $('#posGroup').hidden = state.mode === 'none';

    // 输出
    $('#outFormat').value = state.output.format;
    $('#outQuality').value = state.output.quality;
    $('#outQualityVal').textContent = state.output.quality;
    $('#qualityField').hidden = state.output.format !== 'jpeg';
    $('#outMaxSide').value = String(state.output.maxSide);
    $('#exifMode').value = state.output.exif;
    updateExifHint();

    ['textSize', 'textOpacity', 'textRotate', 'strokeWidth', 'logoSize', 'logoOpacity',
      'logoRotate', 'tileGap', 'tileRotate', 'margin', 'outQuality'].forEach(function (id) {
      var el = $('#' + id);
      if (el) rangeFill(el);
    });

    syncBgControls();
    renderPreview();
  }

  function trimNum(n) {
    var v = Math.round(n * 10) / 10;
    return String(v);
  }

  /* ---------------- 换底色 UI 同步 ---------------- */
  function presetNameOf(color) {
    var list = (window.BgReplace && BgReplace.PRESETS) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].color.toUpperCase() === String(color).toUpperCase()) return list[i].name;
    }
    return '自定义';
  }

  function syncBgControls() {
    var bg = state.bg;
    var hasBg = !!window.BgReplace;

    $('#bgToggle').classList.toggle('active', bg.enabled && hasBg);
    $('#bgToggle').setAttribute('aria-pressed', bg.enabled && hasBg ? 'true' : 'false');
    $('#bgOptions').hidden = !(bg.enabled && hasBg);

    $('#bgColor').value = bg.color;
    $('#bgTolerance').value = bg.tolerance;
    $('#bgToleranceVal').textContent = bg.tolerance;
    $('#bgFeather').value = bg.feather;
    $('#bgFeatherVal').textContent = bg.feather;
    rangeFill($('#bgTolerance'));
    rangeFill($('#bgFeather'));

    $('#bgColorLabel').textContent = presetNameOf(bg.color) + ' · ' + String(bg.color).toUpperCase();

    $$('#bgSwatches .swatch').forEach(function (s) {
      s.classList.toggle('active',
        String(s.getAttribute('data-color')).toUpperCase() === String(bg.color).toUpperCase());
    });

    updateBgStatus();
  }

  // 换底后底色变了，原来水印颜色可能正好撞色。
  // 按底色亮度自动选高对比的水印色，并开描边，让水印在任何区域都压得住。
  function autoFixWatermarkContrast() {
    var lum = (window.BgReplace ? BgReplace.luminanceOf(state.bg.color) : 0.5);
    var isLightBg = lum > 0.6;
    var color = isLightBg ? '#1F2937' : '#FFFFFF';
    var strokeColor = isLightBg ? '#FFFFFF' : '#000000';

    state.cfg.text.color = color;
    $('#textColor').value = color;
    $$('#textSwatches .swatch').forEach(function (s) {
      s.classList.toggle('active', String(s.getAttribute('data-color')).toLowerCase() === color.toLowerCase());
    });

    state.cfg.text.stroke = true;
    state.cfg.text.strokeColor = strokeColor;
    $('#textStroke').checked = true;
    $('#strokeRow').hidden = false;
    $('#strokeColor').value = strokeColor;

    updateBgStatus();
    renderPreview();
    toast('水印已改为' + (isLightBg ? '深色' : '白色') + '并开启描边', 'ok');
  }

  function updateBgStatus() {
    var bg = state.bg;
    var warn = $('#bgWarn');
    var hint = $('#bgHint');
    var detected = $('#bgDetected');
    if (!detected) return;

    if (!bg.enabled) {
      detected.textContent = '';
      if (warn) { warn.className = 'inline-alert warn'; warn.textContent = ''; }
      if (hint) hint.textContent = '';
      return;
    }

    detected.innerHTML = bg.detected
      ? '识别到的原底色：<span style="color:#cfe4ff;font-weight:500">' + rgbToHex(bg.detected) + '</span>'
      : '识别到的原底色：—';

    var targetLum = (window.BgReplace ? BgReplace.luminanceOf(bg.color) : 0.5);
    var textLum = (window.BgReplace ? BgReplace.luminanceOf(state.cfg.text.color || '#ffffff') : 1);
    var noWatermark = state.mode === 'none';
    var lowContrast = !noWatermark && Math.abs(targetLum - textLum) < 0.35 && !state.cfg.text.stroke;
    if (warn) {
      if (lowContrast) {
        warn.className = 'inline-alert warn show';
        warn.innerHTML = '<span>当前底色和水印颜色对比不够，水印可能看不清。</span>' +
          '<button type="button" class="btn btn-sm" id="fixContrastBtn" style="margin-left:auto;flex:0 0 auto">自动调整</button>';
        var fixBtn = document.getElementById('fixContrastBtn');
        if (fixBtn) fixBtn.addEventListener('click', autoFixWatermarkContrast);
      } else {
        warn.className = 'inline-alert warn';
        warn.textContent = '';
      }
    }
    if (hint) {
      hint.textContent = '仅适用于纯色或接近纯色的背景。背景有花纹、杂物、明暗渐变时无法干净分离。';
    }
  }

  function updateExifHint() {
    var hint = $('#exifHint');
    var warn = $('#exifWarn');
    var isJpeg = state.output.format === 'jpeg';
    var keep = state.output.exif === 'keep';

    if (!isJpeg && keep) {
      hint.textContent = 'PNG 格式不支持嵌入 EXIF，将按「清除」处理。';
      warn.className = 'inline-alert warn show';
      warn.textContent = '注意：当前格式为 PNG，拍摄信息不会保留。';
    } else if (keep) {
      hint.textContent = '会保留拍摄时间、机型、GPS 位置等信息。照片方向会被自动校正，方向标记写回为正向。';
      warn.className = 'inline-alert warn show';
      warn.textContent = '风险提示：带 GPS 的照片公开发布可能暴露拍摄地点，请确认后再发。';
    } else {
      hint.textContent = '导出文件不包含拍摄时间、机型、GPS 位置等元数据，更适合公开发布。';
      warn.className = 'inline-alert';
      warn.textContent = '';
    }
  }

  /* ---------------- 导出 ---------------- */
  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) {
          if (b) resolve(b); else reject(new Error('生成图片失败'));
        }, type, quality);
      } else {
        try {
          var data = canvas.toDataURL(type, quality);
          var bin = atob(data.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: type }));
        } catch (e) { reject(e); }
      }
    });
  }

  function readArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('读取文件失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  function jpegQualityValue() {
    return clamp(state.output.quality, 50, 100) / 100;
  }

  // 把原图 EXIF 写回导出的 JPEG。
  // 画布里的图像已经是正向的，所以必须把 Orientation 归一化为 1，
  // 否则查看器会再旋转一次导致方向错乱。
  function reattachExif(exportedBlob, originalFile) {
    if (!window.ExifTool) return Promise.resolve(exportedBlob);
    return readArrayBuffer(originalFile).then(function (origBuf) {
      var app1 = window.ExifTool.extractExifApp1(origBuf);
      if (!app1) return exportedBlob;
      var exif = app1;
      try {
        var orientation = window.ExifTool.readOrientation(app1);
        if (orientation !== 1) exif = window.ExifTool.setOrientation(app1, 1);
      } catch (e) { /* 解析失败就用原样 */ }
      return readArrayBuffer(exportedBlob).then(function (outBuf) {
        var merged = window.ExifTool.spliceExifIntoJpeg(outBuf, exif);
        return new Blob([merged], { type: 'image/jpeg' });
      }).catch(function () { return exportedBlob; });
    }).catch(function () { return exportedBlob; });
  }

  function buildOutputName(name, ext, hasWatermark) {
    var base = String(name).replace(/\.[^.]+$/, '');
    return base + (hasWatermark === false ? '-edited' : '-watermark') + '.' + ext;
  }

  // 渲染一张图的最终结果，返回 {blob, filename, outW, outH}
  function renderItemToBlob(item) {
    return ensureImage(item).then(function (img) {
      var size = computeExportSize(item.w, item.h);
      var W = size.w, H = size.h;
      var canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext('2d');
      var isJpeg = state.output.format === 'jpeg';

      if (isJpeg) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, W, H);

      if (state.bg.enabled) {
        applyBgReplace(ctx, W, H);
      }

      WE.draw(ctx, W, H, { text: state.cfg.text, logo: state.cfg.logo });

      var mime = isJpeg ? 'image/jpeg' : 'image/png';
      var q = isJpeg ? jpegQualityValue() : undefined;
      var ext = isJpeg ? 'jpg' : 'png';

      return canvasToBlob(canvas, mime, q).then(function (blob) {
        var chain = Promise.resolve(blob);
        if (isJpeg && state.output.exif === 'keep') {
          chain = reattachExif(blob, item.file);
        }
        return chain.then(function (finalBlob) {
          var hasWm = !!(state.cfg.text.enabled || state.cfg.logo.enabled);
          return {
            blob: finalBlob,
            filename: buildOutputName(item.name, ext, hasWm),
            w: W,
            h: H,
            downscaled: size.downscaled
          };
        });
      });
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function shareFiles(files, title) {
    if (!navigator.share || !navigator.canShare) return Promise.reject(new Error('不支持分享'));
    return navigator.share({ files: files, title: title || '照片水印' });
  }

  function setBusy(on) {
    state.busy = on;
    $('#exportBtn').disabled = on;
    $('#batchBtn').disabled = on;
    $('#shareBtn').disabled = on;
  }

  function showProgress(pct) {
    var bar = $('#progress');
    if (pct == null) { bar.classList.remove('show'); bar.firstElementChild.style.width = '0%'; return; }
    bar.classList.add('show');
    bar.firstElementChild.style.width = clamp(pct, 0, 100) + '%';
  }

  /* 导出当前这张 */
  function exportCurrent() {
    var item = state.items[state.active];
    if (!item || state.busy) return;
    setBusy(true);
    $('#exportNote').textContent = '正在生成…';

    renderItemToBlob(item).then(function (res) {
      var file = new File([res.blob], res.filename, { type: res.blob.type });

      if (IS_TOUCH_MOBILE && canShareFiles()) {
        return shareFiles([file]).then(function () {
          $('#exportNote').textContent = '已通过系统分享面板保存';
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            $('#exportNote').textContent = '已取消分享';
            return;
          }
          downloadBlob(res.blob, res.filename);
          $('#exportNote').textContent = '分享不可用，已改用下载';
        });
      }
      downloadBlob(res.blob, res.filename);
      $('#exportNote').textContent = '已保存 ' + res.w + ' × ' + res.h + ' · ' + fmtBytes(res.blob.size);
      toast('已保存：' + res.filename, 'ok');
    }).catch(function (err) {
      toast('导出失败：' + err.message, 'error', 4000);
      $('#exportNote').textContent = '';
    }).then(function () {
      setBusy(false);
      item.done = true;
      renderThumbs();
    });
  }

  /* 批量导出 */
  function exportAll() {
    if (state.busy) return;
    var items = state.items.slice();
    if (!items.length) return;
    if (items.length === 1) { exportCurrent(); return; }

    setBusy(true);
    showProgress(0);
    var results = [];
    var i = 0;

    function step() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      showProgress((idx / items.length) * 100);
      $('#exportNote').textContent = '正在处理 ' + (idx + 1) + ' / ' + items.length + '…';
      return renderItemToBlob(items[idx]).then(function (res) {
        results.push(res);
        items[idx].done = true;
        renderThumbs();
      }).catch(function (err) {
        toast('「' + items[idx].name + '」导出失败：' + err.message, 'error', 3200);
      }).then(step);
    }

    step().then(function () {
      showProgress(100);
      if (!results.length) throw new Error('没有成功导出的图片');

      var files = results.map(function (r) {
        return new File([r.blob], r.filename, { type: r.blob.type });
      });

      // 优先用系统分享面板（手机上可以直接存储到相册）
      var canMultiShare = false;
      try {
        canMultiShare = IS_TOUCH_MOBILE && canShareFiles() && navigator.canShare({ files: files });
      } catch (e) { canMultiShare = false; }

      if (canMultiShare) {
        return shareFiles(files).then(function () {
          $('#exportNote').textContent = '已分享 ' + files.length + ' 张';
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            $('#exportNote').textContent = '已取消分享';
            return;
          }
          return zipAndDownload(results);
        });
      }
      return zipAndDownload(results);
    }).catch(function (err) {
      toast('批量导出失败：' + err.message, 'error', 4000);
    }).then(function () {
      setBusy(false);
      setTimeout(function () { showProgress(null); }, 900);
      // 批量处理过程中位图缓存被逐张释放，这里恢复当前预览
      if (state.items.length) activate(state.active);
    });
  }

  // ZIP 内不允许重名（同名会互相覆盖），给重复的文件名补序号
  function uniqueNames(list) {
    var used = Object.create(null);
    return list.map(function (name) {
      if (!used[name]) { used[name] = 1; return name; }
      var dot = name.lastIndexOf('.');
      var base = dot > 0 ? name.slice(0, dot) : name;
      var ext = dot > 0 ? name.slice(dot) : '';
      var k = used[name], candidate;
      do { k++; candidate = base + '-' + k + ext; } while (used[candidate]);
      used[name] = k;
      used[candidate] = 1;
      return candidate;
    });
  }

  function zipAndDownload(results) {
    if (window.ZipBuilder && results.length > 1) {
      return Promise.all(results.map(function (r) { return readArrayBuffer(r.blob); }))
        .then(function (bufs) {
          var names = uniqueNames(results.map(function (r) { return r.filename; }));
          var zipEntries = results.map(function (r, i) {
            return { name: names[i], data: new Uint8Array(bufs[i]) };
          });
          var bytes = window.ZipBuilder.createZipBytes(zipEntries);
          var blob = new Blob([bytes], { type: 'application/zip' });
          downloadBlob(blob, '照片水印-' + results.length + '张.zip');
          $('#exportNote').textContent = '已打包 ' + results.length + ' 张为 ZIP · ' + fmtBytes(blob.size);
          toast('已打包 ' + results.length + ' 张照片', 'ok');
        });
    }
    // 没有 ZipBuilder 时逐张触发（可能被浏览器拦截部分下载）
    results.forEach(function (r, i) {
      setTimeout(function () { downloadBlob(r.blob, r.filename); }, i * 320);
    });
    $('#exportNote').textContent = '已导出 ' + results.length + ' 张';
    return Promise.resolve();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindRange(id, apply) {
    var el = $('#' + id);
    if (!el) return;
    el.addEventListener('input', function () {
      rangeFill(el);
      apply(Number(el.value));
      renderPreview();
    });
  }

  function bindCheck(id, apply) {
    var el = $('#' + id);
    if (!el) return;
    el.addEventListener('change', function () {
      apply(el.checked);
      renderPreview();
    });
  }

  function bindSelect(id, apply) {
    var el = $('#' + id);
    if (!el) return;
    el.addEventListener('change', function () {
      apply(el.value);
      renderPreview();
    });
  }

  function init() {
    /* --- 拖放 & 选择 --- */
    var dz = $('#dropzone');
    var fileInput = $('#fileInput');

    dz.addEventListener('click', function () { fileInput.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
      fileInput.value = '';
    });

    $('#addMoreBtn').addEventListener('click', function () { fileInput.click(); });

    $('#clearBtn').addEventListener('click', function () {
      state.items.forEach(releaseImage);
      state.items = [];
      state.active = 0;
      $('#fileStrip').textContent = '';
      $('#previewMeta').textContent = '';
      showDropzone();
      toast('已清空');
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
        e.preventDefault();
        dz.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (ev === 'drop') e.preventDefault();
        if (!e.relatedTarget || ev === 'drop') dz.classList.remove('dragover');
      });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });

    // 粘贴图片
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = e.clipboardData.files;
      if (files && files.length) addFiles(files);
    });

    /* --- 水印模式 --- */
    $$('input[name="wmMode"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.mode = r.value;
        state.cfg.text.enabled = state.mode === 'text';
        state.cfg.logo.enabled = state.mode === 'logo';
        if (state.mode === 'logo' && !state.cfg.logo.image) {
          toast('先选择一张 Logo 图片', '', 2200);
        }
        syncControls();
      });
    });

    /* --- 折叠面板 --- */
    $$('[data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var g = $('#' + btn.getAttribute('data-toggle'));
        var open = g.getAttribute('data-open') !== 'false';
        g.setAttribute('data-open', open ? 'false' : 'true');
      });
    });

    /* --- 文字参数 --- */
    var t = state.cfg.text;
    $('#textContent').addEventListener('input', function () {
      t.content = this.value;
      renderPreview();
    });

    bindSelect('textFont', function (v) { t.font = v; });

    bindRange('textSize', function (v) {
      t.sizePct = v;
      $('#textSizeVal').textContent = trimNum(v) + '%';
    });
    bindRange('textOpacity', function (v) {
      t.opacity = v / 100;
      $('#textOpacityVal').textContent = v + '%';
    });
    bindRange('textRotate', function (v) {
      t.rotate = v;
      $('#textRotateVal').textContent = v + '°';
    });
    bindRange('strokeWidth', function (v) {
      t.strokeWidthPct = v;
      $('#strokeWidthVal').textContent = v + '%';
    });

    $('#textColor').addEventListener('input', function () {
      t.color = this.value;
      $$('#textSwatches .swatch').forEach(function (s) {
        s.classList.toggle('active', s.getAttribute('data-color').toLowerCase() === t.color.toLowerCase());
      });
      updateBgStatus();
      renderPreview();
    });
    $$('#textSwatches .swatch').forEach(function (s) {
      s.addEventListener('click', function () {
        t.color = s.getAttribute('data-color');
        $('#textColor').value = t.color;
        $$('#textSwatches .swatch').forEach(function (x) { x.classList.remove('active'); });
        s.classList.add('active');
        updateBgStatus();
        renderPreview();
      });
    });

    bindCheck('textBold', function (v) { t.bold = v; });
    bindCheck('textStroke', function (v) {
      t.stroke = v;
      $('#strokeRow').hidden = !v;
      updateBgStatus();
    });
    $('#strokeColor').addEventListener('input', function () {
      t.strokeColor = this.value;
      renderPreview();
    });

    /* --- 位置 / 平铺 / 边距（作用于当前模式） --- */
    $$('#posGrid .pos-cell').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pos = btn.getAttribute('data-pos');
        activeCfg().pos = pos;
        state.lastPos = pos;
        syncControls();
      });
    });

    $('#tileToggle').addEventListener('click', function () {
      var c = activeCfg();
      if (c.pos === 'tile') {
        c.pos = state.lastPos && state.lastPos !== 'tile' ? state.lastPos : 'br';
      } else {
        state.lastPos = c.pos;
        c.pos = 'tile';
      }
      syncControls();
    });

    bindRange('tileGap', function (v) {
      activeCfg().tileGapPct = v;
      $('#tileGapVal').textContent = v + '%';
    });
    bindRange('tileRotate', function (v) {
      if (state.mode === 'text') state.cfg.text.tileRotate = v;
      else state.cfg.logo.rotate = v;
      $('#tileRotateVal').textContent = v + '°';
    });
    bindRange('margin', function (v) {
      activeCfg().marginPct = v;
      $('#marginVal').textContent = trimNum(v) + '%';
    });

    /* --- Logo --- */
    var logoInput = $('#logoInput');
    $('#logoDrop').addEventListener('click', function () { logoInput.click(); });
    $('#logoDrop').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logoInput.click(); }
    });

    logoInput.addEventListener('change', function () {
      var f = logoInput.files && logoInput.files[0];
      logoInput.value = '';
      if (!f) return;
      decodeImage(f).then(function (res) {
        state.cfg.logo.image = res.img;
        state.cfg.logo.url = res.url;
        state.cfg.logo.name = f.name;
        $('#logoPreview').src = res.url;
        $('#logoDrop').classList.add('has-logo');
        $('#logoName').textContent = f.name;
        state.cfg.logo.enabled = state.mode === 'logo';
        syncControls();
        toast('Logo 已就位', 'ok');
      }).catch(function (err) {
        toast('Logo 加载失败：' + err.message, 'error');
      });
    });

    bindRange('logoSize', function (v) {
      state.cfg.logo.sizePct = v;
      $('#logoSizeVal').textContent = v + '%';
    });
    bindRange('logoOpacity', function (v) {
      state.cfg.logo.opacity = v / 100;
      $('#logoOpacityVal').textContent = v + '%';
    });
    bindRange('logoRotate', function (v) {
      state.cfg.logo.rotate = v;
      $('#logoRotateVal').textContent = v + '°';
    });

    /* --- 证件照换底色 --- */
    var bgSwatchHost = $('#bgSwatches');
    (window.BgReplace ? BgReplace.PRESETS : []).forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.title = p.name + ' ' + p.color;
      btn.setAttribute('data-color', p.color);
      btn.setAttribute('aria-label', p.name + ' ' + p.color);
      btn.style.background = p.color;
      btn.addEventListener('click', function () {
        state.bg.color = p.color;
        syncBgControls();
        renderPreview();
      });
      bgSwatchHost.appendChild(btn);
    });

    $('#bgToggle').addEventListener('click', function () {
      state.bg.enabled = !state.bg.enabled;
      syncBgControls();
      renderPreview();
    });

    $('#bgColor').addEventListener('input', function () {
      state.bg.color = this.value;
      syncBgControls();
      renderPreview();
    });

    bindRange('bgTolerance', function (v) {
      state.bg.tolerance = v;
      $('#bgToleranceVal').textContent = v;
    });
    bindRange('bgFeather', function (v) {
      state.bg.feather = v;
      $('#bgFeatherVal').textContent = v;
    });

    /* --- 输出 --- */
    bindSelect('outFormat', function (v) {
      state.output.format = v;
      $('#qualityField').hidden = v !== 'jpeg';
      updateExifHint();
      renderPreview();
      renderMeta();
    });
    bindRange('outQuality', function (v) {
      state.output.quality = v;
      $('#outQualityVal').textContent = v;
    });
    bindSelect('outMaxSide', function (v) {
      state.output.maxSide = Number(v) || 0;
      renderMeta();
    });
    bindSelect('exifMode', function (v) {
      state.output.exif = v;
      updateExifHint();
    });

    /* --- 导出 --- */
    $('#exportBtn').addEventListener('click', exportCurrent);
    $('#batchBtn').addEventListener('click', exportAll);
    $('#shareBtn').addEventListener('click', function () {
      var item = state.items[state.active];
      if (!item) return;
      renderItemToBlob(item).then(function (res) {
        downloadBlob(res.blob, res.filename);
      }).catch(function (err) { toast(err.message, 'error'); });
    });

    /* --- 隐私说明 --- */
    var modal = $('#privacyModal');
    $('#privacyBtn').addEventListener('click', function () { modal.hidden = false; });
    $('#privacyClose').addEventListener('click', function () { modal.hidden = true; });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });

    /* --- 窗口尺寸变化 --- */
    window.addEventListener('resize', function () { renderPreview(); });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { renderPreview(); }, 300);
    });

    /* --- 分享按钮显隐 --- */
    if (IS_TOUCH_MOBILE && canShareFiles()) {
      $('#exportBtn').textContent = '分享 / 存到相册';
      $('#shareBtn').textContent = '直接下载';
      $('#shareBtn').hidden = false;
    } else {
      $('#exportBtn').textContent = '保存图片';
      $('#shareBtn').hidden = true;
    }

    syncControls();
    updateDockLabels();

    // Service Worker：离线可用
    if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(function (e) {
        console.warn('Service Worker 注册失败（不影响使用）', e);
      });
    }
  }

  function updateDockLabels() {
    var n = state.items.length;
    var batch = $('#batchBtn');
    batch.textContent = n > 1 ? '导出全部 ' + n + ' 张' : '导出全部';
    batch.disabled = n === 0 || state.busy;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露给自动化测试
  window.__app = {
    state: state,
    addFiles: addFiles,
    activate: activate,
    exportAll: exportAll,
    exportCurrent: exportCurrent,
    renderItemToBlob: renderItemToBlob,
    computeExportSize: computeExportSize,
    syncControls: syncControls,
    LIMITS: LIMITS,
    canShareFiles: canShareFiles
  };
})();
