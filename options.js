// AI 网页翻译 — 设置页逻辑
// 三个分页（基础设置 / 用量面板 / 页面缓存），全部与后台通过 chrome.runtime.sendMessage 通信。
// 统一约定：所有 sendMessage 均 await 并容错（后台未实现/出错时返回 null，不抛出）。

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// —— 本地镜像（后台未就绪时仍可展示与操作）——
let siteSettings = {};                                  // { [host]: { autoApply, keepCache } }
let pageCache = {};                                     // { [pageKey]: { fingerprint, url, title, segments, translations, ts } }
let tokenUsage = { prompt: 0, completion: 0, total: 0, requests: 0 }; // 累计用量
let tokenHistory = [];                                  // [{ ts, prompt, completion, total, cost? }] 时间序列（ts 毫秒）

// —— 多厂商内置清单（name / baseUrl / models / pricing）——
// 后台暂未实现 GET_PROVIDERS 时使用该内置清单；若后台返回 providers 则优先采用后台数据。
// pricing 为 { 模型名: { input, output } }，单价为每百万 token 的 USD 官方价。
const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    pricing: {
      'deepseek-chat': { input: 0.27, output: 1.10 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 }
    }
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini'],
    pricing: {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gpt-4.1-mini': { input: 0.40, output: 1.60 },
      'gpt-4.1-nano': { input: 0.10, output: 0.40 },
      'o3-mini': { input: 1.10, output: 4.40 }
    }
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-haiku'],
    pricing: {
      'claude-3-7-sonnet-latest': { input: 3.00, output: 15.00 },
      'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00 },
      'claude-3-5-haiku-latest': { input: 0.80, output: 4.00 },
      'claude-3-haiku': { input: 0.25, output: 1.25 }
    }
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    pricing: {
      'gemini-2.5-pro': { input: 1.25, output: 10.00 },
      'gemini-2.5-flash': { input: 0.30, output: 2.50 },
      'gemini-2.0-flash': { input: 0.10, output: 0.40 },
      'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 }
    }
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen（阿里云）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
    pricing: {
      'qwen-max': { input: 2.40, output: 9.60 },
      'qwen-plus': { input: 0.40, output: 1.20 },
      'qwen-turbo': { input: 0.30, output: 0.60 },
      'qwen-long': { input: 0.50, output: 2.00 }
    }
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'kimi-k2-turbo-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    pricing: {
      'kimi-k2': { input: 0.60, output: 2.50 },
      'kimi-k2-turbo-preview': { input: 0.60, output: 2.50 },
      'moonshot-v1-8k': { input: 0.60, output: 2.00 },
      'moonshot-v1-32k': { input: 1.20, output: 4.00 },
      'moonshot-v1-128k': { input: 6.00, output: 20.00 }
    }
  },
  {
    id: 'zhipu',
    name: '智谱 GLM（智谱AI）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long'],
    pricing: {
      'glm-4-plus': { input: 0.70, output: 0.70 },
      'glm-4-air': { input: 0.20, output: 0.20 },
      'glm-4-flash': { input: 0.10, output: 0.10 },
      'glm-4-long': { input: 0.20, output: 0.20 }
    }
  },
  {
    id: 'doubao',
    name: '豆包 Doubao（字节跳动）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k', 'doubao-lite-128k'],
    pricing: {
      'doubao-pro-32k': { input: 0.11, output: 0.28 },
      'doubao-pro-128k': { input: 0.11, output: 0.28 },
      'doubao-lite-32k': { input: 0.04, output: 0.08 },
      'doubao-lite-128k': { input: 0.04, output: 0.08 }
    }
  }
];

// 非 OpenAI 兼容（/models 接口不通用）的服务商 id：点击「获取模型」时显示内置列表
const NON_OPENAI_COMPAT = new Set(['anthropic', 'gemini']);

let providers = [];                                     // 当前生效的厂商清单（GET_PROVIDERS 优先，否则内置）

// —— 基础工具 ——

// 状态提示
function setStatus(text, isError, isOk) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : isOk ? ' ok' : '');
}

// 统一后台通信：全部 await 并容错
async function sendMsg(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return null;
  }
}

// 转义 HTML，防止站点名 / URL / 标题注入破坏结构
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 数字千分位格式化
function formatNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US');
}

