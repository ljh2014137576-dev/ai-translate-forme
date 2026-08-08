import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";
let server = null;
let ctx = null;
let apiCalls = 0;

const lazyPage = `<!DOCTYPE html><html><head><meta charset=utf-8><title>Lazy</title></head><body><h1>Hello World</h1><p id="first">first paragraph</p><button id="more">load more</button><script>document.getElementById("more").addEventListener("click", () => { const p = document.createElement("p"); p.id = "newp"; p.textContent = "second paragraph loaded later"; document.body.appendChild(p); });</script></body></html>`;
const zhPage = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=utf-8><title>中文页</title></head><body><h1>你好世界</h1><p>这是一段中文。</p></body></html>";

async function main() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/lazy") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(lazyPage); return; }
      if (req.method === "GET" && req.url === "/zh") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(zhPage); return; }
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
          res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
        }, 400);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));
  const ud = path.join(os.tmpdir(), "aif-lazy-" + Date.now());
  ctx = await chromium.launchPersistentContext(ud, { headless: false, executablePath: exe, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"] });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { const sws = ctx.serviceWorkers(); if (sws.length) sw = sws[0]; else await new Promise((r) => setTimeout(r, 500)); }
  await sw.evaluate(() => chrome.storage.local.set({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:8790", defaultMode: "translated", keepCache: true, autoApplyCache: false, nativeLang: "简体中文", cacheTtlDays: 7 }));
  const tabMsg = (urlPart, msg) => sw.evaluate(([u, m]) => chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => x.url && x.url.includes(u)); return chrome.tabs.sendMessage(t.id, m); }), [urlPart, msg]);

  // 1) 懒加载增量翻译
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8790/lazy", { waitUntil: "load" });
  const r1 = await tabMsg("/lazy", { type: "TRANSLATE_PAGE" });
  nodeRepl.write("1) translate result: " + JSON.stringify(r1) + "\n");
  await page.waitForFunction(() => document.querySelector("h1").textContent.includes("【译】"));
  const callsAfterFirst = apiCalls;
  // 点击“加载更多”注入新内容
  await page.click("#more");
  await page.waitForFunction(() => { const n = document.getElementById("newp"); return n && n.textContent.includes("【译】"); }, null, { timeout: 15000 });
  nodeRepl.write("1) new content translated: " + (await page.evaluate(() => document.getElementById("newp").textContent)) + " | apiCalls " + callsAfterFirst + "->" + apiCalls + "\n");

  // 2) 习惯语言跳过(中文页 + nativeLang 简体中文)
  const page2 = await ctx.newPage();
  await page2.goto("http://127.0.0.1:8790/zh", { waitUntil: "load" });
  const callsBeforeZh = apiCalls;
  const r2 = await tabMsg("/zh", { type: "TRANSLATE_PAGE" });
  nodeRepl.write("2) zh translate result: " + JSON.stringify(r2) + " apiCalls " + callsBeforeZh + "->" + apiCalls + "\n");
  const h1zh = await page2.evaluate(() => document.querySelector("h1").textContent);
  nodeRepl.write("2) zh h1 unchanged: " + (h1zh === "你好世界") + "\n");

  // 3) 缓存生命周期: 过期清除 + pinned 保留(用扩展页作为消息发送方,避免 SW 自投)
  const extId2 = new URL(ctx.serviceWorkers()[0].url()).host;
  const msgPage = await ctx.newPage();
  await msgPage.goto(`chrome-extension://${extId2}/options.html`);
  await msgPage.waitForTimeout(400);
  const now = Date.now();
  await sw.evaluate((now) => chrome.storage.local.set({ pageCache: {
    "http://x/expired": { fingerprint: "a", url: "http://x/expired", title: "expired", segments: [], translations: {}, ts: now, expiresAt: now - 1000, pinned: false },
    "http://x/pinned": { fingerprint: "b", url: "http://x/pinned", title: "pinned", segments: [], translations: {}, ts: now, expiresAt: now - 1000, pinned: true },
    "http://x/valid": { fingerprint: "c", url: "http://x/valid", title: "valid", segments: [], translations: {}, ts: now, expiresAt: now + 99999999, pinned: false }
  } }), now);
  const st = await msgPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }).then((r) => r));
  nodeRepl.write("3) cache keys after GET_STATE(clean): " + JSON.stringify(Object.keys((st && st.pageCache) || {})) + "\n");
  await msgPage.evaluate(() => chrome.runtime.sendMessage({ type: "SET_CACHE_PIN", pageKey: "http://x/pinned", pinned: false }).then(() => {}));
  const st2 = await msgPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }).then((r) => r));
  nodeRepl.write("3) after SET_CACHE_PIN(false): pinned entry now in cache: " + ((st2 && st2.pageCache && st2.pageCache["http://x/pinned"]) ? "yes(still there)" : "no(cleaned)") + "\n");
  await msgPage.close();

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("LAZY E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("LAZY E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); } finally { if (ctx) await ctx.close().catch(() => {}); if (server) await new Promise((r) => server.close(r)); }