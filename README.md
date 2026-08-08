# AI 网页翻译 (DeepSeek)

一个基于 Manifest V3 的 Chrome 扩展：把整个网页的可见文本抽取出来，调用 DeepSeek 大模型翻译为目标语言，再回填到页面上，并支持一键还原原文。

版本：v0.1.0（纯原生 JS，无外部依赖）

## 功能简介

- 一键翻译整页可见文本（自动跳过代码、输入框、隐藏元素等）
- 相同文本去重后只请求一次，节省 token
- 文本按字符数分批、并发请求，失败自动重试 1 次
- 一键「还原原文」
- 设置页可配置 API Key / Base URL / 模型 / 目标语言 / 每批字符数 / 并发数
- 快捷键 `Alt+T` 直接翻译当前页

## 安装方法

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录（`G:\ai-translate-forme`）
5. 在设置页填入 DeepSeek API Key 后即可使用

## 使用步骤

1. 点击工具栏扩展图标 →「打开设置」→ 填写 API Key →「保存」
2. 打开任意网页 → 点击扩展图标 → 点击「翻译此页」
3. 需要恢复时点击「还原原文」
4. 也可以直接按 `Alt+T` 翻译当前页

## DeepSeek API Key 获取

访问 [https://platform.deepseek.com](https://platform.deepseek.com) 注册账号，在「API Keys」页面创建密钥即可。API 按 token 计费，具体价格见官网。

## 配置项说明

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| API Key | 空 | DeepSeek 密钥，仅保存在本地浏览器 storage |
| Base URL | `https://api.deepseek.com` | OpenAI 兼容接口地址，请求 `POST {baseUrl}/chat/completions` |
| 模型 | `deepseek-chat` | DeepSeek 模型名 |
| 目标语言 | 简体中文 | 译文语言 |
| 每批字符数 | 6000 | 每个请求最多携带的源文本字符数（每批最多 500 条） |
| 并发数 | 3 | 同时进行的请求数量 |

## 工作原理

1. **抽取**：content.js 用 TreeWalker 遍历页面可见文本节点，过滤脚本/样式/输入控件/隐藏元素等，按文本去重后为每个唯一文本分配 id（`n0, n1, ...`），记录原始文本以便还原
2. **发送**：popup 或快捷键触发后，content.js 把分段列表发给后台 Service Worker
3. **翻译**：后台按字符数分批，用并发池调用 DeepSeek 的 OpenAI 兼容 `chat/completions` 接口（带 120 秒超时，失败重试 1 次）
4. **解析**：模型返回 `{"translations": {"id": "译文", ...}}`（兼容直接映射与 ```json 代码块包裹），后台汇总后回传
5. **回填**：content.js 把译文写回对应文本节点；「还原原文」用保存的原始文本恢复；页面刷新后原始记录自然失效

## 目录结构

```
ai-translate-forme/
├── manifest.json       # MV3 清单（权限、图标、快捷键等）
├── background.js       # Service Worker：配置读写、分批、并发调用 DeepSeek
├── content.js          # 内容脚本：抽取文本、进度横幅、回填译文、还原
├── popup.html/js/css   # 弹窗界面（翻译此页 / 还原原文 / 打开设置）
├── options.html/js/css # 设置页（API Key、模型、目标语言、批量、并发等）
├── icons/              # 扩展图标（icon16/48/128.png）
├── test/               # 本地 mock DeepSeek API 与示例页面（开发自测用）
├── README.md
└── .gitignore
```

## 免责声明

翻译过程中页面文本会发送到 DeepSeek 服务器进行处理，涉及隐私或敏感内容时请谨慎使用。本项目仅供学习研究，使用前请阅读并遵守 DeepSeek 服务条款与相关法律法规。