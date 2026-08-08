// AI 网页翻译 — 设置页逻辑（配置 / 默认模式 / 缓存 / 站点规则 / token 用量）
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, isError, isOk) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : isOk ? ' ok' : '');
}

// 统一后台通信：全部 await 并容错（后台未实现时返回 null）
async function sendMsg(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return null;
  }
}

// 本地镜像：站点规则 / 页面缓存 / token 用量（后台未就绪时仍可展示与操作）
let siteSettings = {};
let pageCache = {};
let tokenUsage = { prompt: 0, completion: 0, total: 0, requests: 0 };

// 转义 HTML，防止站点名/URL 破坏结构
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 收集表单为配置对象（含默认模式与缓存开关）
function collectForm() {
  const mode = document.querySelector('input[name="defaultMode"]:checked');
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    targetLang: $('targetLang').value.trim(),
    chunkChars: parseInt($('chunkChars').value, 10),
    concurrency: parseInt($('concurrency').value, 10),
    defaultMode: mode ? mode.value : 'translated',
    keepCache: $('keepCache').checked,
    autoApplyCache: $('autoApplyCache').checked
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

// 渲染站点规则列表（host + autoApply + keepCache + 删除）
function renderSiteSettings() {
  const box = $('site-list');
  box.innerHTML = '';
  const hosts = Object.keys(siteSettings);
  if (!hosts.length) {
    box.innerHTML = '<div class="empty">暂无站点规则</div>';
    return;
  }
  hosts.sort().forEach((host) => {
    const s = siteSettings[host] || {};
    const row = document.createElement('div');
    row.className = 'rule';
    row.innerHTML =
      '<span class="rule-host" title="' + escapeHtml(host) + '">' + escapeHtml(host) + '</span>' +
      '<label class="check small"><input type="checkbox" data-kind="autoApply"' + (s.autoApply ? ' checked' : '') + '> 自动应用</label>' +
      '<label class="check small"><input type="checkbox" data-kind="keepCache"' + (s.keepCache !== false ? ' checked' : '') + '> 保留缓存</label>' +
      '<button type="button" class="btn tiny del" title="删除规则">删除</button>';
    const autoCb = row.querySelector('[data-kind="autoApply"]');
    const keepCb = row.querySelector('[data-kind="keepCache"]');
    const update = () => {
      siteSettings[host] = { autoApply: autoCb.checked, keepCache: keepCb.checked };
      saveSiteRule(host);
    };
    autoCb.addEventListener('change', update);
    keepCb.addEventListener('change', update);
    row.querySelector('.del').addEventListener('click', () => deleteSiteRule(host));
    box.appendChild(row);
  });
}

// 保存单个站点规则（即时）
async function saveSiteRule(host) {
  await sendMsg({ type: 'SET_SITE_SETTINGS', host, settings: siteSettings[host] });
}

// 删除单个站点规则（即时）
async function deleteSiteRule(host) {
  delete siteSettings[host];
  renderSiteSettings();
  await sendMsg({ type: 'DEL_SITE_SETTINGS', host });
}

// 渲染页面缓存列表（URL、时间、段数、指纹 + 删除）
function renderCacheList() {
  const box = $('cache-list');
  box.innerHTML = '';
  const keys = Object.keys(pageCache);
  if (!keys.length) {
    box.innerHTML = '<div class="empty">暂无缓存</div>';
    return;
  }
  keys.sort().forEach((key) => {
    const entry = pageCache[key] || {};
    const segs = Array.isArray(entry.segments) ? entry.segments.length : 0;
    const fp = entry.fingerprint != null ? String(entry.fingerprint).slice(0, 8) : '--';
    const time = entry.ts ? new Date(entry.ts).toLocaleString() : '--';
    const title = entry.title || entry.url || key;
    const row = document.createElement('div');
    row.className = 'cache';
    row.innerHTML =
      '<div class="cache-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
      '<div class="cache-meta">' + escapeHtml(entry.url || key) + ' · ' + escapeHtml(time) + ' · ' + segs + ' 段 · fp ' + escapeHtml(fp) + '</div>' +
      '<button type="button" class="btn tiny del" title="删除此缓存">删除</button>';
    row.querySelector('.del').addEventListener('click', async () => {
      delete pageCache[key];
      renderCacheList();
      await sendMsg({ type: 'CLEAR_CACHE', pageKey: key });
    });
    box.appendChild(row);
  });
}

// 渲染 token 用量
function renderUsage() {
  $('usage-prompt').textContent = tokenUsage.prompt || 0;
  $('usage-completion').textContent = tokenUsage.completion || 0;
  $('usage-total').textContent = tokenUsage.total || 0;
  $('usage-requests').textContent = tokenUsage.requests || 0;
}

// 从 GET_STATE 刷新站点规则 / 缓存 / token 用量
async function refreshState() {
  const state = await sendMsg({ type: 'GET_STATE' });
  if (state) {
    if (state.siteSettings) siteSettings = state.siteSettings;
    if (state.pageCache) pageCache = state.pageCache;
    if (state.tokenUsage) tokenUsage = state.tokenUsage;
  }
  renderSiteSettings();
  renderCacheList();
  renderUsage();
}

// 从后台读取配置并填充表单
async function load() {
  // 配置：优先 GET_STATE.config，其次 GET_CONFIG
  let cfg = {};
  const state = await sendMsg({ type: 'GET_STATE' });
  if (state && state.config) cfg = state.config;
  else cfg = (await sendMsg({ type: 'GET_CONFIG' })) || {};

  $('apiKey').value = cfg.apiKey || '';
  $('baseUrl').value = cfg.baseUrl || 'https://api.deepseek.com';
  $('model').value = cfg.model || 'deepseek-chat';
  $('targetLang').value = cfg.targetLang || '简体中文';
  $('chunkChars').value = cfg.chunkChars || 6000;
  $('concurrency').value = cfg.concurrency || 3;
  // 默认模式
  const radio = document.querySelector('input[name="defaultMode"][value="' + (cfg.defaultMode || 'translated') + '"]');
  if (radio) radio.checked = true;
  // 缓存开关：keepCache 默认 true，autoApplyCache 默认 false
  $('keepCache').checked = cfg.keepCache !== false;
  $('autoApplyCache').checked = !!cfg.autoApplyCache;
  await refreshState();
}

// 获取模型列表并填充 datalist（保留手动输入能力）
async function fetchModels() {
  const cfg = collectForm();
  const err = validate(cfg);
  if (err) { setStatus(err, true); return; }
  if (!cfg.apiKey) { setStatus('请先填写 API Key', true); return; }
  setStatus('获取模型中…');
  // 先保存当前表单，再让后台用该配置请求
  await sendMsg({ type: 'SET_CONFIG', config: cfg });
  await ensureHostPermission(cfg.baseUrl);
  const res = await sendMsg({ type: 'GET_MODELS' });
  if (!res || !res.ok) { setStatus('获取模型失败：' + ((res && res.error) || '未知错误'), true); return; }
  const list = $('model-list');
  list.innerHTML = '';
  for (const m of (res.models || [])) {
    const opt = document.createElement('option');
    opt.value = m.id;
    list.appendChild(opt);
  }
  if (res.models && res.models.length) setStatus('已获取 ' + res.models.length + ' 个模型，输入框下拉可选', false, true);
  else setStatus('未返回任何模型', true);
}

// 默认模式 / 缓存开关改动后即时保存
function bindInstantSave() {
  const save = async () => {
    const cfg = collectForm();
    if (validate(cfg)) return; // 数字字段不完整时跳过，仍可点「保存」
    await sendMsg({ type: 'SET_CONFIG', config: cfg });
  };
  document.querySelectorAll('input[name="defaultMode"]').forEach((r) => r.addEventListener('change', save));
  $('keepCache').addEventListener('change', save);
  $('autoApplyCache').addEventListener('change', save);
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cfg = collectForm();
  const err = validate(cfg);
  if (err) { setStatus(err, true); return; }
  await sendMsg({ type: 'SET_CONFIG', config: cfg });
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
  await sendMsg({ type: 'SET_CONFIG', config: cfg });
  await ensureHostPermission(cfg.baseUrl);
  const res = await sendMsg({ type: 'TEST_API' });
  if (res && res.ok) setStatus('连接成功 ✔', false, true);
  else setStatus('连接失败：' + ((res && res.error) || '未知错误'), true);
});

