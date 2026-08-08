/**
 * sculpture.js — 设置页背景 3D 数学雕塑（弹簧面板）
 * 纯原生 JS，IIFE，无任何外部依赖、不引库。
 *
 * 在 <canvas id="bg-scene"> 上绘制一个由 150 块「叠卡片」组成、沿弹簧曲线
 * 循环流动的 3D 雕塑：白色玻璃质感、固定全屏背景、跟随鼠标旋转视角、
 * 页面隐藏时自动暂停 rAF。
 */
(function () {
  'use strict';

  /* ======================= 常量 ======================= */
  var PANELS = 150;          // 面板数量 N
  var SPRING_RADIUS = 8;     // 弹簧半径(放大，视觉更突出)
  var COILS = 2;             // 弹簧圈数
  var SPRING_HEIGHT = 30;    // 弹簧总高度（y 范围 -15 ~ 15）
  var CAMERA_DIST = 36;      // 相机距离(更近，透视更强、体量更大)
  var FOV = 46;              // 透视视场常数：proj = FOV / (FOV + 深度)
  var BASE_TILT = -0.62;   // 基础俯仰：让弹簧立起、冲向观众（更立体更突出）
  var BASE_ROLL = 0.35;    // 基础滚转：画面斜切，更有动感
  var ROT_Y_SPEED = 0.16;    // 基础绕 Y 自转速度（rad/s）
  var MOUSE_Y_RANGE = 0.6;   // 鼠标 X 控制绕 Y 的目标偏移范围（±0.6 rad）
  var MOUSE_X_RANGE = 0.35;  // 鼠标 Y 控制绕 X 的俯仰范围（±0.35 rad）
  var LERP = 0.06;           // 鼠标视角平滑系数
  var FILL_ALPHA = 0.62;     // 主填充透明度（更实，更醒目）
  var GLOW_ALPHA = 0.85;     // 顶部/近处面板提亮透明度
  var STROKE = 'rgba(0,120,212,.55)';  // Fluent 蓝描边（更突出）

  /* ======================= 状态 ======================= */
  var canvas = null;         // 画布元素
  var ctx = null;            // 2D 上下文
  var rafId = 0;             // requestAnimationFrame id
  var running = false;       // 是否正在播放动画
  var time = 0;              // 累计时间（每帧 +0.016）
  var rotY = 0;              // 基础绕 Y 自转角度
  var mouseY = 0;            // 鼠标绕 Y 偏移（平滑逼近中）
  var mouseX = 0;            // 鼠标绕 X 俯仰（平滑逼近中）
  var targetY = 0;           // 鼠标绕 Y 的目标偏移
  var targetX = 0;           // 鼠标绕 X 的目标俯仰
  var width = 0, height = 0; // 画布 CSS 像素尺寸
  var dpr = 1;               // devicePixelRatio
  var cx = 0, cy = 0;        // 屏幕中心
  var s = 1;                 // 缩放系数（与画布高度相关）
  var started = false;       // 是否已完成初始化

  /* ======================= 工具 ======================= */
  // 圆角矩形路径（不依赖 ctx.roundRect，兼容性更好；绘制只用路径，无阴影/滤镜）
  function roundRectPath(x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    if (rr <= 0) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  /* ======================= 初始化 ======================= */
  // 初始化画布与事件监听（幂等）
  function init() {
    if (started) return;
    started = true;
    canvas = document.getElementById('bg-scene');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    // 固定全屏背景、不拦截鼠标事件（仅由 window 的 mousemove 获取鼠标位置）
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '-1';   // 置于页面内容之下、页面背景之上
    canvas.style.display = 'block';

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);
    document.addEventListener('visibilitychange', onVisibility);
  }

  // 按 devicePixelRatio 适配画布尺寸，随窗口 resize 重设
  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 用 CSS 像素坐标绘制
    cx = width / 2;
    cy = height / 2;
    s = height / 15; // 缩放取画布高度相关（放大，占据画面主体）
  }

  /* ======================= 交互 ======================= */
  // 仅监听 window 的 mousemove 获取鼠标位置（画布本身 pointer-events: none）
  function onMouseMove(e) {
    var nx = (e.clientX / Math.max(width, 1)) * 2 - 1; // 归一化到 [-1, 1]
    var ny = (e.clientY / Math.max(height, 1)) * 2 - 1;
    targetY = nx * MOUSE_Y_RANGE; // 鼠标 X → 绕 Y 目标偏移
    targetX = ny * MOUSE_X_RANGE; // 鼠标 Y → 绕 X 目标俯仰
  }

  /* ======================= 生命周期 ======================= */
  // 页面隐藏时暂停 rAF，恢复时继续
  function onVisibility() {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  }

  // 幂等启动：重复调用不会重复创建 rAF
  function start() {
    if (running) return;
    if (!started) init();
    if (!ctx) return; // 未找到画布则放弃
    running = true;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ======================= 主循环 ======================= */
  function frame() {
    if (!running) return;
    time += 0.016;                               // 每帧固定步进
    rotY += ROT_Y_SPEED * 0.016;                 // 绕 Y 轴缓慢自转
    mouseY += (targetY - mouseY) * LERP;         // lerp 平滑逼近鼠标目标
    mouseX += (targetX - mouseX) * LERP;
    draw();
    rafId = requestAnimationFrame(frame);
  }

  /* ======================= 绘制 ======================= */
  function draw() {
    ctx.clearRect(0, 0, width, height);

    var totalY = rotY + mouseY; // 最终绕 Y 角度（自转 + 鼠标偏移）
    var totalX = BASE_TILT + mouseX; // 基础俯仰 + 鼠标俯仰
    var cosY = Math.cos(totalY), sinY = Math.sin(totalY);
    var cosR = Math.cos(BASE_ROLL), sinR = Math.sin(BASE_ROLL); // 绕 Z 基础滚转
    var cosX = Math.cos(totalX), sinX = Math.sin(totalX);

    // 第一步：计算每个面板的 3D 位置并投影，记录深度用于排序
    var panels = [];
    var minDepth = Infinity, maxDepth = -Infinity;
    var i, p;
    for (i = 0; i < PANELS; i++) {
      var baseT = i / PANELS;
      var t = (baseT + time * 0.003) % 1;   // 弹簧上的流动位置
      var y = (0.5 - t) * SPRING_HEIGHT;    // 沿高度方向分布
      var angle = t * Math.PI * 2 * COILS;  // 弹簧缠绕角
      var x = Math.sin(angle) * SPRING_RADIUS;
      var z = Math.cos(angle) * SPRING_RADIUS;
      var twist = t * Math.PI * 4 - time * 0.005; // 面板自身扭转
      // 两端缩到 0，形成无缝循环
      var scale = t < 0.08 ? t / 0.08 : (t > 0.92 ? (1 - t) / 0.08 : 1);

      // 绕 Y 旋转（自转 + 鼠标偏移）
      var xr = x * cosY + z * sinY;
      var zr = -x * sinY + z * cosY;
      // 绕 X 旋转（俯仰）
      var yr = y * cosX - zr * sinX;
      var zr2 = y * sinX + zr * cosX;

      // 透视投影：相机位于 z = -CAMERA_DIST，深度 = 旋转后 z + 相机距离
      var depth = zr2 + CAMERA_DIST;
      var proj = FOV / (FOV + depth);
      var xScreen = cx + xr * proj * s;
      var yScreen = cy + yr * proj * s;
      // 绕屏幕中心 Z 轴滚转（让雕塑斜切、更动感）
      var dx = xScreen - cx, dy = yScreen - cy;
      xScreen = cx + dx * cosR - dy * sinR;
      yScreen = cy + dx * sinR + dy * cosR;

      if (depth < minDepth) minDepth = depth;
      if (depth > maxDepth) maxDepth = depth;

      panels.push({
        x: xScreen,
        y: yScreen,
        w: 4.2 * proj * s,          // 面板屏幕宽度（放大）
        h: 2.4 * scale * proj * s,  // 面板屏幕高度（含 scale 渐隐）
        twist: twist,
        scale: scale,
        depth: depth
      });
    }

    // 第二步：按投影后深度从远到近排序（远处先画，近处后画 → 叠卡片效果）
    panels.sort(function (a, b) { return b.depth - a.depth; });

    // 第三步：逐个绘制圆角小矩形
    var depthSpan = Math.max(maxDepth - minDepth, 1e-6);
    ctx.strokeStyle = STROKE;
    for (i = 0; i < panels.length; i++) {
      p = panels[i];
      if (p.scale < 0.001) continue; // 两端几乎消失，跳过省开销
      // 近处/中间面板提亮（按 scale 与深度），制造 glossy 感
      var near = (p.depth - minDepth) / depthSpan; // 0 远 → 1 近
      var glow = Math.min(p.scale, near);
      var alpha = FILL_ALPHA + (GLOW_ALPHA - FILL_ALPHA) * glow;
      ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.twist); // 面板的 2D 投影旋转
      ctx.beginPath();
      roundRectPath(-p.w / 2, -p.h / 2, p.w, p.h, Math.min(8, p.w * 0.2, p.h * 0.2));
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ======================= 对外接口 ======================= */
  // 幂等启动：重复调用不会重复创建 rAF
  window.__sculptureStart = start;
  window.__sculptureStop = stop;

  // 脚本位于 </body> 前，DOM 已就绪，加载后立即自启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
  } else {
    start();
  }
})();