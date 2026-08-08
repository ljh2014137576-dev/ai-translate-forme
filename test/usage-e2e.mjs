import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";
let server = null;
let ctx = null;

const pageA = "<!DOCTYPE html><html><head><meta charset=utf-8><title>P</title></head><body><h1>Hello World</h1><p>第二段文本。</p></body></html>";

async function main() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/page1") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(pageA); return; }
      if (req.method === "POST" && req.url === "/chat/completions") {
        const reqJson = JSON.parse(body);
        const userMsg = reqJson.messages.find((m) => m.role === "user");
        const segments = JSON.parse(userMsg.content);
        const translations = {};
        for (const s of segments) translations[s.id] = "【译】" + s.text + "(AI)";
        const content = JSON.stringify({ translations });
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
        }, 300);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));

  const ud = path.join(os.tmpdir(), "aif-usage-" + Date.now());
  ctx = await chromium.launchPersistentContext(ud, { headless: false, executablePath: exe, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"] });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { const sws = ctx.serviceWorkers(); if (sws.length) sw = sws[0]; else await new Promise((r) => setTimeout(r, 500)); }
  if (!sw) { nodeRepl.write("SW NOT FOUND\n"); return; }

  await sw.evaluate(() => chrome.storage.local.set({
    apiKey: "sk-test", baseUrl: "http://127.0.0.1:8790", model: "deepseek-chat", targetLang: "简体中文",
    chunkChars: 6000, concurrency: 3, defaultMode: "translated", keepCache: true, autoApplyCache: false,
    inputPricePerM: 1000000, outputPricePerM: 1000000, // 便于断言: prompt 12 -> $12, completion 8 -> $8
    siteSettings: {}, tokenUsage: { prompt: 0, completion: 0, total: 0, requests: 0 }, tokenHistory: []
  }));

  // 1) 翻译一页产生用量
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8790/page1", { waitUntil: "load" });
  await sw.evaluate(() => chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => x.url && x.url.includes("/page1")); return chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(t.id, { type: "TRANSLATE_PAGE" })); }));
  await page.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent.includes("【译】"), null, { timeout: 15000 });
  const st = await sw.evaluate(() => chrome.storage.local.get(["tokenUsage", "tokenHistory"]));
  nodeRepl.write("1) tokenUsage=" + JSON.stringify(st.tokenUsage) + "\n");
  nodeRepl.write("1) tokenHistory=" + JSON.stringify(st.tokenHistory) + "\n");

  // 2) 打开设置页: 三个 tab + 默认基础设置
  const sw2 = ctx.serviceWorkers()[0] || sw;
  const extId = new URL(sw2.url()).host;
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForTimeout(600);
  const tabs = await opts.locator(".tab").allTextContents();
  nodeRepl.write("2) tabs: " + JSON.stringify(tabs) + "\n");
  const activeBasic = await opts.locator(".tab.active").textContent();
  nodeRepl.write("2) default active tab: " + activeBasic + "\n");

  // 3) 用量面板: 折线图 + 汇总 + 费用
  await opts.click(".tab[data-tab=usage]");
  await opts.waitForTimeout(600);
  const chartInfo = await opts.evaluate(() => {
    const c = document.getElementById("usage-chart");
    if (!c) return { exists: false };
    const ctx2 = c.getContext("2d");
    const d = ctx2.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return { exists: true, w: c.width, h: c.height, paintedPixels: painted };
  });
  nodeRepl.write("3) chart: " + JSON.stringify(chartInfo) + "\n");
  const summary = {
    prompt: await opts.textContent("#usage-prompt"),
    completion: await opts.textContent("#usage-completion"),
    total: await opts.textContent("#usage-total"),
    requests: await opts.textContent("#usage-requests"),
    cost: await opts.textContent("#cost-estimate"),
    inputPrice: await opts.inputValue("#inputPrice"),
    outputPrice: await opts.inputValue("#outputPrice")
  };
  nodeRepl.write("3) summary: " + JSON.stringify(summary) + "\n");

  // 4) 页面缓存 tab: 列表含 /page1
  await opts.click(".tab[data-tab=cache]");
  await opts.waitForTimeout(500);
  const cacheText = await opts.textContent("#cache-list");
  nodeRepl.write("4) cache list contains /page1: " + cacheText.includes("/page1") + "\n");

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("USAGE E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("USAGE E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); } finally { if (ctx) await ctx.close().catch(() => {}); if (server) await new Promise((r) => server.close(r)); }