// 时间戳格式化为 YYYY-MM-DD（用于缓存过期时间展示）
function formatDateYmd(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// —— 多厂商支持 ——

// 通过 GET_PROVIDERS 获取厂商清单；后台未实现/返回空时回退到内置 PROVIDERS
async function loadProviders() {
  const res = await sendMsg({ type: 'GET_PROVIDERS' });
  const list = res && Array.isArray(res.providers) ? res.providers : (Array.isArray(res) ? res : null);
  if (list && list.length) {
    return list.map((p) => ({ id: '', name: '', baseUrl: '', models: [], pricing: null, ...p }));
  }
  return PROVIDERS;
}

// 把 pricing 归一化为 { 模型名: { input, output } } 映射（兼容数组与对象两种形态）
function normalizePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const map = {};
  if (Array.isArray(pricing)) {
    for (const p of pricing) {
      if (p && p.model) map[p.model] = { input: Number(p.input), output: Number(p.output) };
    }
  } else {
    for (const key of Object.keys(pricing)) {
      const v = pricing[key];
      if (v && typeof v === 'object' && v.input != null && v.output != null) {
        map[key] = { input: Number(v.input), output: Number(v.output) };
      }
    }
  }
  return Object.keys(map).length ? map : null;
}

// 当前选中的服务商对象（无匹配时返回 null）
function currentProvider() {
  const id = $('provider').value;
  return providers.find((p) => p.id === id) || null;
}

// 用厂商清单填充 select#provider（保留已选值）
function fillProviderOptions() {
  const sel = $('provider');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    sel.appendChild(opt);
  }
  if (prev && providers.some((p) => p.id === prev)) sel.value = prev;
}

// 用内置模型填充 datalist#model-list
function fillModelList(provider) {
  const list = $('model-list');
  list.innerHTML = '';
  const models = (provider && Array.isArray(provider.models)) ? provider.models : [];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m && typeof m === 'object' ? (m.id || m.name || '') : String(m);
    list.appendChild(opt);
  }
}

// 查找模型对应的官方定价（精确匹配失败时回退到大小写不敏感匹配）
function findPricing(provider, modelId) {
  if (!provider || !modelId) return null;
  const pricing = normalizePricing(provider.pricing);
  if (!pricing) return null;
  const p = pricing[modelId];
  if (p && isFinite(p.input) && isFinite(p.output)) return p;
  const lower = String(modelId).toLowerCase();
  for (const key of Object.keys(pricing)) {
    if (String(key).toLowerCase() === lower) {
      const v = pricing[key];
      if (v && isFinite(v.input) && isFinite(v.output)) return v;
    }
  }
  return null;
}

// 把 inputPrice/outputPrice 自动填入匹配模型的官方定价；无匹配时按 clearIfNoMatch 决定是否留空。
// 返回是否命中定价。
function applyProviderPricing(provider, clearIfNoMatch) {
  const price = findPricing(provider, $('model').value.trim());
  if (price) {
    $('inputPrice').value = price.input;
    $('outputPrice').value = price.output;
  } else if (clearIfNoMatch) {
    $('inputPrice').value = '';
    $('outputPrice').value = '';
  }
  calcCost();
  return !!price;
}

// —— tab 切换 ——
async function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + tab));
  if (tab === 'usage') await refreshUsage();
  else if (tab === 'cache') await refreshCache();
}

// —— 状态镜像 ——

// 用 GET_STATE 结果更新本地镜像（不覆盖基础设置表单的输入）
function applyMirrors(state) {
  if (!state) return;
  if (state.siteSettings) siteSettings = state.siteSettings;
  if (state.pageCache) pageCache = state.pageCache;
  if (state.tokenUsage) tokenUsage = state.tokenUsage;
  if (Array.isArray(state.tokenHistory)) tokenHistory = state.tokenHistory;
}

// 用配置填充表单（仅初始化时调用一次）
function fillForm(cfg) {
  cfg = cfg || {};
  $('provider').value = cfg.provider || 'deepseek';
  $('apiKey').value = cfg.apiKey || '';
  $('baseUrl').value = cfg.baseUrl || 'https://api.deepseek.com';
  $('model').value = cfg.model || 'deepseek-chat';
  $('targetLang').value = cfg.targetLang || '简体中文';
  $('nativeLang').value = cfg.nativeLang || '简体中文';
  $('chunkChars').value = cfg.chunkChars || 6000;
  $('concurrency').value = cfg.concurrency || 3;
  const mode = cfg.defaultMode === 'translated' || cfg.defaultMode === 'bilingual' ? cfg.defaultMode : 'original';
  const radio = document.querySelector('input[name="defaultMode"][value="' + mode + '"]');
  if (radio) radio.checked = true;
  $('keepCache').checked = cfg.keepCache !== false;
  $('autoApplyCache').checked = !!cfg.autoApplyCache;
  $('cacheTtl').value = cfg.cacheTtlDays || 7;
  $('inputPrice').value = cfg.inputPricePerM != null ? cfg.inputPricePerM : 0.27;
  $('outputPrice').value = cfg.outputPricePerM != null ? cfg.outputPricePerM : 1.10;
}

