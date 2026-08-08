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

## v0.2.2 — 2026-08-08
- 设置页与弹窗重构为明日方舟(Arknights)风格: 深蓝灰底 + 双层网格 + 金色辉光、方角面板、金色键帽按钮、左导航金色竖条、clip-path 斜切装饰。
- 导航改为左侧导航(side-nav + ark-main)，替代原顶部 tab。
- 大量 CSS 3D 动效: perspective/preserve-3d、切页 rotateY 进出场、卡片/按钮/折线图 hover translateZ+rotateX/Y、按钮按压键帽下沉、背景粒子漂移呼吸、首载逐页浮现、标题金色下划线。
- options.js / popup.js 功能逻辑零改动(逐字节未变)，全部元素 ID 保留(36+6)，e2e 三套回归全通过。
- 修复原版潜在缺陷: #usage-chart 由 display:none 改为 block(原样式会让折线图有数据也看不到)。

## v0.2.3 — 2026-08-08
- 懒加载页面: 翻译后 MutationObserver 监听 DOM 变化，点击「加载更多」等新增内容自动增量翻译(去重/防抖 500ms/不写缓存)；还原时停止监听。
- 习惯语言跳过: 新增「习惯语言」设置(默认简体中文)；detectMainLang 统计页面字符 Script 占比判定主要语言，与习惯语言同族则跳过翻译(不发 AI、不留缓存、不再次翻译)；popup 显示友好提示。
- 缓存生命周期: 每条缓存带 expiresAt(默认 7 天，可配置 cacheTtlDays)，过期自动清理；「长期保留」pinned 条目不受清理；设置页可设生命周期天数、每条可勾选长期保留并显示过期时间。
- 切页动画: 由 rotateY 旋转改为快速整体平移(translateX 0.22s)。
- 审查修复: detectMainLang 的 Han 阈值 0.3 太激进导致中英混合页误判为中文而跳过翻译 → 改为 Han 占多数(>0.5)才判中文，Latin 不少于 Han 判英文。
- e2e 四套全过: 懒加载增量翻译、习惯语言跳过(不调 API)、缓存过期清理+pinned、自动翻译/三模式/进度/缓存命中/变更重翻、用量面板/费用、设置页。

