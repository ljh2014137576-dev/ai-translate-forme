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

## v0.1.2 — 2026-08-08
- 修复 CRX 打包 bug(用户实测报 CRX_REQUIRED_PROOF_MISSING):
  1. SignedData.crx_id 必须是 SHA256(SPKI公钥) 前 16 字节的原始字节(此前误用 32 字符 a-p 字符串)，导致 Chrome 不认可 rsa proof。
  2. 签名输入必须为 "CRX3 SignedData\x00" + 4字节LE(signed_header_data长度) + signed_header_data + zip(此前漏了长度字段)。
  依据: chromium 源码 components/crx_file/crx3.proto + crx_verifier.cc + id_util.cc(GenerateIdFromHex 不重哈希，直接 hex→a-p 映射)。
- 新增 scripts/verify-crx.mjs: 按 Chrome 算法独立校验任意 CRX3(crx_id 匹配 + RSA-SHA256 签名)。
- 交叉验证: 用 crx3 npm 包(独立实现)以同一密钥生成的 CRX 与本 CRX 均通过 verify-crx.mjs(idOk/sigOk 全 true)。
- 同一 .pem 密钥复用，扩展 ID 保持 fnedaohmonblnoilboadichjfekojngi 不变。

## v0.1.3 — 2026-08-08
- 设置页改左右布局: 左边表单，右边每个参数的用途说明(dl 卡片，窄屏自动堆叠)。
- 模型字段改为 input+datalist(可下拉选也可手动输入)，新增「获取模型」按钮: 后台 GET {baseUrl}/models 拉取 DeepSeek 模型列表(新增 GET_MODELS 消息)。
- e2e(真实 Chromium + mock /models): 右栏 6 项说明、模型列表填充、保存均通过。

## v0.2.0 — 2026-08-08
- 三种显示模式: 原文 / 译文 / 双语(原文+译文并存，译文浅色小字)，popup 一键切换并记忆默认。
- 明显进度条: 右上角滑入横幅 + 进度条(按批次实时更新 TRANSLATE_PROGRESS)。
- 页面翻译缓存: 按 origin+pathname 存 fingerprint(FNV-1a)，重新打开页面自动检测内容是否变更；未变更直接套用缓存，变更则自动重翻。设置页可管理(站点规则 autoApply/keepCache、缓存列表、清空、导出/导入 JSON 文件)；默认保留缓存。
- Token 用量: 后台累计每次响应的 usage(prompt_tokens/completion_tokens/total_tokens)，设置页显示 + 重置，popup 显示总量。
- 目标语言改为 input+datalist(预置 15 种语言，可搜索下拉)。
- manifest 新增 content_scripts(document_idle 注入，支撑缓存自动应用)，version 0.2.0。
- 审查修复: ① content 默认模式统一为 translated；② 站点键统一用 hostname(忽略端口)；③ token 字段映射修正(prompt_tokens 等)。
- e2e(真实 Chromium): 自动翻译、三模式切换、进度条结构、缓存命中不调 API、内容变更自动重翻、token 累计、清缓存 全部通过；旧 e2e(翻译/还原/设置)无回归。

## v0.2.1 — 2026-08-08
- 设置页拆分为三个分页: 基础设置 / 用量面板 / 页面缓存(tab 导航，默认基础设置)。
- 用量面板: 纯 JS 手绘折线图(canvas，≤30 条逐请求、>30 条按天聚合最近 30 天，DPR 适配，k/M 缩写)；汇总卡片(prompt/completion/total/requests)；费用估算 = prompt/1e6*输入单价 + completion/1e6*输出单价(单价默认 deepseek-chat 官方价 0.27/1.10，可改并即时保存，小额保留 6 位小数)。
- 后台新增: tokenHistory 时间序列(每次请求的 ts/prompt/completion/total，最近 1000 条)随 GET_STATE 返回；config 增加 inputPricePerM/outputPricePerM。
- 页面缓存 tab 承接原缓存管理(全局开关/站点规则/列表/清空/导出导入)。
- 备注: 子代理交付的 options.js 因补丁传输损坏(重复 8 次)，由主代理基于 options.html/css 干净重写并 e2e 验证。
- e2e(真实 Chromium): 三 tab、折线图有绘制像素、汇总/费用($20.0000 断言)、tokenHistory、模型获取、语言 15 项、缓存命中/变更重翻/三模式 全部通过。
