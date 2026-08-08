// AI 网页翻译 — 弹窗逻辑（翻译 / 还原 / 显示模式 / token 用量）
const statusEl = document.getElementById('status');
const tokenEl = document.getElementById('token-usage');
const modeButtons = Array.from(document.querySelectorAll('.seg[data-mode]'));

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

// 高亮当前显示模式按钮
function highlightMode(mode) {
  modeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

// 获取当前活动标签页
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 确保 content.js 已注入（幂等：内容脚本自带防重复守卫）
async function ensureInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// 统一入口：校验标签页可注入 → 注入 → 执行回调
async function withTab(fn) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('未找到当前标签页', true);
    return;
  }
  if (!/^https?:/.test(tab.url || '')) {
    setStatus('当前页面不支持注入（仅限 http/https）', true);
    return;
  }
  try {
    await ensureInjected(tab.id);
  } catch (e) {
    setStatus('无法注入脚本，请刷新页面后重试', true);
    return;
  }
  await fn(tab);
}

// 发送消息到当前标签页（失败容错）
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return null;
  }
}

// 发送消息到后台（失败容错）
async function sendToBg(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return null;
  }
}

// 弹窗打开：读 GET_STATE → 高亮默认模式 → 校验可注入 → 注入 → 页面模式优先
async function init() {
  const state = await sendToBg({ type: 'GET_STATE' });
  // 按配置的 defaultMode 高亮（缺省为原文）
  highlightMode((state && state.config && state.config.defaultMode) || 'translated');
  // 应用亚克力模糊强度(与设置页同步)
  const blurPx = (state && state.config && state.config.acrylicBlur) || 40;
  document.documentElement.style.setProperty('--acrylic-blur', 'blur(' + blurPx + 'px) brightness(120%) saturate(80%)');
  // 底部显示 token 用量（后台暂无数据时显示 --）
  const usage = state && state.tokenUsage;
  if (usage && Number.isFinite(usage.total)) {
    tokenEl.textContent = '已用 tokens: ' + usage.total;
  } else {
    tokenEl.textContent = '已用 tokens: --';
  }
  // 校验标签页可注入 → 注入 → 页面当前模式优先（页面未实现 GET_MODE 时保持默认）
  await withTab(async (tab) => {
    const res = await sendToTab(tab.id, { type: 'GET_MODE' });
    if (res && res.mode) highlightMode(res.mode);
  });
}

// 模式切换：先高亮当前选择，再通知当前页面
modeButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    const label = btn.textContent.trim();
    highlightMode(mode);
    await withTab(async (tab) => {
      const res = await sendToTab(tab.id, { type: 'SET_MODE', mode });
      setStatus(res && res.ok === false ? (res.error || '切换失败') : `已切换为「${label}」模式`, res && res.ok === false);
    });
  });
});

document.getElementById('btn-translate').addEventListener('click', async () => {
  setStatus('处理中…');
  await withTab(async (tab) => {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      if (res && res.ok) {
        setStatus(`翻译完成（${res.count} 段）` + (res.error ? '，部分失败' : ''));
      } else {
        setStatus(res && res.error === 'native' ? '页面已是习惯语言，无需翻译' : ((res && res.error) || '翻译失败'), true);
      }
    } catch (e) {
      setStatus('通信失败：' + (e && e.message ? e.message : e), true);
    }
  });
});

document.getElementById('btn-restore').addEventListener('click', async () => {
  setStatus('还原中…');
  await withTab(async (tab) => {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE' });
      if (res && res.ok) setStatus('已还原原文');
      else setStatus((res && res.error) || '还原失败', true);
    } catch (e) {
      setStatus('通信失败：' + (e && e.message ? e.message : e), true);
    }
  });
});

document.getElementById('btn-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();