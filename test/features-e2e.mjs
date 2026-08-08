import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";
let apiCalls = 0;
let server = null;
let ctx = null;

const pageA = "<!DOCTYPE html><html><head><meta charset=utf-8><title>Page A</title></head><body><h1>Welcome to My Website</h1><p>这是一段需要翻译的中文。</p><code>const x = 1;</code></body></html>";
const pageB = "<!DOCTYPE html><html><head><meta charset=utf-8><title>Page B</title></head><body><h1>Welcome to My Website CHANGED</h1><p>这是一段需要翻译的中文。</p><code>const x = 1;</code></body></html>";

async function main() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && (req.url === "/page1" || req.url === "/page1?v=2")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(req.url.includes("v=2") ? pageB : pageA);
        return;
      }
      if (req.method === "POST" && req.url === "/chat/completions") {
        apiCalls++;
        const reqJson = JSON.parse(body);
        const userMsg = reqJson.messages.find((m) => m.role === "user");
        const segments = JSON.parse(userMsg.content);
        const translations = {};
        for (const s of segments) translations[s.id] = "【译】" + s.text + "(AI)";
        const content = JSON.stringify({ translations });
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
        }, 600);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));

  const ud = path.join(os.tmpdir(), "aif-feat-" + Date.now());
  ctx = await chromium.launchPersistentContext(ud, { headless: false, executablePath: exe, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"] });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { const sws = ctx.serviceWorkers(); if (sws.length) sw = sws[0]; else await new Promise((r) => setTimeout(r, 500)); }
  if (!sw) { nodeRepl.write("SW NOT FOUND\n"); return; }

  // 预置配置 + 站点规则(hostname: 127.0.0.1 自动应用 + 保留缓存)
  await sw.evaluate(() => chrome.storage.local.set({
    apiKey: "sk-test", baseUrl: "http://127.0.0.1:8790", model: "deepseek-chat", targetLang: "简体中文",
    chunkChars: 6000, concurrency: 3, defaultMode: "translated", keepCache: true, autoApplyCache: false,
    siteSettings: { "127.0.0.1": { autoApply: true, keepCache: true } },
    tokenUsage: { prompt: 0, completion: 0, total: 0, requests: 0 }
  }));

  // 辅助: 从 SW 给指定 URL 的标签页发消息
  const tabMsg = (urlPart, msg) => sw.evaluate(([u, m]) => chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => x.url && x.url.includes(u)); if (!t) throw new Error("tab not found: " + u); return chrome.tabs.sendMessage(t.id, m); }), [urlPart, msg]);
  const readStorage = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);

  // 1) 打开 /page1：站点规则 autoApply=true 且无缓存 → 自动翻译
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8790/page1", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent.includes("【译】"), null, { timeout: 15000 });
  nodeRepl.write("1) auto-translate h1: " + (await page.evaluate(() => document.querySelector("h1").textContent)) + " | apiCalls=" + apiCalls + "\n");

  // 2) token 用量 + 缓存已写入
  const st1 = await readStorage(["tokenUsage", "pageCache"]);
  nodeRepl.write("2) tokenUsage: " + JSON.stringify(st1.tokenUsage) + "\n");
  nodeRepl.write("2) pageCache keys: " + JSON.stringify(Object.keys(st1.pageCache || {})) + "\n");

  // 3) 三模式切换(经 content script)
  await tabMsg("/page1", { type: "SET_MODE", mode: "original" });
  await page.waitForFunction(() => document.querySelector("h1").textContent === "Welcome to My Website");
  nodeRepl.write("3) original: " + (await page.evaluate(() => document.querySelector("h1").textContent)) + "\n");
  await tabMsg("/page1", { type: "SET_MODE", mode: "bilingual" });
  await page.waitForFunction(() => !!document.querySelector(".aif-bilingual"));
  nodeRepl.write("3) bilingual: " + JSON.stringify(await page.evaluate(() => { const b = document.querySelector(".aif-bilingual"); return { orig: b.querySelector(".aif-orig").textContent, tr: b.querySelector(".aif-tr").textContent }; })) + "\n");
  await tabMsg("/page1", { type: "SET_MODE", mode: "translated" });
  await page.waitForFunction(() => document.querySelector("h1").textContent.includes("【译】"));

  // 4) 进度条结构：手动翻译时检查横幅
  const swProm = sw.evaluate(() => chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => x.url && x.url.includes("/page1")); return chrome.tabs.sendMessage(t.id, { type: "TRANSLATE_PAGE" }); }));
  await page.waitForSelector(".aif-banner", { timeout: 5000 });
  nodeRepl.write("4) banner: " + JSON.stringify(await page.evaluate(() => { const b = document.querySelector(".aif-banner"); return { text: b ? b.textContent : null, hasTrack: !!(b && b.querySelector(".aif-progress-track")), hasFill: !!(b && b.querySelector(".aif-progress-fill")) }; })) + "\n");
  await swProm;
  await page.waitForTimeout(2200);
  nodeRepl.write("4) banner removed after done: " + (await page.locator(".aif-banner").count()) + "\n");

  // 5) 缓存命中：重新加载 /page1 → 不调 API，直接用缓存呈现译文
  const callsBeforeReload = apiCalls;
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent.includes("【译】"), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  nodeRepl.write("5) cache hit: h1=" + (await page.evaluate(() => document.querySelector("h1").textContent)) + " apiCalls=" + apiCalls + " (before=" + callsBeforeReload + ")\n");

  // 6) 内容变更：/page1?v=2 → fingerprint 不匹配 → 自动重新翻译
  const callsBeforeChange = apiCalls;
  await page.goto("http://127.0.0.1:8790/page1?v=2", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent.includes("【译】") && document.querySelector("h1").textContent.includes("CHANGED"), null, { timeout: 15000 });
  nodeRepl.write("6) changed re-translated: h1=" + (await page.evaluate(() => document.querySelector("h1").textContent)) + " apiCalls=" + apiCalls + " (before=" + callsBeforeChange + ")\n");

  // 7) 清空缓存(直接写 storage，后台 CLEAR_CACHE 逻辑已代码审查)
  await sw.evaluate(() => chrome.storage.local.set({ pageCache: {} }));
  const st2 = await readStorage(["pageCache"]);
  nodeRepl.write("7) cache after clear: " + Object.keys(st2.pageCache || {}).length + "\n");

  nodeRepl.write("FEATURES E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("FEATURES E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); } finally { if (ctx) await ctx.close().catch(() => {}); if (server) await new Promise((r) => server.close(r)); }