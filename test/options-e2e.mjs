import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const root = "G:/ai-translate-forme";

async function main() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-coder" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/chat/completions") {
        const reqJson = JSON.parse(body);
        const content = JSON.stringify({ translations: {} });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(8790, "127.0.0.1", r));

  const ud = path.join(os.tmpdir(), "aif-opt-" + Date.now());
  const ctx = await chromium.launchPersistentContext(ud, {
    headless: false,
    executablePath: exe,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"]
  });
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const sws = ctx.serviceWorkers();
    if (sws.length) sw = sws[0];
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!sw) { nodeRepl.write("SW NOT FOUND\n"); await ctx.close(); await new Promise((r) => server.close(r)); return; }
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForTimeout(500);

  // 右栏说明存在
  const rightDd = await page.locator(".right dl dd").count();
  const rightDt = await page.locator(".right dl dt").count();
  nodeRepl.write("right panel dt/dd: " + rightDt + "/" + rightDd + "\n");

  // 填写并获取模型
  await page.fill("#apiKey", "sk-test");
  await page.fill("#baseUrl", "http://127.0.0.1:8790");
  await page.click("#btn-models");
  await page.waitForTimeout(1500);
  const status = await page.textContent("#status");
  const opts = await page.locator("#model-list option").evaluateAll((els) => els.map((e) => e.value));
  nodeRepl.write("status: " + status + "\n");
  nodeRepl.write("models: " + JSON.stringify(opts) + "\n");

  // 保存
  await page.click("button[type=submit]");
  await page.waitForTimeout(400);
  nodeRepl.write("save status: " + (await page.textContent("#status")) + "\n");

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("OPTIONS E2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("OPTIONS E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); }