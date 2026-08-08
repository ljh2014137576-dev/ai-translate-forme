// AI 网页翻译 (DeepSeek) — 后台 Service Worker
// 职责：配置读写、分批 + 并发调用 DeepSeek（OpenAI 兼容接口）、汇总译文

const DEFAULT_CONFIG = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  targetLang: '简体中文',
  chunkChars: 6000,
  concurrency: 3
};

const CHUNK_MAX_ITEMS = 500; // 每批最多条数
const FETCH_TIMEOUT_MS = 120000; // 单次请求超时（毫秒）
const RETRY_TIMES = 1; // 失败自动重试次数
const TEST_TIMEOUT_MS = 30000; // 测试连接超时（毫秒）

// 系统提示（中文），目标语言动态插入
function buildSystemPrompt(targetLang) {
  return `你是一名专业的网页翻译引擎。你将收到一个 JSON 数组，每一项是 {id, text}。请把每项的 text 翻译成「${targetLang}」，只返回一个 JSON 对象 {"translations": {"id": "译文", ...}}，id 必须与输入完全一致且条目数一致；不要翻译 URL、路径、代码、变量名、{{占位符}}，原样保留；保留有意义的首尾空白与换行；人名地名按惯例处理。确保输出是合法 JSON。`;
}

// 读取配置（与默认值合并）
async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
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

// 调用 DeepSeek（OpenAI 兼容 POST {baseUrl}/chat/completions）
async function fetchTranslations(chunk, cfg) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(cfg.targetLang) },
      { role: 'user', content: JSON.stringify(chunk.map((s) => ({ id: s.id, text: s.text }))) }
    ],
    temperature: 0.3,
    max_tokens: 4096,
    response_format: { type: 'json_object' }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
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
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('响应缺少 choices[0].message.content');
    return parseTranslations(content, chunk);
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

// 处理整页翻译：分批 → 并发请求 → 汇总 {translations, errors}
async function handleTranslate(segments) {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key，请先在设置页填写。' };
  if (!Array.isArray(segments) || !segments.length) return { ok: true, translations: {}, errors: [], count: 0 };

  // 防御：去重 id，保证全局唯一
  const seen = new Set();
  const uniq = [];
  for (const s of segments) {
    if (s && s.id != null && !seen.has(s.id)) {
      seen.add(s.id);
      uniq.push({ id: String(s.id), text: s.text != null ? String(s.text) : '' });
    }
  }

  const chunks = chunkSegments(uniq, cfg.chunkChars || DEFAULT_CONFIG.chunkChars);
  const results = await runPool(chunks.map((ch) => () => translateChunk(ch, cfg)), cfg.concurrency);

  const translations = {};
  const errors = [];
  results.forEach((r, i) => {
    if (r.ok) Object.assign(translations, r.data);
    else errors.push({ chunk: i, error: r.error, ids: chunks[i].map((s) => s.id) });
  });
  return { ok: true, translations, errors, count: uniq.length };
}

// 测试连接：向 DeepSeek 发送固定文本
async function handleTestApi() {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key，请先保存。' };
  try {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content: 'Hello world' }],
      temperature: 0.3,
      max_tokens: 32
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error('响应格式不正确');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// 消息分发（异步回调前必须 return true 保持通道打开）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const handle = async () => {
    switch (msg.type) {
      case 'TRANSLATE_PAGE':
        return handleTranslate(msg.segments);
      case 'TEST_API':
        return handleTestApi();
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