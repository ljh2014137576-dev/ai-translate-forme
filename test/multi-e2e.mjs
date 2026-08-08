import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";
let server = null;
let ctx = null;
const calls = [];

const pageHtml = "<!DOCTYPE html><html><head><meta charset=utf-8><title>P</title></head><body><h1>Hello World</h1><p>Second paragraph.</p></body></html>";

function buildTranslations(body, url) {
  let segments = [];
  try {
    const reqJson = JSON.parse(body);
    if (url.includes("/chat/completions")) {
      const user = reqJson.messages.find((m) => m.role === "user");
      segments = JSON.parse(user.content);
    } else if (url.includes("/v1/messages")) {
      segments = JSON.parse(reqJson.messages[0].content);
    } else if (url.includes(":generateContent")) {
      segments = JSON.parse(reqJson.contents[0].parts[0].text);
    }
  } catch (e) {
    // 解析失败则返回空
  }
  const translations = {};
  for (const s of (Array.isArray(segments) ? segments : [])) translations[s.id] = "【译】" + s.text + "(AI)";
  return translations;
}

async function main() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(pageHtml); return; }
      calls.push(req.method + " " + req.url);
      const translations = buildTranslations(body, req.url);
      const content = JSON.stringify({ translations });
      if (req.url.includes("/chat/completions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.000123 } }));
        return;
      }
      if (req.url.includes("/v1/messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", content: [{ type: "text", text: content }], usage: { input_tokens: 80, output_tokens: 40 } }));
        return;
      }
      if (req.url.includes(":generateContent")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 30, totalTokenCount: 90 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));
  const ud = path.join(os.tmpdir(), "aif-multi-" + Date.now());
  ctx = await chromium.launchPersistentContext(ud, { headless: false, executablePath: exe, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"] });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { const sws = ctx.serviceWorkers(); if (sws.length) sw = sws[0]; else await new Promise((r) => setTimeout(r, 500)); }
  const tabMsg = (urlPart, msg) => sw.evaluate(([u, m]) => chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => x.url && x.url.includes(u)); if (!t) throw new Error("tab not found " + u); return chrome.tabs.sendMessage(t.id, m); }), [urlPart, msg]);

  const cases = [
    { name: "openai(deepseek)", provider: "deepseek", model: "deepseek-chat", expectUrl: "/chat/completions" },
    { name: "openai(openai)", provider: "openai", model: "gpt-4o-mini", expectUrl: "/chat/completions" },
    { name: "anthropic", provider: "anthropic", model: "claude-3-5-haiku", expectUrl: "/v1/messages" },
    { name: "gemini", provider: "gemini", model: "gemini-2.5-flash", expectUrl: ":generateContent" }
  ];
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8790/page", { waitUntil: "load" });

  for (const c of cases) {
    await sw.evaluate((cfg) => chrome.storage.local.set({ provider: cfg.provider, apiKey: "sk-test", baseUrl: "http://127.0.0.1:8790", model: cfg.model, defaultMode: "translated", keepCache: false }), c);
    const r = await tabMsg("/page", { type: "TRANSLATE_PAGE" });
    const h1 = await page.evaluate(() => document.querySelector("h1").textContent);
    const hit = calls.filter((x) => x.includes(c.expectUrl)).length;
    nodeRepl.write(c.name + ": ok=" + (r && r.ok) + " h1=" + h1 + " endpointHits=" + hit + "\n");
  }

  // cost 直读: deepseek(openai) mock 返回 usage.cost=0.000123
  const st = await sw.evaluate(() => chrome.storage.local.get(["tokenUsage", "tokenHistory"]));
  nodeRepl.write("tokenUsage: " + JSON.stringify(st.tokenUsage) + "\n");
  const costs = (st.tokenHistory || []).map((h) => h.cost);
  nodeRepl.write("history cost values: " + JSON.stringify(costs) + "\n");
  const hasCost = costs.some((c) => c === 0.000123);
  nodeRepl.write("cost passthrough: " + hasCost + "\n");

  // GET_PROVIDERS
  const extId = new URL(sw.url()).host;
  const msgPage = await ctx.newPage();
  await msgPage.goto(`chrome-extension://${extId}/options.html`);
  await msgPage.waitForTimeout(500);
  const providers = await msgPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_PROVIDERS" }).then((r) => (r && r.providers) ? Object.keys(r.providers) : []));
  nodeRepl.write("providers: " + JSON.stringify(providers) + "\n");
  const providerSel = await msgPage.inputValue("#provider");
  nodeRepl.write("options provider select value: " + providerSel + "\n");
  await msgPage.close();

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("MULTI E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("MULTI E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); } finally { if (ctx) await ctx.close().catch(() => {}); if (server) await new Promise((r) => server.close(r)); }