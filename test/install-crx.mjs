import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const crxPath = "G:/ai-translate-forme/ai-translate-forme.crx";
const EXPECT_ID = "fnedaohmonblnoilboadichjfekojngi";
const exe = "C:/Users/monting/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";

async function main() {
  const ud = path.join(os.tmpdir(), "aif-install3-" + Date.now());
  const ctx = await chromium.launchPersistentContext(ud, {
    headless: false,
    executablePath: exe,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-first-run"]
  });
  const dialogs = [];
  ctx.on("dialog", async (d) => { dialogs.push({ type: d.type(), message: d.message() }); await d.dismiss().catch(() => {}); });
  const page = await ctx.newPage();
  await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // 点击开发者模式开关(递归所有 shadow root 找 aria-label=开发者模式)
  const clicked = await page.evaluate(() => {
    function findDev(root) {
      const kids = root.shadowRoot ? [...root.shadowRoot.children] : [...root.children];
      for (const el of kids) {
        const label = el.getAttribute && (el.getAttribute("aria-label") || "");
        if (label === "开发者模式") return el;
        const f = findDev(el);
        if (f) return f;
      }
      return null;
    }
    const el = findDev(document.querySelector("extensions-manager"));
    if (!el) return null;
    el.click();
    return el.tagName + "#" + el.id;
  });
  nodeRepl.write("clicked: " + (clicked ? "yes" : "no") + "\n");
  await page.waitForTimeout(800);
  // 确认 devDrawer 是否可见(开发者模式生效)
  const drawerVisible = await page.evaluate(() => {
    const d = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot.querySelector("#devDrawer");
    return d ? getComputedStyle(d).visibility + "/" + d.getBoundingClientRect().height : "none";
  });
  nodeRepl.write("devDrawer: " + drawerVisible + "\n");

  // drop crx
  const crxB64 = fs.readFileSync(crxPath).toString("base64");
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "ai-translate-forme.crx", { type: "application/x-chrome-extension" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const mgr = document.querySelector("extensions-manager");
    const overlay = mgr.shadowRoot.querySelector("extensions-drop-overlay");
    for (const t of [overlay, mgr, document.body]) {
      t.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, crxB64);
  nodeRepl.write("drop dispatched\n");
  await page.waitForTimeout(8000);

  nodeRepl.write("dialogs: " + JSON.stringify(dialogs) + "\n");
  // 检查 toast 文本
  try {
    const toast = await page.evaluate(() => {
      const t = document.querySelector("extensions-manager").shadowRoot.querySelector("cr-toast-manager");
      return t ? t.shadowRoot.textContent.trim().slice(0, 200) : "no toast";
    });
    nodeRepl.write("toast: " + toast + "\n");
  } catch (e) {}

  const p2 = await ctx.newPage();
  await p2.goto("chrome://extensions-internals/", { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(1200);
  const txt = await p2.evaluate(() => document.body.innerText);
  nodeRepl.write("contains our id: " + txt.includes(EXPECT_ID) + "\n");
  nodeRepl.write("names: " + JSON.stringify([...txt.matchAll(/"name": "([^"]+)"/g)].map((m) => m[1])) + "\n");
  nodeRepl.write(txt.includes(EXPECT_ID) ? "INSTALL OK\n" : "INSTALL NOT CONFIRMED\n");
  await ctx.close();
}

try { await main(); } catch (e) { nodeRepl.write("INSTALL TEST ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n"); }