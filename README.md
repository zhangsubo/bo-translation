# Bo Translation · Chrome 沉浸式双语对照插件

围绕**同一次阅读闭环**展开的网页与技术文档双语对照扩展：读到哪里译到哪里，支持「原文 / 双语对照 / 仅看译文」三态切换、悬停单段翻译、结合段落上下文的划词释义（支持多模型并排对比与一键存为术语）、单段重译，以及 OpenAI 兼容接口与本地 Ollama 零配置直连。

## 核心特性

- **读到哪里译到哪里**：`IntersectionObserver` 视口预加载 + `150ms` 驻留防抖 + `ID | text` 聚合流式输出 + 滚动锚点防抖动。
- **技术文档无损富文本**：自动跳过 `<pre>` 与主流代码编辑器；行内 `<code>`、`<kbd>` 及 API 文档符号链接 `a:has(code)` 采用 `{{n}}` 原子硬锁，普通超链接与加粗采用 `<a0>` 去属性翻译并逆序安全还原。
- **无损三态与 6 款样式**：支持「原文 ↔ 双语对照 ↔ 仅看译文（支持修饰键悬停偷看原文）」瞬时切换，内置引线文档风、默认纯净、柔和弱化、虚线下划线、荧光马克笔、模糊遮罩 6 款样式。
- **阅读微交互**：侧边可拖拽贴边半隐悬浮快捷签、自定义键盘快捷键（兼容 macOS `Option` 组合键）、悬停段落单段对照、单段换模型重译、划词多服务对比与一键「+ 术语」。
- **OpenAI 兼容 & 本地 Ollama 免配**：支持配置多个服务实例（内置 OpenAI、MiniMax、Xiaomi MiMo、Xiaomi MiMo Token Plan、Kimi、Kimi Code、Ollama 本地模型与自定义 OpenAI 兼容预设），通过 MV3 动态 `declarativeNetRequest` 自动对齐本地 `Origin` 请求头与 Kimi Code 客户端标识，无需手动配置 `OLLAMA_ORIGINS=*`。

## 在 Chrome 中加载使用

1. 安装依赖并构建扩展产物：
   ```bash
   pnpm install
   pnpm build
   ```
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`，开启右上角 **开发者模式（Developer mode）**。
3. 点击左上角 **加载已解压的扩展程序（Load unpacked）**，选择项目下的构建目录：
   ```text
   /Users/zhangsubo/Code/bo-translation/dist/chrome-mv3
   ```
4. 点击右上角插件图标进入 **设置中心**，填入你的模型 API Key（或直接选用本地运行中的 Ollama 模型并点击「测试连接」），即可打开任意英文文章或技术文档体验沉浸式双语阅读。

## 开发与测试命令

```bash
pnpm dev        # 启动开发热更新模式
pnpm test       # 运行 Vitest 单元测试
pnpm typecheck  # 运行严格 TypeScript 类型检查
pnpm build      # 构建生产环境 Chrome MV3 扩展包 (dist/chrome-mv3)
pnpm zip        # 打包发布用 zip 文件
```
