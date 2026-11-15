# Bo Translation 隐私政策 / Privacy Policy

最后更新日期 / Last Updated: `2026-11-15`

## 1. 概述（Overview）

**Bo Translation（沉浸式双语对照）** 是一款开源、本地优先（Local-First）的浏览器扩展（支持 Chrome 与 Microsoft Edge），用于网页、技术文档、PDF 文档左右双语对照、代码注释及在线视频字幕的实时双语对照翻译。我们高度重视您的隐私：**本扩展不设任何开发者自有中转服务器，不收集、不存储、不追踪、不分析、也不向任何第三方出售或共享您的个人身份信息或浏览历史。**

**Bo Translation** is a local-first browser extension for Chrome and Microsoft Edge, built for immersive bilingual webpage, technical documentation, side-by-side PDF document, code comment, and video subtitle translation. **We operate zero developer backend servers and do NOT collect, store, track, analyze, sell, or share any personal data or browsing history.**

## 2. 数据存储与处理方式（Data Storage & Processing）

- **本地配置与密钥（Local Settings & API Keys）**：您配置的翻译服务地址（Base URL）、API Key、自定义术语表（Glossary）、快捷键和站点规则仅通过浏览器官方 `chrome.storage.local` 接口保存在您本机浏览器中，绝不会上传至开发者服务器。
  *All user preferences, API keys, custom glossaries, shortcuts, and site rules are stored strictly locally inside your browser via `chrome.storage.local` and are never transmitted to the developer.*
- **待翻译文本传输（Text Sent for Translation）**：仅当您主动触发翻译（开启网页双语对照、PDF 左右双语对照、悬停段落、划词释义、视频双语字幕）或开启智能外语自动翻译时，当前视口内的待译文本片段才会由您的浏览器直接发送至**您本人所选定的翻译模型接口**（例如本地 Ollama、OpenAI、Xiaomi MiMo、MiniMax、Kimi、Bilibili Index-Translate 或您自定义的兼容端点）。
  *Webpage, PDF text blocks, or subtitle cues are transmitted directly from your browser ONLY to the translation API provider explicitly selected or configured by you when translation is active.*
- **本地语言检测（Local Language Detection）**：网页与 PDF 语言识别完全在浏览器本地完成（使用浏览器离线 API 与本地字符集启发式算法），无需联网发送页面内容。
  *Foreign-language detection runs 100% locally inside the browser with zero network requests.*

## 3. 浏览器权限说明（Permissions Justification）

- `storage`：在本地保存翻译服务配置、术语表、阅读样式与站点规则。
  *Stores user preferences, glossary entries, and site rules locally.*
- `activeTab`：响应工具栏弹窗操作，切换当前标签页的双语对照视图。
  *Allows toggling bilingual view mode on the active tab from the extension popup.*
- `contextMenus`：提供网页右键菜单快捷切换双语对照翻译。
  *Provides a context-menu shortcut to toggle bilingual page translation.*
- `declarativeNetRequest`：当连接本地 Ollama（`127.0.0.1` / `localhost`）或特定兼容接口时，仅针对用户所配接口请求按需调整必要的请求头以完成直连。
  *Adjusts request headers strictly for user-configured local Ollama or compatible translation API endpoints so direct browser-to-API requests succeed without proxy servers.*
- `host_permissions (<all_urls>)`：允许用户在任意外语技术文档、新闻网页、代码仓库、PDF 文档及视频网站上按需渲染双语对照译文并直连自定义翻译接口。
  *Required so users can translate readable text, PDFs, and subtitles on any webpage they visit and connect directly to custom OpenAI-compatible API endpoints.*

## 4. 第三方服务说明（Third-Party Translation Providers）

当您配置并使用第三方大模型 API 进行翻译时，所发送文本片段的处理受对应服务商各自隐私政策的约束（如使用本地 Ollama 模型，则全部数据均保留在您的本机设备内）。

When you configure and use a third-party LLM/translation API provider, text segments sent for translation are governed by that provider's respective privacy policy. When using local Ollama models, 100% of data stays on your local machine.

## 5. 联系方式（Contact）

如对本隐私政策有任何疑问，请通过 GitHub Issues 联系开发者：[https://github.com/zhangsubo/bo-translation/issues](https://github.com/zhangsubo/bo-translation/issues)。

If you have any questions regarding this Privacy Policy, please contact the developer via GitHub Issues: [https://github.com/zhangsubo/bo-translation/issues](https://github.com/zhangsubo/bo-translation/issues).