// —— 基础设置 ——

// 收集表单为配置对象（含默认模式、缓存开关与服务商）
function collectForm() {
  const mode = document.querySelector('input[name="defaultMode"]:checked');
  const cacheTtl = parseInt($('cacheTtl').value, 10);
  return {
    provider: $('provider').value || 'deepseek',
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    targetLang: $('targetLang').value.trim(),
    nativeLang: $('nativeLang').value.trim() || '简体中文',
    chunkChars: parseInt($('chunkChars').value, 10),
    concurrency: parseInt($('concurrency').value, 10),
    defaultMode: mode ? mode.value : 'translated',
    keepCache: $('keepCache').checked,
    autoApplyCache: $('autoApplyCache').checked,
    cacheTtlDays: Number.isInteger(cacheTtl) && cacheTtl > 0 ? cacheTtl : 7
  };
}

// 保存前合法性检查（数字字段）
function validate(cfg) {
  if (!cfg.baseUrl) return 'Base URL 不能为空';
  if (!cfg.model) return '模型不能为空';
  if (!cfg.targetLang) return '目标语言不能为空';
  if (!Number.isInteger(cfg.chunkChars) || cfg.chunkChars < 100 || cfg.chunkChars > 20000) return '每批字符数需为 100~20000 的整数';
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 10) return '并发数需为 1~10 的整数';
  // 习惯语言允许为空：collectForm 已将其默认填为「简体中文」，故此处不校验
  if (!Number.isInteger(cfg.cacheTtlDays) || cfg.cacheTtlDays < 1 || cfg.cacheTtlDays > 365) return '缓存生命周期需为 1~365 的整数';
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

// 获取模型列表并填充 datalist（保留手动输入能力）
// openai 类厂商：原行为，拉取 /models；anthropic / gemini 等非兼容厂商：显示内置模型列表
async function fetchModels() {
  const cfg = collectForm();
  const err = validate(cfg);
  if (err) { setStatus(err, true); return; }
  const p = currentProvider();
  const openaiCompat = !p || !NON_OPENAI_COMPAT.has(p.id);
  if (openaiCompat) {
    if (!cfg.apiKey) { setStatus('请先填写 API Key', true); return; }
    setStatus('获取模型中…');
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
  } else {
    if (p && Array.isArray(p.models) && p.models.length) {
      fillModelList(p);
      setStatus('已显示 ' + (p.name || p.id) + ' 内置模型列表，输入框下拉可选', false, true);
    } else {
      setStatus('该服务商暂无内置模型列表', true);
    }
  }
}

// 保存基础配置（表单提交）
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
  await sendMsg({ type: 'SET_CONFIG', config: cfg });
  await ensureHostPermission(cfg.baseUrl);
  const res = await sendMsg({ type: 'TEST_API' });
  if (res && res.ok) setStatus('连接成功 ✔', false, true);
  else setStatus('连接失败：' + ((res && res.error) || '未知错误'), true);
});

$('btn-models').addEventListener('click', fetchModels);

// 切换服务商：自动填默认 Base URL + 内置模型列表 + 匹配模型的官方定价（无匹配则留空）
$('provider').addEventListener('change', async () => {
  const p = currentProvider();
  if (!p) return;
  $('baseUrl').value = p.baseUrl || '';
  fillModelList(p);
  const matched = applyProviderPricing(p, true);
  if (matched) await savePrices();
  setStatus('已切换服务商：' + (p.name || p.id) + '，已填充默认 Base URL 与内置模型', false, true);
});

// 手动输入/选择模型：若命中内置官方定价则自动填入单价（不命中不清空，保留手动修改）
let modelPriceTimer = null;
$('model').addEventListener('input', () => {
  clearTimeout(modelPriceTimer);
  modelPriceTimer = setTimeout(async () => {
    const p = currentProvider();
    if (!p) return;
    if (applyProviderPricing(p, false)) await savePrices();
  }, 300);
});

// —— 用量面板 ——

