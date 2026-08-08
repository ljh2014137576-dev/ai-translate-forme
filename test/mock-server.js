// 本地 DeepSeek API mock: 翻译加前缀【译】，支持 /models 与 usage，提供页面 A/B 版本供缓存测试
const http = require("http");
const port = 8787;

const pageA = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Page A</title></head><body><h1>Welcome to My Website</h1><p>这是一段需要翻译的中文。</p><code>const x = 1;</code></body></html>";
const pageB = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Page B</title></head><body><h1>Welcome to My Website CHANGED</h1><p>这是一段需要翻译的中文。</p><code>const x = 1;</code></body></html>";

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // 页面 A(无参数) / 页面 B(?v=2) —— 同一 pageKey，内容不同用于缓存失效测试
    if (req.method === "GET" && (req.url === "/page1" || req.url === "/page1?v=2")) {
      const html = req.url.includes("v=2") ? pageB : pageA;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && req.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/chat/completions") {
      const reqJson = JSON.parse(body);
      const userMsg = reqJson.messages.find((m) => m.role === "user");
      const segments = JSON.parse(userMsg.content);
      const translations = {};
      for (const s of segments) translations[s.id] = "【译】" + s.text + "(AI)";
      const content = JSON.stringify({ translations });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "mock",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}).listen(port, "127.0.0.1", () => console.log("mock deepseek on http://127.0.0.1:" + port));