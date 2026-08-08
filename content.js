// AI 网页翻译 — 内容脚本（按需注入，幂等）
// 职责：抽取整页可见文本 → 发送后台翻译 → 回填译文 → 支持还原原文
(() => {
  // 顶部防重复注入守卫
  if (window.__aifLoaded) return;
  window.__aifLoaded = true;

  'use strict';

  // 需要跳过的元素：脚本/样式/输入控件/代码块/已声明不翻译/本扩展横幅
  const SKIP_SELECTOR = 'script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,svg,math,[translate="no"],.notranslate,.aif-banner';
  const BANNER_CLASS = 'aif-banner'; // 横幅 class 前缀 aif-，自身不会被再次收集

  // 状态：原始文本 → 节点数组；id → 原始文本（内存中保存，刷新页面自然失效）
  const state = { textToNodes: new Map(), idToText: new Map(), idSeq: 0, banner: null, translated: false };

  // 收集可见文本节点：TreeWalker + 过滤 + 按文本去重
  function collectSegments() {
    const root = document.body || document.documentElement;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const collected = [];
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
    // 去重：相同文本只发一条，映射 文本→节点数组，为每个唯一文本分配 id n0, n1, ...
    const segments = [];
    for (const { node, text } of collected) {
      const list = state.textToNodes.get(text);
      if (list) {
        list.push(node);
      } else {
        state.textToNodes.set(text, [node]);
        const id = 'n' + state.idSeq++;
        state.idToText.set(id, text);
        segments.push({ id, text });
      }
    }
    return segments;
  }

  // 顶部进度横幅（绝对定位 top:12px right:12px，z-index 最大）
  function showBanner(text) {
    removeBanner();
    const div = document.createElement('div');
    div.className = BANNER_CLASS;
    div.textContent = text;
    Object.assign(div.style, {
      position: 'absolute',
      top: '12px',
      right: '12px',
      zIndex: '2147483647',
      padding: '8px 14px',
      background: 'rgba(30, 30, 30, .92)',
      color: '#fff',
      fontSize: '13px',
      lineHeight: '1.4',
      borderRadius: '6px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 2px 8px rgba(0, 0, 0, .25)',
      pointerEvents: 'auto'
    });
    document.documentElement.appendChild(div);
    state.banner = div;
    return div;
  }

  function removeBanner() {
    if (state.banner) {
      state.banner.remove();
      state.banner = null;
    }
  }

  // 错误横幅：显示错误并可点击关闭
  function showBannerError(text) {
    const div = showBanner('✕ ' + text);
    div.style.cursor = 'pointer';
    div.title = '点击关闭';
    div.addEventListener('click', removeBanner);
  }

  // 把译文写回对应的文本节点
  function applyTranslations(segments, translations) {
    let applied = 0;
    for (const seg of segments) {
      const t = translations[seg.id];
      if (t == null) continue;
      const nodes = state.textToNodes.get(state.idToText.get(seg.id));
      if (!nodes) continue;
      for (const node of nodes) node.nodeValue = t;
      applied++;
    }
    return applied;
  }

  // 用保存的原始文本还原所有节点
  function restore() {
    let count = 0;
    for (const [text, nodes] of state.textToNodes) {
      for (const node of nodes) {
        if (node.nodeValue !== text) {
          node.nodeValue = text;
          count++;
        }
      }
    }
    return count;
  }

  // 整页翻译流程
  async function translatePage() {
    // 已翻译过则先还原，避免对译文二次翻译
    if (state.translated) restore();
    // 重新收集前清空旧状态（id 从头分配，保证本次全局唯一）
    state.textToNodes.clear();
    state.idToText.clear();
    state.idSeq = 0;

    const segments = collectSegments();
    const total = segments.length;
    if (!total) {
      showBannerError('未找到可翻译的文本');
      return { ok: false, error: '未找到可翻译的文本', count: 0 };
    }

    const banner = showBanner(`AI翻译中… 0/${total}`);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'TRANSLATE_PAGE', segments });
    } catch (e) {
      showBannerError('与后台通信失败：' + (e && e.message ? e.message : e));
      return { ok: false, error: e && e.message ? e.message : String(e), count: 0 };
    }
    if (!res || !res.ok) {
      showBannerError((res && res.error) || '翻译失败');
      return { ok: false, error: (res && res.error) || '翻译失败', count: 0 };
    }

    const translations = res.translations || {};
    const applied = applyTranslations(segments, translations);
    const failed = total - applied;
    const batchErrors = (res.errors && res.errors.length) || 0;
    // 全部失败：按错误处理，不显示"翻译完成"
    if (applied === 0 && failed > 0 && batchErrors > 0) {
      const msg = (res.errors[0] && res.errors[0].error) || '全部批次失败';
      showBannerError('翻译失败：' + msg);
      return { ok: false, error: msg, count: total };
    }
    if (applied > 0) state.translated = true;
    const errText = batchErrors ? `，${batchErrors} 批失败` : '';
    banner.textContent = failed ? `翻译完成（${applied}/${total}${errText}）` : `翻译完成（${total} 段）`;
    setTimeout(removeBanner, 1500);
    return { ok: true, translations, error: failed ? `有 ${failed} 段未翻译成功` : null, count: total };
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
    if (msg.type === 'RESTORE') {
      const count = restore();
      sendResponse({ ok: true, count });
      return true;
    }
  });
})();