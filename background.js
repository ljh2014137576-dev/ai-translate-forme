// AI 网页翻译 — 后台 Service Worker
// 职责：配置读写、多厂商适配（DeepSeek/OpenAI/Claude/Gemini/通义/Kimi/智谱/豆包）、分批 + 并发调用、汇总译文、页面缓存、用量统计

// 内置厂商表：provider id → 名称/接口地址/协议格式/可用模型/价格（每百万 token USD 近似官方价，可在设置修改）
const PROVIDERS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', format: 'openai', models: ['deepseek-chat','deepseek-reasoner'], pricing: { 'deepseek-chat': { input: 0.27, output: 1.10 }, 'deepseek-reasoner': { input: 0.55, output: 2.19 } } },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com', format: 'openai', models: ['gpt-5','gpt-4o','gpt-4o-mini','gpt-4.1','gpt-4.1-mini','o4-mini'], pricing: { 'gpt-5': { input: 1.25, output: 10 }, 'gpt-4o': { input: 2.5, output: 10 }, 'gpt-4o-mini': { input: 0.15, output: 0.6 }, 'gpt-4.1': { input: 2, output: 8 }, 'gpt-4.1-mini': { input: 0.4, output: 1.6 }, 'o4-mini': { input: 1.1, output: 4.4 } } },
  anthropic: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', format: 'anthropic', models: ['claude-sonnet-4-5','claude-opus-4','claude-3-7-sonnet','claude-3-5-haiku'], pricing: { 'claude-sonnet-4-5': { input: 3, output: 15 }, 'claude-opus-4': { input: 15, output: 75 }, 'claude-3-7-sonnet': { input: 3, output: 15 }, 'claude-3-5-haiku': { input: 0.8, output: 4 } } },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', format: 'gemini', models: ['gemini-2.5-pro','gemini-2.5-flash','gemini-2.0-flash'], pricing: { 'gemini-2.5-pro': { input: 1.25, output: 10 }, 'gemini-2.5-flash': { input: 0.3, output: 2.5 }, 'gemini-2.0-flash': { input: 0.1, output: 0.4 } } },
  qwen: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', format: 'openai', models: ['qwen-max','qwen-plus','qwen-turbo'], pricing: { 'qwen-max': { input: 2.4, output: 9.6 }, 'qwen-plus': { input: 0.4, output: 1.2 }, 'qwen-turbo': { input: 0.1, output: 0.3 } } },
  moonshot: { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn', format: 'openai', models: ['kimi-k2-0711-preview','moonshot-v1-32k','moonshot-v1-8k'], pricing: { 'kimi-k2-0711-preview': { input: 0.6, output: 2.5 }, 'moonshot-v1-32k': { input: 0.6, output: 2.5 }, 'moonshot-v1-8k': { input: 0.6, output: 2.5 } } },
  zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', format: 'openai', models: ['glm-4-plus','glm-4-air','glm-4-flash'], pricing: { 'glm-4-plus': { input: 0.5, output: 2 }, 'glm-4-air': { input: 0.05, output: 0.2 }, 'glm-4-flash': { input: 0.0, output: 0.0 } } },
  doubao: { name: '豆包 (火山方舟)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', format: 'openai', models: ['doubao-pro-32k','doubao-lite-32k'], pricing: { 'doubao-pro-32k': { input: 0.3, output: 0.6 }, 'doubao-lite-32k': { input: 0.15, output: 0.3 } } }
};

const DEFAULT_CONFIG = {
  apiKey: '',
  provider: 'deepseek',       // 厂商 id（deepseek | openai | anthropic | gemini | qwen | moonshot | zhipu | doubao）
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  targetLang: '简体中文',
  nativeLang: '简体中文',     // 用户习惯语言（content 用于跳过翻译）
  chunkChars: 6000,
  concurrency: 3,
  defaultMode: 'translated', // original | translated | bilingual
  keepCache: true,           // 默认开启页面缓存
  autoApplyCache: false,     // 默认不自动套用缓存
  inputPricePerM: 1.93,      // 每百万输入 token 价格（CNY，默认按 deepseek-chat 官方价 USD0.27 × 汇率7.15）
  outputPricePerM: 7.87,     // 每百万输出 token 价格（CNY，USD1.10 × 汇率7.15）
  usdToCny: 7.15,            // USD→CNY 汇率（官方定价换算人民币用，可设置页修改）
  cacheTtlDays: 7,           // 缓存生命周期天数（默认 7 天）
  acrylicBlur: 40,           // 亚克力模糊强度(px)，设置页可拖动调整
};

