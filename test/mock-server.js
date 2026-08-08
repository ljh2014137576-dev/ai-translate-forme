// 本地 DeepSeek API mock: 返回把每个文本加前缀【译】的"翻译"
const http = require("http");
const port = 8787;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const out = { id: "mock", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    try {
      const reqJson = JSON.parse(body);
      const userMsg = reqJson.messages.find((m) => m.role === "user");
      const segments = JSON.parse(userMsg.content);
      const translations = {};
      for (const s of segments) translations[s.id] = "【译】" + s.text + "(AI)";
      out.choices.push({ index: 0, message: { role: "assistant", content: JSON.stringify({ translations }) }, finish_reason: "stop" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      out.choices.push({ index: 0, message: { role: "assistant", content: JSON.stringify({ translations: {} }) }, finish_reason: "error" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    }
  });
}).listen(port, "127.0.0.1", () => console.log("mock deepseek on http://127.0.0.1:" + port));
