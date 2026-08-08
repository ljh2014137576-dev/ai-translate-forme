
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "G:/ai-translate-forme";
const sampleHtml = fs.readFileSync(path.join(root, "test", "sample.html"), "utf8");
const calls = [];

async function main() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(sampleHtml);
        return;
      }
      if (req.method === "POST" && req.url === "/chat/completions") {
        calls.push(body);
        try {
          const reqJson = JSON.parse(body);
          const userMsg = reqJson.messages.find((m) => m.role === "user");
          const segments = JSON.parse(userMsg.content);
          const translations = {};
          for (const s of segments) translations[s.id] = "【译】" + s.text + "(AI)";
          const content = JSON.stringify({ translations });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
        } catch (e) {
          res.writeHead(500);
          res.end("mock err " + e.message);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(8787, "127.0.0.1", r));
  nodeRepl.write("mock server up\n");

  const userDataDir = path.join(os.tmpdir(), "aif-e2e-" + Date.now());
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-first-run"]
  });

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const sws = ctx.serviceWorkers();
    if (sws.length) sw = sws[0];
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!sw) {
    const page = await ctx.newPage();
    await page.goto("chrome://extensions-internals/", { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1000));
    const txt = await page.evaluate(() => document.body.innerText);
    nodeRepl.write("SW NOT FOUND. internals: " + txt.slice(0, 1500) + "\n");
    await ctx.close();
    await new Promise((r) => server.close(r));
    return;
  }
  const extId = new URL(sw.url()).host;
  nodeRepl.write("extension id: " + extId + "\n");

  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.fill("#apiKey", "sk-test");
  await opts.fill("#baseUrl", "http://127.0.0.1:8787");
  await opts.fill("#model", "deepseek-chat");
  await opts.fill("#targetLang", "简体中文");
  await opts.click("button[type=submit]");
  await opts.waitForTimeout(300);
  nodeRepl.write("options save status: " + (await opts.textContent("#status")) + "\n");
  await opts.close();

  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8787/", { waitUntil: "load" });

  const swRes = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    if (!t) return { ok: false, error: "tab not found" };
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(t.id, { type: "TRANSLATE_PAGE" });
  }, "http://127.0.0.1:8787/");
  nodeRepl.write("translate result: " + JSON.stringify(swRes) + "\n");

  const dom = await page.evaluate(() => {
    const g = (sel) => (document.querySelector(sel) ? document.querySelector(sel).textContent : null);
    const divs = document.querySelectorAll("body > div");
    return {
      h1: g("h1"),
      para: g("p"),
      multi: g("#multi"),
      link: g("a"),
      code: g("code"),
      pre: g("pre"),
      hidden: document.querySelector('div[style*="display:none"]') ? document.querySelector('div[style*="display:none"]').textContent : null,
      numbers: divs[2] ? divs[2].textContent : null,
      nosnippet: g("[data-nosnippet]")
    };
  });
  nodeRepl.write("DOM after translate: " + JSON.stringify(dom, null, 1) + "\n");

  const swRestore = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    return await chrome.tabs.sendMessage(t.id, { type: "RESTORE" });
  }, "http://127.0.0.1:8787/");
  const h1AfterRestore = await page.evaluate(() => document.querySelector("h1").textContent);
  nodeRepl.write("restore: " + JSON.stringify(swRestore) + " h1=" + h1AfterRestore + "\n");

  const swRes2 = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    return await chrome.tabs.sendMessage(t.id, { type: "TRANSLATE_PAGE" });
  }, "http://127.0.0.1:8787/");
  const h1AfterSecond = await page.evaluate(() => document.querySelector("h1").textContent);
  nodeRepl.write("re-translate result: " + JSON.stringify(swRes2) + " h1=" + h1AfterSecond + "\n");

  await ctx.close();
  await new Promise((r) => server.close(r));
  nodeRepl.write("mock API calls: " + calls.length + "\nE2E DONE\n");
}

try { await main(); } catch (e) { nodeRepl.write("E2E ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); }