const CHUNK_MAX_ITEMS = 500;     // 每批最多条数
const FETCH_TIMEOUT_MS = 120000; // 翻译请求超时（毫秒）
const RETRY_TIMES = 1;           // 失败自动重试次数
const TEST_TIMEOUT_MS = 30000;   // 测试/模型等请求超时（毫秒）

// 系统提示（中文），目标语言动态插入
function buildSystemPrompt(targetLang) {
  return `你是一名专业的网页翻译引擎。你将收到一个 JSON 数组，每一项是 {id, text}。请把每项的 text 翻译成「${targetLang}」，只返回一个 JSON 对象 {"translations": {"id": "译文", ...}}，id 必须与输入完全一致且条数一致；不要翻译 URL、路径、代码、变量名、{占位符}，原样保留；保留有意义的首尾空白与换行；人名地名按惯例处理。确保输出是合法 JSON。`;
}

// 读取配置（与默认值合并）
async function getConfig() {
  const stored = await chrome.storage.local.get(null);
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  if (stored.usdToCny == null) {
    // v0.3.6 迁移: 旧版本价格以 USD 存储，首次升级后一次性换算为人民币并持久化
    cfg.usdToCny = DEFAULT_CONFIG.usdToCny;
    if (stored.inputPricePerM != null && isFinite(Number(stored.inputPricePerM)) && Number(stored.inputPricePerM) > 0) {
      cfg.inputPricePerM = Number(stored.inputPricePerM) * cfg.usdToCny;
    }
    if (stored.outputPricePerM != null && isFinite(Number(stored.outputPricePerM)) && Number(stored.outputPricePerM) > 0) {
      cfg.outputPricePerM = Number(stored.outputPricePerM) * cfg.usdToCny;
    }
    await chrome.storage.local.set({ usdToCny: cfg.usdToCny, inputPricePerM: cfg.inputPricePerM, outputPricePerM: cfg.outputPricePerM });
  } else {
    cfg.usdToCny = isFinite(Number(cfg.usdToCny)) && Number(cfg.usdToCny) > 0 ? Number(cfg.usdToCny) : DEFAULT_CONFIG.usdToCny;
  }
  return cfg;
}

// 去掉可能包裹内容的 ```json 代码块
function stripFence(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
}

// 解析模型返回 → {id: 译文}；兼容 {"translations":{...}} 与直接映射两种形态
function parseTranslations(content, chunk) {
  const obj = JSON.parse(stripFence(content));
  const map = obj && typeof obj.translations === 'object' ? obj.translations : obj;
  const out = {};
  for (const seg of chunk) {
    if (map && map[seg.id] != null) out[seg.id] = String(map[seg.id]);
  }
  return out;
}

// 累加 tokenUsage 并记录 tokenHistory 用量时间序列（读取→累加→写回 chrome.storage.local）
async function addTokenUsage(usage) {
  const stored = await chrome.storage.local.get(['tokenUsage', 'tokenHistory']);
  const cur = stored.tokenUsage || { prompt: 0, completion: 0, total: 0, requests: 0 };
  const next = {
    prompt: (cur.prompt || 0) + (usage.prompt || 0),
    completion: (cur.completion || 0) + (usage.completion || 0),
    total: (cur.total || 0) + (usage.total || 0),
    requests: (cur.requests || 0) + 1
  };
  // 追加一条用量记录到 tokenHistory，仅保留最近 1000 条；cost 为该次请求实际费用 USD（无则 null）
  const history = (stored.tokenHistory || []).concat({
    ts: Date.now(),
    prompt: usage.prompt || 0,
    completion: usage.completion || 0,
    total: usage.total || 0,
    cost: usage.cost != null ? usage.cost : null
  }).slice(-1000);
  await chrome.storage.local.set({ tokenUsage: next, tokenHistory: history });
}

// 解析厂商接口地址：优先用户自定义 baseUrl（非空且非内置默认），否则取 PROVIDERS 内置默认
function resolveBaseUrl(cfg, provider) {
  const custom = cfg && cfg.baseUrl && cfg.baseUrl.trim();
  if (custom && custom !== DEFAULT_CONFIG.baseUrl) return custom.replace(/\/+$/, '');
  return provider.baseUrl;
}