// 刷新用量数据（折线图 + 汇总 + 费用）
async function refreshUsage() {
  const state = await sendMsg({ type: 'GET_STATE' });
  applyMirrors(state);
  renderUsageSummary();
  drawUsageChart();
}

// 渲染四张用量卡片、费用估算与实际计费
function renderUsageSummary() {
  $('usage-prompt').textContent = formatNum(tokenUsage.prompt);
  $('usage-completion').textContent = formatNum(tokenUsage.completion);
  $('usage-total').textContent = formatNum(tokenUsage.total);
  $('usage-requests').textContent = formatNum(tokenUsage.requests);
  calcCost();
  renderActualCost();
}

// 计算并显示估算费用 = prompt/1e6*输入单价 + completion/1e6*输出单价
function calcCost() {
  const ip = parseFloat($('inputPrice').value);
  const op = parseFloat($('outputPrice').value);
  const prompt = tokenUsage.prompt || 0;
  const completion = tokenUsage.completion || 0;
  const cost = (prompt / 1e6) * (isNaN(ip) ? 0 : ip) + (completion / 1e6) * (isNaN(op) ? 0 : op);
  // 金额很小时保留 6 位小数，避免显示 $0.0000
  const digits = cost > 0 && cost < 0.0001 ? 6 : 4;
  $('cost-estimate').textContent = '$' + cost.toFixed(digits) + ' USD';
}

// 实际计费：tokenHistory 中所有 cost 字段之和；无 cost 数据返回 null
function sumActualCost() {
  let sum = 0;
  let found = false;
  for (const h of tokenHistory) {
    if (h && typeof h === 'object' && h.cost != null) {
      const n = Number(h.cost);
      if (isFinite(n)) { sum += n; found = true; }
    }
  }
  return found ? sum : null;
}

// 渲染「实际计费（来自 API cost 字段）」：无则显示 '—'
function renderActualCost() {
  const sum = sumActualCost();
  if (sum == null) {
    $('cost-actual').textContent = '—';
    return;
  }
  const digits = sum > 0 && sum < 0.0001 ? 6 : 4;
  $('cost-actual').textContent = '$' + sum.toFixed(digits) + ' USD';
}

// 单价变化：即时重算费用并保存（先 GET_STATE 拿 config 再合并 SET_CONFIG，保留其他配置）
async function savePrices() {
  const state = await sendMsg({ type: 'GET_STATE' });
  const base = state && state.config ? state.config : {};
  const ip = parseFloat($('inputPrice').value);
  const op = parseFloat($('outputPrice').value);
  const config = Object.assign({}, base, {
    inputPricePerM: isNaN(ip) ? 0 : ip,
    outputPricePerM: isNaN(op) ? 0 : op
  });
  await sendMsg({ type: 'SET_CONFIG', config });
}

const bindPrice = (id) => {
  $(id).addEventListener('input', () => {
    calcCost();
    savePrices();
  });
};
bindPrice('inputPrice');
bindPrice('outputPrice');

// 折线图数据：<=30 条按每次请求逐点；>30 条按天聚合（每天 total 求和）画最近 30 天
function buildChartPoints() {
  const sorted = tokenHistory
    .filter((h) => h && typeof h === 'object')
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (sorted.length <= 30) {
    return sorted.map((h) => ({ ts: h.ts || 0, value: h.total || 0 }));
  }
  // 按天聚合
  const dayMap = new Map();
  for (const h of sorted) {
    const d = new Date(h.ts || 0);
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    dayMap.set(key, (dayMap.get(key) || 0) + (h.total || 0));
  }
  const days = [...dayMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const recent = days.slice(-30);
  return recent.map(([key, value]) => ({ ts: new Date(key).getTime(), value }));
}

// Y 轴数值缩写：k / M
function formatCompact(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

// X 轴时间标签：同一天显示 HH:MM，跨天显示 M/D
function formatTimeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// 手绘折线图（无第三方库）：自适应容器宽度 + devicePixelRatio
function drawUsageChart() {
  const canvas = $('usage-chart');
  const empty = $('usage-empty');
  const points = buildChartPoints();
  if (!points.length) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const wrap = $('usage-chart-wrap');
  const cssW = wrap ? wrap.clientWidth : 300;
  const cssH = 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 40, padR = 12, padT = 12, padB = 24;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;

  const max = Math.max(1, ...points.map((p) => p.value));
  const niceMax = Math.ceil(max / 4) * 4 || 4;
  const n = points.length;

  // Y 轴网格线与数值（4 条）
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    ctx.strokeStyle = 'rgba(0,0,0,.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssW - padR, y);
    ctx.stroke();
    ctx.fillStyle = '#616161';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatCompact((niceMax * i) / 4), padL - 6, y);
  }

  // X 轴标签：两端与中间
  ctx.fillStyle = '#616161';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelIdx = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
  for (const idx of labelIdx) {
    const x = padL + (plotW * idx) / (n > 1 ? n - 1 : 1);
    ctx.fillText(formatTimeLabel(points[idx].ts), x, cssH - padB + 6);
  }

  // 折线 + 填充
  const xAt = (idx) => padL + (plotW * idx) / (n > 1 ? n - 1 : 1);
  const yAt = (v) => padT + plotH - (plotH * v) / niceMax;

  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(points[0].value));
  for (let i = 1; i < n; i++) ctx.lineTo(xAt(i), yAt(points[i].value));
  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(xAt(n - 1), padT + plotH);
  ctx.lineTo(xAt(0), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 120, 212, .12)';
  ctx.fill();
}

