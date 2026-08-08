# 开发日志 (LOG)

## v0.1.0 — 2026-08-08
- 初始版本: Chrome MV3 扩展「AI 网页翻译(DeepSeek)」。
- 功能: 抽取整页可见文本(去重、跳过代码/隐藏元素/纯数字) → 分批并发调用 DeepSeek API → 按 JSON 格式回填译文；支持还原原文；popup 一键翻译；options 配置 API Key/Base URL/模型/目标语言/批量/并发；Alt+T 快捷键。
- 技术: 纯原生 JS，无外部依赖；content script 按文本去重节省 token；后台并发池(默认3)+失败重试1次；120s 超时；兼容 ```json 代码块包裹与直接映射两种响应。
- 审查修复(主代理):
  1. 重复点击「翻译此页」会对译文二次翻译 → 增加 state.translated 守卫，翻译前先还原。
  2. 全部批次失败却显示「翻译完成(0/N)」 → 改为错误横幅。
  3. 自定义 Base URL 未申请网络权限 → options 保存/测试时用 chrome.permissions.request 补授权。
  4. 收集文本前廉价跳过 [hidden]/[aria-hidden=true] 元素，减少 getComputedStyle 调用。
- 验证:
  - node --check 全部 JS 通过；manifest JSON 合法。
  - 真实 Chromium(Playwright chromium-1234)端到端: mock DeepSeek API → 5 段全部替换，code/pre/隐藏/纯数字正确跳过；还原原文 OK；重复翻译 OK。
  - 备注: 品牌版 Google Chrome 137+ 已移除 --load-extension/--disable-extensions-except，命令行加载扩展需用 Chromium/Chrome for Testing；用户手动安装走 chrome://extensions「加载已解压的扩展程序」不受影响。
- 说明: 本文件由主代理维护，每次发版追加记录。

## v0.1.1 — 2026-08-08
- 新增 scripts/pack-crx.mjs: 无依赖打包 CRX3(RSA-2048 签名，自校验)。
- 产出 ai-translate-forme.crx(29,966 bytes, 12 文件)，扩展 ID fnedaohmonblnoilboadichjfekojngi。
- .gitignore 增加 *.crx / *.pem(私钥不入库)。