// 直读响应 usage 中的费用字段（cost/usd_cost/total_cost/price/amount），取第一个数字；无则返回 null
function readUsageCost(u) {
  if (!u || typeof u !== 'object') return null;
  const keys = ['cost', 'usd_cost', 'total_cost', 'price', 'amount'];
  for (const k of keys) {
    const v = u[k];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  }
  return null;
}

// 按厂商 format 调用翻译接口（openai / anthropic / gemini），成功后累加用量
async function fetchTranslations(chunk, cfg) {
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.deepseek; // 厂商缺省 deepseek
  const baseUrl = resolveBaseUrl(cfg, provider);
  const segments = chunk.map((s) => ({ id: s.id, text: s.text })); // 发送给模型的段列表
  const systemPrompt = buildSystemPrompt(cfg.targetLang);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let data;
    let content;
    let u;
    let usage;
    if (provider.format === 'anthropic') {
      // Anthropic Messages API：POST {baseUrl}/v1/messages
      const url = baseUrl + '/v1/messages';
      const body = {
        model: cfg.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(segments) }]
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      data = await resp.json();
      content = data.content && data.content[0] ? data.content[0].text : '';
      if (!content) throw new Error('响应缺少 content[0].text');
      u = data.usage && typeof data.usage === 'object' ? data.usage : {};
      usage = {
        prompt: u.input_tokens || 0,
        completion: u.output_tokens || 0,
        total: (u.input_tokens || 0) + (u.output_tokens || 0)
      };
    } else if (provider.format === 'gemini') {
      // Gemini generateContent API：POST {baseUrl}/v1beta/models/{model}:generateContent?key=...
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(segments) }] }]
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      data = await resp.json();
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      if (!Array.isArray(parts) || !parts.length) throw new Error('响应缺少 candidates[0].content.parts');
      content = parts.map((p) => (p && p.text != null ? p.text : '')).join('');
      u = (data && data.usageMetadata) || {}; // Gemini 返回 usageMetadata
      usage = {
        prompt: u.promptTokenCount || 0,
        completion: u.candidatesTokenCount || 0,
        total: u.totalTokenCount || 0
      };
    } else {
      // openai 格式（DeepSeek/OpenAI/通义/Kimi/智谱/豆包 等兼容接口）：POST {baseUrl}/chat/completions
      const url = baseUrl + '/chat/completions';
      const body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(segments) }
        ],
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: 'json_object' }
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      data = await resp.json();
      content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('响应缺少 choices[0].message.content');
      u = data.usage && typeof data.usage === 'object' ? data.usage : {};
      // OpenAI/DeepSeek 返回 *_tokens 字段，兼容自定义代理可能返回的 prompt/completion/total
      usage = {
        prompt: u.prompt_tokens || u.prompt || 0,
        completion: u.completion_tokens || u.completion || 0,
        total: u.total_tokens || u.total || 0
      };
    }
    const translations = parseTranslations(content, chunk);
    // cost 直读：usage 含 cost/usd_cost/total_cost/price/amount 时取第一个数字作为本次费用 USD
    const cost = readUsageCost(u);
    if (cost != null) usage.cost = cost;
    if (data && (data.usage || data.usageMetadata)) await addTokenUsage(usage); // 兼容 openai/anthropic 的 usage 与 gemini 的 usageMetadata
    return { translations, usage };
  } finally {
    clearTimeout(timer);
  }
}

// 单批翻译（失败自动重试）
async function translateChunk(chunk, cfg) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
    try {
      return { ok: true, data: await fetchTranslations(chunk, cfg) };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr && lastErr.message ? lastErr.message : String(lastErr) };
}

// 按字符数分批（每批最多 CHUNK_MAX_ITEMS 条；id 由 content 全局唯一分配，不拆分单条）
function chunkSegments(segments, chunkChars) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const seg of segments) {
    const len = seg.text ? seg.text.length : 0;
    if (cur.length && (cur.length >= CHUNK_MAX_ITEMS || size + len > chunkChars)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(seg);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// 并发池：同时最多 concurrency 个任务
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency || DEFAULT_CONFIG.concurrency, tasks.length));
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// 向标签页发送翻译进度（失败静默忽略，勿抛）
function sendProgress(sender, done, total) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'TRANSLATE_PROGRESS', done, total }).catch(() => {});
}

