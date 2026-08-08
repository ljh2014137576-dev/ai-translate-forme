import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";
let server = null;
let ctx = null;

async function main() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-coder" }] })); return; }
      if (req.method === "POST" && req.url === "/chat/completions") { const c = JSON.stringify({ translations: {} }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content: c }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));
  const ud = path.join(os.tmpdir(), "aif-opt2-" + Date.now());
  ctx = await chromium.launchPersistentContext(ud, { headless: false, executablePath: exe, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"] });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { const sws = ctx.serviceWorkers(); if (sws.length) sw = sws[0]; else await new Promise((r) => setTimeout(r, 500)); }
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForTimeout(500);

  const tabs = await page.locator(".tab").allTextContents();
  nodeRepl.write("tabs: " + JSON.stringify(tabs) + "\n");

  // 基础设置: 获取模型
  await page.fill("#apiKey", "sk-test");
  await page.fill("#baseUrl", "http://127.0.0.1:8790");
  await page.click("#btn-models");
  await page.waitForTimeout(1000);
  const models = await page.locator("#model option").evaluateAll((els) => els.map((e) => e.value));
  nodeRepl.write("models: " + JSON.stringify(models) + "\n");
  nodeRepl.write("models status: " + (await page.textContent("#status")) + "\n");

  // 保存
  await page.click("button[type=submit]");
  await page.waitForTimeout(400);
  nodeRepl.write("save status: " + (await page.textContent("#status")) + "\n");

  // 语言 datalist 15 项
  const langs = await page.locator("#lang-list option").count();
  nodeRepl.write("lang options: " + langs + "\n");

  // tab 切换显示正确
  await page.click(".tab[data-tab=usage]");
  await page.waitForTimeout(300);
  nodeRepl.write("usage page visible: " + (await page.locator("#page-usage").isVisible()) + "\n");
  await page.click(".tab[data-tab=cache]");
  await page.waitForTimeout(300);
  nodeRepl.write("cache page visible: " + (await page.locator("#page-cache").isVisible()) + "\n");

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("OPTIONS2 E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("OPTIONS2 E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); } finally { if (ctx) await ctx.close().catch(() => {}); if (server) await new Promise((r) => server.close(r)); }