// 重置用量
$('btn-reset-usage').addEventListener('click', async () => {
  tokenUsage = { prompt: 0, completion: 0, total: 0, requests: 0 };
  tokenHistory = [];
  renderUsageSummary();
  drawUsageChart();
  await sendMsg({ type: 'RESET_TOKEN_USAGE' });
  setStatus('已重置 token 用量', false, true);
});

// —— 页面缓存 ——

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

// 渲染页面缓存列表（URL、时间、段数、指纹、过期时间 + 长期保留 + 删除）
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
    // 过期时间：长期保留显示「永久」，否则按 expiresAt 显示 YYYY-MM-DD
    const expire = entry.pinned ? '永久' : (entry.expiresAt ? formatDateYmd(entry.expiresAt) : '--');
    const row = document.createElement('div');
    row.className = 'cache';
    row.innerHTML =
      '<div class="cache-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
      '<div class="cache-meta">' + escapeHtml(entry.url || key) + ' · ' + escapeHtml(time) + ' · ' + segs + ' 段 · fp ' + escapeHtml(fp) + ' · 过期 ' + escapeHtml(expire) + '</div>' +
      '<label class="check small"><input type="checkbox" data-kind="pinned"' + (entry.pinned ? ' checked' : '') + '> 长期保留</label>' +
      '<button type="button" class="btn tiny del" title="删除此缓存">删除</button>';
    // 长期保留开关：本地更新 pinned 并通知后台 SET_CACHE_PIN
    row.querySelector('[data-kind="pinned"]').addEventListener('change', async () => {
      pageCache[key] = pageCache[key] || {};
      pageCache[key].pinned = row.querySelector('[data-kind="pinned"]').checked;
      renderCacheList();
      await sendMsg({ type: 'SET_CACHE_PIN', pageKey: key, pinned: pageCache[key].pinned });
    });
    row.querySelector('.del').addEventListener('click', async () => {
      delete pageCache[key];
      renderCacheList();
      await sendMsg({ type: 'CLEAR_CACHE', pageKey: key });
    });
    box.appendChild(row);
  });
}

// 从 GET_STATE 刷新站点规则 / 缓存
async function refreshCache() {
  const state = await sendMsg({ type: 'GET_STATE' });
  applyMirrors(state);
  renderSiteSettings();
  renderCacheList();
}

// 全局缓存开关即时保存（合并保留其他配置）
async function saveCacheFlags() {
  const state = await sendMsg({ type: 'GET_STATE' });
  const base = state && state.config ? state.config : {};
  const cfg = Object.assign({}, base, {
    keepCache: $('keepCache').checked,
    autoApplyCache: $('autoApplyCache').checked
  });
  await sendMsg({ type: 'SET_CONFIG', config: cfg });
}

$('keepCache').addEventListener('change', saveCacheFlags);
$('autoApplyCache').addEventListener('change', saveCacheFlags);

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

// —— 初始化 ——

async function init() {
  providers = await loadProviders();
  fillProviderOptions();
  const state = await sendMsg({ type: 'GET_STATE' });
  if (state && state.config) fillForm(state.config);
  applyMirrors(state);
  // 仅填充当前服务商的内置模型列表，不覆盖已保存的 baseUrl / 单价
  const p = currentProvider();
  if (p) fillModelList(p);
  renderUsageSummary();
  drawUsageChart();
  renderSiteSettings();
  renderCacheList();
  switchTab('basic');
}

// tab 切换事件
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

init();