// 从 sender.tab.url 取 host（站点设置键）
function hostOf(sender) {
  const url = sender && sender.tab && sender.tab.url;
  if (!url) return '';
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

// 成功后按站点覆盖写页面缓存：siteSettings[host]?.keepCache ?? config.keepCache
async function writePageCache(msg, sender, cfg, segments, translations) {
  if (!msg.pageKey || !msg.fingerprint) return; // 缺 pageKey / fingerprint 则跳过
  const host = hostOf(sender);
  const site = (await chrome.storage.local.get('siteSettings')).siteSettings || {};
  const keep = site[host] && site[host].keepCache != null ? site[host].keepCache : cfg.keepCache;
  if (!keep) return;
  const pageCache = (await chrome.storage.local.get('pageCache')).pageCache || {};
  const ts = Date.now();
  pageCache[msg.pageKey] = {
    fingerprint: msg.fingerprint,
    url: msg.url || (sender && sender.tab && sender.tab.url) || '',
    title: msg.title || (sender && sender.tab && sender.tab.title) || '',
    segments,            // 已去重
    translations,
    ts,
    expiresAt: ts + (cfg.cacheTtlDays || DEFAULT_CONFIG.cacheTtlDays) * 86400000, // 过期时间（毫秒），到期后由生命周期清理
    pinned: false        // 长期保留标记，不受生命周期清理
  };
  await chrome.storage.local.set({ pageCache });
}

// 清理过期缓存：删除 expiresAt < 当前时间 且未 pinned（长期保留）的条目，并写回 storage
async function cleanExpiredCache() {
  const pageCache = (await chrome.storage.local.get('pageCache')).pageCache || {};
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(pageCache)) {
    const entry = pageCache[key];
    if (entry && !entry.pinned && entry.expiresAt != null && entry.expiresAt < now) {
      delete pageCache[key];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ pageCache });
}

// 处理整页翻译：分批 → 并发请求 → 汇总 + 进度 + 缓存
async function handleTranslate(msg, sender) {
  await cleanExpiredCache(); // 翻译前先清理过期缓存
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key，请先在设置页填写。' };

  const segments = msg && msg.segments;
  if (!Array.isArray(segments) || !segments.length) {
    return { ok: true, translations: {}, errors: [], count: 0, usage: { prompt: 0, completion: 0, total: 0 } };
  }

  // 防御：按 id 去重，保证全局唯一
  const seen = new Set();
  const uniq = [];
  for (const s of segments) {
    if (s && s.id != null && !seen.has(s.id)) {
      seen.add(s.id);
      uniq.push({ id: String(s.id), text: s.text != null ? String(s.text) : '' });
    }
  }

  const chunks = chunkSegments(uniq, cfg.chunkChars || DEFAULT_CONFIG.chunkChars);
  const total = chunks.length;
  let done = 0;

  // 每个 chunk 完成后发送进度（成功或失败都算）
  const tasks = chunks.map((ch) => async () => {
    const r = await translateChunk(ch, cfg);
    done++;
    sendProgress(sender, done, total);
    return r;
  });
  const results = await runPool(tasks, cfg.concurrency);

  const translations = {};
  const errors = [];
  let prompt = 0, completion = 0, totalTokens = 0;
  results.forEach((r, i) => {
    if (r.ok) {
      Object.assign(translations, r.data.translations);
      prompt += r.data.usage.prompt;
      completion += r.data.usage.completion;
      totalTokens += r.data.usage.total;
    } else {
      errors.push({ chunk: i, error: r.error, ids: chunks[i].map((s) => s.id) });
    }
  });

  await writePageCache(msg, sender, cfg, uniq, translations);

  return {
    ok: true,
    translations,
    errors,
    count: uniq.length,
    usage: { prompt, completion, total: totalTokens }
  };
}

