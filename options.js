// AI 网页翻译 — 设置页逻辑
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, isError, isOk) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : isOk ? ' ok' : '');
}

// 收集表单为配置对象
function collectForm() {
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    targetLang: $('targetLang').value.trim(),
    chunkChars: parseInt($('chunkChars').value, 10),
    concurrency: parseInt($('concurrency').value, 10)
  };
}

// 保存前合法性检查（数字字段）
function validate(cfg) {
  if (!cfg.baseUrl) return 'Base URL 不能为空';
  if (!cfg.model) return '模型不能为空';
  if (!cfg.targetLang) return '目标语言不能为空';
  if (!Number.isInteger(cfg.chunkChars) || cfg.chunkChars < 100 || cfg.chunkChars > 20000) return '每批字符数需为 100~20000 的整数';
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 10) return '并发数需为 1~10 的整数';
  return null;
}

// 确保自定义 Base URL 已获得网络权限（默认 api.deepseek.com 已在 manifest 授权）
async function ensureHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin;
    const has = await chrome.permissions.contains({ origins: [origin + '/*'] });
    if (!has) {
      const ok = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!ok) setStatus('已保存，但未授予该 Base URL 的访问权限，翻译可能失败', true);
    }
  } catch (e) { /* 非标准 URL 时忽略 */ }
}

// 从后台读取配置并填充表单
async function load() {
  const cfg = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  $('apiKey').value = cfg.apiKey || '';
  $('baseUrl').value = cfg.baseUrl || 'https://api.deepseek.com';
  $('model').value = cfg.model || 'deepseek-chat';
  $('targetLang').value = cfg.targetLang || '简体中文';
  $('chunkChars').value = cfg.chunkChars || 6000;
  $('concurrency').value = cfg.concurrency || 3;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cfg = collectForm();
  const err = validate(cfg);
  if (err) { setStatus(err, true); return; }
  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: cfg });
  await ensureHostPermission(cfg.baseUrl);
  setStatus('已保存', false, true);
});

$('btn-test').addEventListener('click', async () => {
  const cfg = collectForm();
  const err = validate(cfg);
  if (err) { setStatus(err, true); return; }
  if (!cfg.apiKey) { setStatus('请先填写 API Key', true); return; }
  setStatus('测试中…');
  // 先保存当前表单，再让后台用该配置测试
  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: cfg });
  await ensureHostPermission(cfg.baseUrl);
  const res = await chrome.runtime.sendMessage({ type: 'TEST_API' });
  if (res && res.ok) setStatus('连接成功 ✔', false, true);
  else setStatus('连接失败：' + ((res && res.error) || '未知错误'), true);
});

load();