$('btn-models').addEventListener('click', fetchModels);

// 添加站点规则（默认 autoApply=false, keepCache=true）
$('btn-add-site').addEventListener('click', async () => {
  let host = $('siteHost').value.trim();
  if (!host) { setStatus('请输入站点 host', true); return; }
  host = host.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
  if (!host) { setStatus('站点 host 无效', true); return; }
  if (siteSettings[host]) { setStatus('该站点已有规则', true); return; }
  siteSettings[host] = { autoApply: false, keepCache: true };
  renderSiteSettings();
  $('siteHost').value = '';
  await sendMsg({ type: 'SET_SITE_SETTINGS', host, settings: siteSettings[host] });
  setStatus('已添加站点规则', false, true);
});

// 清空全部缓存
$('btn-clear-cache').addEventListener('click', async () => {
  if (!Object.keys(pageCache).length) { setStatus('暂无缓存', true); return; }
  if (!confirm('确定清空全部页面缓存？')) return;
  pageCache = {};
  renderCacheList();
  await sendMsg({ type: 'CLEAR_CACHE' });
  setStatus('已清空全部缓存', false, true);
});

// 导出缓存：EXPORT_CACHE → Blob 下载为 ai-translate-cache.json
$('btn-export').addEventListener('click', async () => {
  const res = await sendMsg({ type: 'EXPORT_CACHE' });
  const data = res && res.data !== undefined ? res.data : { pageCache };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ai-translate-cache.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus('已导出缓存', false, true);
});

// 导入缓存：读 JSON 文件 → IMPORT_CACHE{data}
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('不是有效的 JSON 对象');
    // 兼容 {pageCache: {...}} 与直接缓存映射两种形态
    const cache = parsed.pageCache && typeof parsed.pageCache === 'object' ? parsed.pageCache : parsed;
    if (!cache || typeof cache !== 'object') throw new Error('缓存数据格式不正确');
    pageCache = cache;
    renderCacheList();
    await sendMsg({ type: 'IMPORT_CACHE', data: parsed });
    setStatus('已导入缓存', false, true);
  } catch (err) {
    setStatus('导入失败：' + (err && err.message ? err.message : err), true);
  }
});

// 重置 token 用量
$('btn-reset-usage').addEventListener('click', async () => {
  tokenUsage = { prompt: 0, completion: 0, total: 0, requests: 0 };
  renderUsage();
  await sendMsg({ type: 'RESET_TOKEN_USAGE' });
  setStatus('已重置 token 用量', false, true);
});

bindInstantSave();
load();