// 测试连接：按厂商 format 发送最小请求（30s 超时）
async function handleTestApi() {
  const cfg = await getConfig();
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key，请先保存。' };
  try {
    const baseUrl = resolveBaseUrl(cfg, provider);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
    let resp;
    try {
      if (provider.format === 'anthropic') {
        // Anthropic：POST {baseUrl}/v1/messages，单条 Hello world
        resp = await fetch(baseUrl + '/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: cfg.model, max_tokens: 32, messages: [{ role: 'user', content: 'Hello world' }] }),
          signal: ctrl.signal
        });
      } else if (provider.format === 'gemini') {
        // Gemini：POST {baseUrl}/v1beta/models/{model}:generateContent?key=...，单条 Hello world
        resp = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }] }),
          signal: ctrl.signal
        });
      } else {
        // openai 格式（DeepSeek/OpenAI/通义/Kimi/智谱/豆包 等兼容接口）：现有逻辑
        resp = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Hello world' }], temperature: 0.3, max_tokens: 32 }),
          signal: ctrl.signal
        });
      }
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // 按格式校验最小响应
    if (provider.format === 'anthropic') {
      if (!data.content || !data.content[0] || !data.content[0].text) throw new Error('响应格式不正确');
    } else if (provider.format === 'gemini') {
      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) throw new Error('响应格式不正确');
    } else {
      if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error('响应格式不正确');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// 获取模型列表：openai 格式 GET {baseUrl}/models；anthropic/gemini 直接返回内置模型表
async function handleGetModels() {
  const cfg = await getConfig();
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
  // anthropic / gemini 无公开 /models 接口：返回内置模型表
  if (provider.format === 'anthropic' || provider.format === 'gemini') {
    return { ok: true, models: provider.models, builtin: true };
  }
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key，请先保存。' };
  try {
    const url = resolveBaseUrl(cfg, provider) + '/models';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = Array.isArray(data.data) ? data.data.map((m) => ({ id: m.id })) : [];
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// 返回内置厂商表（含 name/baseUrl/format/models/pricing）
async function handleGetProviders() {
  return { ok: true, providers: PROVIDERS };
}

// —— 缓存 / 站点 / 用量相关消息处理 ——

// 查询页面缓存（fingerprint 匹配才算命中）
async function handleCheckCache(msg) {
  await cleanExpiredCache(); // 查询前先清理过期缓存
  const pageCache = (await chrome.storage.local.get('pageCache')).pageCache || {};
  const cache = pageCache[msg.pageKey];
  if (cache && cache.fingerprint && cache.fingerprint === msg.fingerprint) {
    return { ok: true, hit: true, cache };
  }
  return { ok: true, hit: false };
}

// 清缓存：带 pageKey 删单条，否则清空全部
async function handleClearCache(msg) {
  if (msg.pageKey) {
    const pageCache = (await chrome.storage.local.get('pageCache')).pageCache || {};
    delete pageCache[msg.pageKey];
    await chrome.storage.local.set({ pageCache });
  } else {
    await chrome.storage.local.set({ pageCache: {} });
  }
  return { ok: true };
}

// 设置缓存长期保留标记（pinned）；pageKey 不存在则忽略
async function handleSetCachePin(msg) {
  const pageCache = (await chrome.storage.local.get('pageCache')).pageCache || {};
  if (pageCache[msg.pageKey]) {
    pageCache[msg.pageKey].pinned = !!msg.pinned;
    await chrome.storage.local.set({ pageCache });
  }
  return { ok: true };
}

// 切换默认模式（original | translated | bilingual）
async function handleSetMode(msg) {
  if (!['original', 'translated', 'bilingual'].includes(msg.mode)) {
    return { ok: false, error: '无效模式: ' + msg.mode };
  }
  await chrome.storage.local.set({ defaultMode: msg.mode });
  return { ok: true };
}

// 获取全量状态（配置、站点设置、缓存、用量）
async function handleGetState() {
  await cleanExpiredCache(); // 返回状态前先清理过期缓存
  const stored = await chrome.storage.local.get(['siteSettings', 'pageCache', 'tokenUsage', 'tokenHistory']);
  return {
    ok: true,
    config: await getConfig(),
    siteSettings: stored.siteSettings || {},
    pageCache: stored.pageCache || {},
    tokenUsage: stored.tokenUsage || { prompt: 0, completion: 0, total: 0, requests: 0 },
    tokenHistory: stored.tokenHistory || []
  };
}

// 设置某站点设置（合并现有条目）
async function handleSetSiteSettings(msg) {
  if (!msg.host || !msg.settings || typeof msg.settings !== 'object') {
    return { ok: false, error: '参数缺失: host 或 settings' };
  }
  const siteSettings = (await chrome.storage.local.get('siteSettings')).siteSettings || {};
  const merged = { ...(siteSettings[msg.host] || {}), ...msg.settings };
  siteSettings[msg.host] = { autoApply: !!merged.autoApply, keepCache: !!merged.keepCache };
  await chrome.storage.local.set({ siteSettings });
  return { ok: true };
}

// 删除某站点设置
async function handleDelSiteSettings(msg) {
  const siteSettings = (await chrome.storage.local.get('siteSettings')).siteSettings || {};
  delete siteSettings[msg.host];
  await chrome.storage.local.set({ siteSettings });
  return { ok: true };
}

// 导出缓存（页面缓存 + 站点设置 + 时间戳）
async function handleExportCache() {
  await cleanExpiredCache(); // 导出前先清理过期缓存
  const stored = await chrome.storage.local.get(['pageCache', 'siteSettings']);
  return {
    ok: true,
    data: {
      pageCache: stored.pageCache || {},
      siteSettings: stored.siteSettings || {},
      exportedAt: Date.now()
    }
  };
}

// 导入缓存：Object.assign 合并到现有对象，未提供的键不覆盖
async function handleImportCache(msg) {
  await cleanExpiredCache(); // 导入前先清理过期缓存
  const data = msg.data || {};
  const keys = [];
  if (data.pageCache) keys.push('pageCache');
  if (data.siteSettings) keys.push('siteSettings');
  if (!keys.length) return { ok: true };
  const cur = await chrome.storage.local.get(keys);
  const patch = {};
  if (data.pageCache) {
    const cfg = await getConfig();
    const ttlMs = (cfg.cacheTtlDays || DEFAULT_CONFIG.cacheTtlDays) * 86400000;
    const now = Date.now();
    const merged = Object.assign({}, cur.pageCache || {}, data.pageCache);
    // 兼容旧条目：无 expiresAt 则补上过期时间，pinned 缺省为 false（不长期保留）
    for (const key of Object.keys(data.pageCache)) {
      const entry = merged[key];
      if (!entry || typeof entry !== 'object') continue;
      if (entry.expiresAt == null) entry.expiresAt = now + ttlMs;
      if (entry.pinned == null) entry.pinned = false;
    }
    patch.pageCache = merged;
  }
  if (data.siteSettings) patch.siteSettings = Object.assign({}, cur.siteSettings || {}, data.siteSettings);
  await chrome.storage.local.set(patch);
  return { ok: true };
}

// 用量清零
async function handleResetTokenUsage() {
  await chrome.storage.local.set({ tokenUsage: { prompt: 0, completion: 0, total: 0, requests: 0 } });
  return { ok: true };
}

// 消息分发（异步回调前必须 return true 保持通道打开）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const handle = async () => {
    switch (msg.type) {
      case 'TRANSLATE_PAGE':
        return handleTranslate(msg, sender);
      case 'CHECK_CACHE':
        return handleCheckCache(msg);
      case 'CLEAR_CACHE':
        return handleClearCache(msg);
      case 'SET_MODE':
        return handleSetMode(msg);
      case 'GET_STATE':
        return handleGetState();
      case 'SET_SITE_SETTINGS':
        return handleSetSiteSettings(msg);
      case 'DEL_SITE_SETTINGS':
        return handleDelSiteSettings(msg);
      case 'EXPORT_CACHE':
        return handleExportCache();
      case 'IMPORT_CACHE':
        return handleImportCache(msg);
      case 'SET_CACHE_PIN':
        return handleSetCachePin(msg);
      case 'RESET_TOKEN_USAGE':
        return handleResetTokenUsage();
      case 'TEST_API':
        return handleTestApi();
      case 'GET_PROVIDERS':
        return handleGetProviders();
      case 'GET_MODELS':
        return handleGetModels();
      case 'GET_CONFIG':
        return getConfig();
      case 'SET_CONFIG':
        await chrome.storage.local.set(msg.config || {});
        return { ok: true };
      default:
        return null;
    }
  };
  handle().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;
});

// 快捷键 Alt+T：对当前标签页注入 content.js 并触发翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-page') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  } catch (e) {
    // 页面无法注入（受限页面等）时静默忽略
  }
});