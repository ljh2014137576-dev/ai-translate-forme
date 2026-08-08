// AI 网页翻译 — 弹窗逻辑
const statusEl = document.getElementById('status');

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : '');
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

document.getElementById('btn-translate').addEventListener('click', async () => {
  setStatus('处理中…');
  await withTab(async (tab) => {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      if (res && res.ok) {
        setStatus(`翻译完成（${res.count} 段）` + (res.error ? '，部分失败' : ''));
      } else {
        setStatus((res && res.error) || '翻译失败', true);
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