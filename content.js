// AI 网页翻译 — 内容脚本（按需注入，幂等）
// 职责：抽取整页可见文本 → 请求后台翻译 → 三模式呈现（原文/译文/双语）→ 缓存应用
(() => {
  // 防重复注入守卫
  if (window.__aifLoaded) return;
  window.__aifLoaded = true;

  'use strict';

  // 需要跳过的元素：脚本/样式/输入控件/代码块/已声明不翻译/本扩展注入内容
  const SKIP_SELECTOR = 'script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,svg,math,[translate="no"],.notranslate,.aif-banner,.aif-bilingual,.aif-orig,.aif-tr';
  const BANNER_CLASS = 'aif-banner'; // 横幅 class 前缀 aif-，自身不会被再次收集

  // 状态：nodes 每项对应一个文本节点；textId 原文 → segment id
  const state = {
    nodes: [],          // [{ node, original, translated, wrapped }]
    textId: new Map(),  // 原文文本 → id（收集时重建）
    idSeq: 0,           // id 序列（n0, n1, ...）
    mode: 'original',   // 当前呈现模式
    banner: null,       // 横幅元素
    bannerMode: null,   // 横幅状态：progress / done / error
    bannerTimer: null,  // 自动移除定时器
    styling: false      // 是否已注入扩展样式
  };

  // 读取配置（合并默认值；defaultMode/keepCache/autoApplyCache 为扩展新增字段）
  async function getConfig() {
    const defaults = {
      apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
      targetLang: '简体中文', chunkChars: 6000, concurrency: 3,
      defaultMode: 'translated', keepCache: true, autoApplyCache: false
    };
    const stored = await chrome.storage.local.get(defaults);
    return { ...defaults, ...stored };
  }

  // 页面缓存键：origin + pathname（忽略查询参数与锚点）
  function pageKey() {
    return location.origin + location.pathname;
  }

  // FNV-1a 32bit 指纹：所有 segments 文本按序以 \u0000 拼接后计算，返回 8 位 hex
  function fingerprint(segments) {
    let hash = 0x811c9dc5;
    const data = segments.map((s) => s.text).join('\u0000');
    for (let i = 0; i < data.length; i++) {
      hash ^= data.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  // 收集可见文本节点：TreeWalker + 过滤 + 按文本去重；同时重建 state.nodes
  function collectSegments() {
    state.nodes = [];
    state.textId = new Map();
    state.idSeq = 0;
    const root = document.body || document.documentElement;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const collected = []; // 全部候选节点（未去重）
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(SKIP_SELECTOR)) continue; // 代码/输入/隐藏标记等
      const text = node.nodeValue || '';
      if (text.length < 2 || !text.trim()) continue; // 纯空白或过短
      if (!/\p{L}/u.test(text)) continue; // 不含字母（跳过纯数字/纯符号）
      if (parent.closest('[hidden],[aria-hidden="true"]')) continue; // 廉价跳过显式隐藏
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue; // 隐藏元素
      collected.push({ node, text });
    }
    // 去重：相同文本只发一条并分配 id n0, n1, ...；state.nodes 保留全部节点
    const segments = [];
    for (const { node, text } of collected) {
      let id = state.textId.get(text);
      if (id == null) {
        id = 'n' + state.idSeq++;
        state.textId.set(text, id);
        segments.push({ id, text });
      }
      state.nodes.push({ node, original: text, translated: null, wrapped: null });
    }
    return segments;
  }

  // 注入扩展样式（仅一次；class 前缀 aif- 避免被收集）
  function ensureStyle() {
    if (state.styling) return;
    state.styling = true;
    const style = document.createElement('style');
    style.id = 'aif-style';
    style.textContent = [
      ".aif-tr{color:#6a737d;font-size:.92em;line-height:1.5}",
      ".aif-banner{position:fixed;top:12px;right:12px;z-index:2147483647;padding:10px 16px;background:rgba(30,30,30,.95);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);animation:aifSlideIn .25s ease-out}",
      ".aif-banner .aif-progress-track{margin-top:6px;height:4px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}",
      ".aif-banner .aif-progress-fill{height:100%;width:0;border-radius:2px;background:#4caf50;transition:width .15s ease}",
      ".aif-banner.aif-error{cursor:pointer}",
      "@keyframes aifSlideIn{from{transform:translateX(20px);opacity:0}to{transform:none;opacity:1}}"
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  // 填充译文：对每个 state.nodes 项填 translated；未返回译文的不动
  function applyTranslations(translations) {
    let applied = 0;
    for (const item of state.nodes) {
      const id = state.textId.get(item.original);
      const t = id != null ? translations[id] : null;
      if (t == null) continue;
      item.translated = t;
      applied++;
    }
    return applied;
  }

  // 还原单个节点：用原 node 换回包裹元素
  function unwrapItem(item) {
    if (item.wrapped) {
      item.wrapped.replaceWith(item.node);
      item.wrapped = null;
    }
  }

  // 三模式呈现：original 原文 / translated 译文 / bilingual 双语
  function applyMode(mode) {
    if (mode !== 'translated' && mode !== 'bilingual') mode = 'original';
    if (mode === 'bilingual') ensureStyle();
    for (const item of state.nodes) {
      if (mode === 'bilingual') {
        if (item.translated == null) { unwrapItem(item); continue; } // 无译文不包裹
        if (!item.wrapped) {
          // 首次包裹：<span.aif-bilingual><span.aif-orig>原文</span><br><span.aif-tr>译文</span></span>
          const wrapper = document.createElement('span');
          wrapper.className = 'aif-bilingual';
          const orig = document.createElement('span');
          orig.className = 'aif-orig';
          orig.textContent = item.original;
          const br = document.createElement('br');
          const tr = document.createElement('span');
          tr.className = 'aif-tr';
          tr.textContent = item.translated;
          wrapper.append(orig, br, tr);
          item.node.replaceWith(wrapper);
          item.wrapped = wrapper;
        } else {
          // 已包裹：只更新译文文本
          const tr = item.wrapped.querySelector('.aif-tr');
          if (tr) tr.textContent = item.translated;
        }
      } else {
        // original / translated：先还原包裹，再写文本
        unwrapItem(item);
        item.node.nodeValue = mode === 'translated' && item.translated != null ? item.translated : item.original;
      }
    }
    state.mode = mode;
    return mode;
  }

  // 创建横幅骨架（右上角固定 + 滑入动画 + 进度条）
  function createBanner() {
    removeBanner();
    ensureStyle();
    const div = document.createElement('div');
    div.className = BANNER_CLASS;
    div.innerHTML = '<div class="aif-progress-text"></div><div class="aif-progress-track"><div class="aif-progress-fill"></div></div>';
    document.documentElement.appendChild(div);
    state.banner = div;
    return div;
  }

  // 更新横幅文案与进度条（fill 宽度 = done/total*100%）
  function setBanner(text, done, total) {
    if (!state.banner) return;
    const textEl = state.banner.querySelector('.aif-progress-text');
    if (textEl) textEl.textContent = text;
    const fill = state.banner.querySelector('.aif-progress-fill');
    if (fill) fill.style.width = (total > 0 ? (done / total) * 100 : 0) + '%';
  }

  // 移除横幅（含自动移除定时器）
  function removeBanner() {
    if (state.bannerTimer) { clearTimeout(state.bannerTimer); state.bannerTimer = null; }
    if (state.banner) { state.banner.remove(); state.banner = null; }
    state.bannerMode = null;
  }

  // 进度横幅（翻译中）
  function showProgress(text, done, total) {
    createBanner();
    state.bannerMode = 'progress';
    setBanner(text, done, total);
  }

  // 完成横幅：1.5s 后自动移除
  function showDone(text) {
    createBanner();
    state.bannerMode = 'done';
    const track = state.banner.querySelector('.aif-progress-track');
    if (track) track.style.display = 'none';
    setBanner(text, 0, 0);
    state.bannerTimer = setTimeout(removeBanner, 1500);
  }

  // 错误横幅：显示错误并可点击关闭
  function showBannerError(text) {
    createBanner();
    state.bannerMode = 'error';
    state.banner.classList.add('aif-error');
    const track = state.banner.querySelector('.aif-progress-track');
    if (track) track.style.display = 'none';
    setBanner('✕ ' + text, 0, 0);
    state.banner.title = '点击关闭';
    state.banner.addEventListener('click', removeBanner);
  }

  // 保存页面缓存（受 keepCache 控制，含站点级覆盖）
  async function saveCache(cfg, segments, translations) {
    const stored = await chrome.storage.local.get({ siteSettings: {} });
    const site = (stored.siteSettings || {})[location.hostname] || {};
    const keep = site.keepCache != null ? site.keepCache : cfg.keepCache;
    if (!keep) return;
    const store = await chrome.storage.local.get({ pageCache: {} });
    const cache = store.pageCache || {};
    cache[pageKey()] = {
      fingerprint: fingerprint(segments),
      url: location.href,
      title: document.title,
      segments,
      translations,
      ts: Date.now()
    };
    await chrome.storage.local.set({ pageCache: cache });
  }

  // 整页翻译流程
  async function translatePage() {
    // 先还原现有呈现（卸载包裹、恢复原文），避免对译文二次翻译
    if (state.nodes.length) applyMode('original');

    const cfg = await getConfig();
    const segments = collectSegments();
    const total = segments.length;
    if (!total) {
      showBannerError('未找到可翻译的文本');
      return { ok: false, error: '未找到可翻译的文本', count: 0 };
    }

    showProgress('AI翻译中 0/' + total, 0, total);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_PAGE',
        segments,
        pageKey: pageKey(),
        url: location.href,
        title: document.title
      });
    } catch (e) {
      showBannerError('与后台通信失败：' + (e && e.message ? e.message : e));
      return { ok: false, error: e && e.message ? e.message : String(e), count: 0 };
    }
    if (!res || !res.ok) {
      showBannerError((res && res.error) || '翻译失败');
      return { ok: false, error: (res && res.error) || '翻译失败', count: 0 };
    }

    const translations = res.translations || {};
    applyTranslations(translations);
    // 以段为单位统计成功数（重复文本的多个节点共享同一段 id）
    let applied = 0;
    for (const seg of segments) if (translations[seg.id] != null) applied++;
    const failed = total - applied;
    const batchErrors = (res.errors && res.errors.length) || 0;
    // 全部失败：按错误处理，不显示"翻译完成"
    if (applied === 0 && failed > 0 && batchErrors > 0) {
      const msg = (res.errors[0] && res.errors[0].error) || '全部批次失败';
      showBannerError('翻译失败：' + msg);
      return { ok: false, error: msg, count: total };
    }
    if (applied > 0) {
      await saveCache(cfg, segments, translations); // 成功后存缓存
      applyMode(cfg.defaultMode); // 按默认模式呈现
    }
    const errText = batchErrors ? '，' + batchErrors + ' 批失败' : '';
    showDone(failed ? '翻译完成（' + applied + '/' + total + errText + '）' : '翻译完成（' + total + ' 段）');
    return { ok: true, translations, error: failed ? '有 ' + failed + ' 段未翻译成功' : null, count: total };
  }

  // 自动应用缓存：页面加载时执行一次（非 http/https 直接返回）
  async function init() {
    if (!/^https?:/i.test(location.protocol)) return; // 非 http/https 不处理
    const cfg = await getConfig();
    const stored = await chrome.storage.local.get({ siteSettings: {} });
    const site = (stored.siteSettings || {})[location.hostname] || {};
    const autoApply = site.autoApply != null ? site.autoApply : cfg.autoApplyCache;
    if (!autoApply) return; // 默认关闭：零开销

    const segments = collectSegments();
    if (!segments.length) return;
    const fp = fingerprint(segments);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', pageKey: pageKey(), fingerprint: fp });
    } catch (e) {
      return; // 后台暂不支持缓存时静默跳过
    }
    if (res && res.hit && res.cache && res.cache.translations) {
      // 命中：应用译文并按默认模式呈现
      applyTranslations(res.cache.translations);
      applyMode(cfg.defaultMode);
      showDone('已应用缓存译文');
    } else {
      // 未命中：网页已变更，自动重新翻译
      translatePage();
    }
  }

  // 消息监听
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'TRANSLATE_PAGE') {
      translatePage().then(sendResponse).catch((e) => {
        showBannerError(e && e.message ? e.message : String(e));
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e), count: 0 });
      });
      return true; // 异步 sendResponse，保持通道
    }
    if (msg.type === 'SET_MODE') {
      const mode = msg.mode === 'translated' || msg.mode === 'bilingual' ? msg.mode : 'original';
      applyMode(mode);
      // 持久化默认模式
      chrome.storage.local.set({ defaultMode: mode }).catch(() => {});
      sendResponse({ ok: true, mode });
      return true;
    }
    if (msg.type === 'RESTORE') {
      const count = state.nodes.length;
      applyMode('original');
      // 清空节点与译文标记
      state.nodes = [];
      state.textId.clear();
      sendResponse({ ok: true, count });
      return true;
    }
    if (msg.type === 'GET_MODE') {
      sendResponse({ mode: state.mode });
      return true;
    }
    if (msg.type === 'TRANSLATE_PROGRESS') {
      // 更新进度横幅：仅当处于翻译中状态
      if (state.banner && state.bannerMode === 'progress' && typeof msg.done === 'number' && typeof msg.total === 'number') {
        setBanner('AI翻译中 ' + msg.done + '/' + msg.total, msg.done, msg.total);
      }
    }
  });

  // 页面加载时执行一次自动应用缓存（幂等守卫保证不重复）
  init();
})();