## v0.3.0 — 2026-08-08
- UI 全面改为 Google Material Design 风格(白底 #f8f9fa、12px 圆角卡片 + elevation、主色 #1a73e8、outlined 输入框、switch/radio、抽屉式左导航)，保留左侧导航与全部元素 ID。
- 多厂商适配: 内置 8 家厂商(DeepSeek/OpenAI/Claude/Gemini/通义/Kimi/智谱/豆包)，统一协议 provider 字段；请求/响应按三种格式适配: openai(/chat/completions)、anthropic(/v1/messages, x-api-key)、gemini(:generateContent?key=)；内置模型列表与官方近似定价表。
- 费用估算: 用量面板新增「实际计费」——若 API 响应 usage 含 cost/usd_cost/total_cost/price/amount 字段则直读累计，否则按内置官方定价表估算(单价可改)。
- 设置页新增「服务商」下拉: 切换自动填 baseUrl、填充内置模型列表、按模型自动带出官方单价。
- manifest: host_permissions 覆盖 8 家厂商域名，version 0.3.0。
- 审查修复: gemini 分支误读 data.usage(实际为 usageMetadata)导致用量不累计 → 修正并兼容 openai/anthropic 的 usage。
- e2e 五套全过: 多厂商(openai×2/anthropic/gemini 翻译 + usage 累计 + cost 直读)、三模式/缓存/进度、用量面板/费用、设置页、懒加载/语言跳过/缓存生命周期。

## v0.3.1 — 2026-08-08
- UI 改为 Windows 10 时代 Fluent Design(浅色): #f3f3f3 底 + 顶部淡蓝辉光、主色 #0078d4、Segoe UI、NavigationView 左侧导航(active 蓝色竖条)、Fluent toggle/radio、Win10 红/绿状态条。
- 数据/文字面板使用**亚克力材质**: rgba(255,255,255,.62) + backdrop-filter blur(28px) saturate(160%) + 白描边 + 柔和阴影，列表行内用纯白防糊，不影响数据展示。
- 背景新增**交互式 3D 数学雕塑**(sculpture.js，纯 canvas 伪 3D 无依赖): 150 块白色玻璃面板沿弹簧曲线流动(2 圈、twist、两端 scale 0→1→0 无缝循环)，透视投影 + 鼠标平滑旋转视角 + DPR 适配 + 页面隐藏暂停。
- 弹窗同步 Fluent 浅色亚克力风格(纯 CSS 改动，JS 未动)。
- 验证: 雕塑 canvas 实际渲染(1200x840 有 2 万+ 像素)、亚克力 blur 生效、5 套 e2e 全回归通过。

## v0.3.2 — 2026-08-08
- 按用户反馈放大背景 3D 雕塑并调整姿态，使其视觉更突出:
  - 弹簧半径 3.5→8、总高 22→30、面板尺寸 1.6/1.1→4.2/2.4、相机拉近 46→36、缩放系数 height/22→height/15。
  - 新增基础俯仰 -0.62rad(弹簧立起冲向观众)+ 基础滚转 0.35rad(画面斜切更动感)。
  - 描边改为 Fluent 蓝 rgba(0,120,212,.55)、填充透明度提高，浅色背景下更醒目。
- 渲染验证: 雕塑像素占比由约 2% 提升至 25.8%，居中并充满画面高度。

## v0.3.3 — 2026-08-08
- 亚克力模糊强度可调: 默认由 28px 提升至 40px；所有亚克力面板统一走 CSS 变量 --acrylic-blur。
- 设置页「基础设置」新增「亚克力模糊强度」滑块(0~80px)：拖动实时生效(改 CSS 变量)并防抖保存到配置(acrylicBlur)；popup 同步应用该值。
- 验证: 滑块拖动 40→70px 实时生效、保存持久化、options 回归通过。

## v0.3.4 - 2026-08-08
- 按 Fluent Acrylic 教程(zhihu p/349444364, 被 403 后改用同文镜像 ubug.io/blog/fluent-acrylic)重构亚克力效果:
  - backdrop-filter 从 blur+saturate(160%) 升级为完整配方: blur + brightness(120%) + saturate(80%)(亮度提亮、饱和度压低, 前景更清晰)。
  - 所有亚克力面板(.side-nav/.card/.list/.usage-item/popup)新增噪点层: 50x50 PNG base64 噪点图 + background-size:50px, 呈现磨砂哑光质感。
  - CSS 变量 --acrylic-noise 统一管理噪点图(options.css / popup.css 的 :root)。
- 模糊强度滑块(0~80px)保持可拖: applyAcrylic / popup.js 同步为新滤镜链, 拖动后 brightness+saturate 不丢失。
- manifest version 0.3.0 -> 0.3.4(之前几次发版漏改, 补齐以便拖入 CRX 时识别为更新)。
- 验证: 5 套 e2e 回归全过(features/usage/options/lazy/multi);computed style 确认 4 面板+popup 均为 blur(40px) brightness(1.2) saturate(0.8)+噪点背景;滑块拖到 60px 实时生效;3D 雕塑仍正常渲染。

## v0.3.5 - 2026-08-08
- 修复设置页切换标签时整个页面频闪:
  - 根因: .main 及其祖先均无 position:relative, 失去 .active 的 tab-page 变为 position:absolute(top:0;left:0;right:0) 后以视口为包含块, 瞬间铺满全屏覆盖左侧导航, 再淡出回缩, 观感即"右侧信息栏先占满全屏又被导航限制回去"。
  - 修复: options.html 将 3 个 tab-page 包进 <div class="tab-pages">, CSS 给 .tab-pages 加 position:relative 作为包含块; 非激活页始终锚定在主列内(不再逃逸到视口)。
  - 额外: html 加 scrollbar-gutter:stable, 切换不同高度标签时滚动条不出现/消失, 消除居中内容水平位移。
- 验证: playwright 实测所有 tab-page(激活/非激活/切换中途)宽高均=主列 856px(left=332,right=1188), 不再铺满 1265px 视口; options/usage 两套 e2e 回归通过。

## v0.3.6 - 2026-08-08
- 费用估算改为人民币(CNY)计价:
  - 单价字段/估算/实际计费全部改为 ¥(每百万 token 单价单位 CNY)。
  - 新增可配置「USD→CNY 汇率」(默认 7.15, 用量面板可改, 防抖保存): 官方定价为 USD, 选择/输入模型自动按汇率换算成人民币填入单价; API cost 字段(USD)也按汇率换算显示 ¥。
  - 旧数据自动迁移: 首次升级后把已保存的 USD 单价一次性 ×汇率 换算为 CNY 并持久化, 不重复乘; 未保存过单价则直接用 CNY 默认值(deepseek-chat 1.93/7.87)。
- 修复用量折线图完全没有折线: 根因是 n=1(仅一次请求或按天聚合为 1 点)时只 moveTo 不划线不画点; 现在每个数据点都画蓝色圆点, 单点也能看到图形。
- 验证: usage-e2e 费用显示 ¥20.0000; 实测 deepseek-reasoner 自动填 3.9325/15.6585; 图表 n=1 蓝色像素 32、n=5 蓝色像素 1824; 迁移逻辑单测(旧 USD→CNY 一次、不重复乘、默认值不被乘); options/multi e2e 回归通过。

## v0.3.7 - 2026-08-08
- 修复「获取模型」后无法下拉选择模型: 模型字段由 input+datalist(Chrome 原生 datalist 下拉在动态填充后不可靠)改为真正的 <select id="model"> 下拉框, 内置模型 + 拉取模型去重合并 + 末尾「自定义模型…」选项(选中后显示手输框 #modelCustom, 保留手动输入自定义模型能力); 选择模型自动按汇率填入人民币单价, 自定义输入同样支持。
- 修复亚克力模糊强度完全不生效: 根因是 .tab-page 的 `will-change: opacity, transform` 会切断子元素 backdrop-filter 对背景画布的采样(实测 blur 0px 与 80px 渲染完全一致); 移除该 will-change 后模糊/亮度/饱和度/噪点全部真正生效, 设置页滑块(0~80px)实时可见。
- sculpture.js 新增 window.__sculptureStop 调试/测试用。
- 验证: 实测卡片区域 blur 0 vs 80 像素差异 0 → 251(生效); 模型下拉: 内置 2 项 + 获取后 3 项 + 自定义, 选中 deepseek-reasoner 自动填 3.9325/15.6585, 选自定义显示输入框并聚焦; 5 套 e2e 回归全过。
