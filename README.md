# Bo Translation · Chrome 沉浸式网页、技术文档与视频双语翻译插件

围绕**同一次深度阅读与观看闭环**设计的 Chrome / Edge MV3 双语对照扩展：读到哪里译到哪里，支持「原文 / 双语对照 / 仅看译文」无损三态切换、悬停单段翻译、结合段落上下文的划词释义（多模型并排对比与一键存为术语）、PDF 左右双语对照与双栏版式复刻、GitHub 与技术文档代码行内注释翻译，以及 YouTube / Bilibili / HTML5 视频双语字幕与本地外挂字幕翻译。

> **立即安装**：[Chrome 应用商店](https://chromewebstore.google.com/detail/cjlblagbngcnlhlgfjihdbkokkjgfned) ｜ [百度网盘 `.crx` 离线包](https://pan.baidu.com/s/1vCkQ-hEtiX8uzahVhVGamQ?pwd=5r6i)（提取码：`5r6i`） ｜ [详细安装说明](#安装方式)

## 核心特性

- **读到哪里译到哪里 & 智能外语感知**：`IntersectionObserver` 视口预加载 + `150ms` 驻留防抖 + `ID | text` 聚合流式输出 + 滚动锚点防抖动；支持浏览器离线检测外语网页自动开启双语（后台隐藏标签页懒启动、手动恢复原文后同 URL 绝不反复打扰、支持一键「此站免译」）。
- **技术文档富文本三阶段容错保护 & 可视化代码块开关**：提供显式「自动跳过代码块」开关（支持网页与 PDF，默认开启并在网页端支持 `Alt`/长按临时点译被跳过的片段）；行内 `<code>`、`<kbd>`、`a:has(code)` 与保持原样术语采用原子占位符保护，配备三阶段降级兜底，防止小参数模型丢失符号或链接。
- **自适应对比度双色排版 & 防裁切同级挂载**：支持「双色智能提亮/压暗（自动采样暗色/亮色背景，保障 WCAG AA ≥ 4.6:1 对比度）」与「原色对照」切换；遇到 `-webkit-line-clamp` 或 `overflow: hidden` 卡片标题时自动同级挂载译文并同步 11 项计算排版属性。
- **GitHub 与技术文档代码行内注释翻译**：在 `github.com` / `gist.github.com` 源码与 Diff 视图及 Prism / Highlight.js / Pygments / Shiki 技术文档代码块中精准提取自然语言注释（自动过滤编译指令与被注释掉的代码），严格单行内联渲染，保持左侧行号 1:1 垂直对齐。
- **PDF 左右双语对照与双栏版式复刻**：支持在线/本地 PDF 左原文右译文并排对照，结合无文本背景画布自动检测图表/公式/分隔线障碍防止译文越界覆盖，译文获取失败时保留原文与重试提示而不留白。
- **YouTube / B站 / HTML5 视频双语字幕**：默认采用零额外请求的原生字幕伴随与被动镜像模式，支持多 `<video>` 面积与可见度智能评分（自动过滤广告流）、原生 `<video>` 全屏 `VTTCue` 轨道兜底、本地 `.srt / .vtt` 字幕挂载，以及免重译即时生效的 `±0.5s` 时间轴同步微调。
- **多模型直连与零配置请求头适配**：内置 **Bilibili Index-Translate（限时免费接口）**、**OpenAI**、**MiniMax**、**Xiaomi MiMo / Token Plan**、**Kimi / Kimi Code**、**本地 Ollama** 与自定义 OpenAI 兼容服务预设，通过 MV3 `declarativeNetRequest` 纯前端零代理完成跨域与客户端标识适配。

## 安装方式

### 方式一：Chrome 应用商店在线安装

适合可访问 Google 商店的网络环境，支持 Chrome、Edge、Arc、Brave 等 Chromium 内核浏览器在线一键添加，后续版本由浏览器自动静默更新：

- **Chrome 应用商店**：<https://chromewebstore.google.com/detail/cjlblagbngcnlhlgfjihdbkokkjgfned>
- 打开详情页后，点击右上角 **添加至 Chrome** 确认安装即可。

### 方式二：百度网盘 `.crx` 离线包安装

适合无法直连 Chrome 商店的国内网络环境，下载离线包后拖入扩展管理页即可完成安装：

- **百度网盘下载**：<https://pan.baidu.com/s/1vCkQ-hEtiX8uzahVhVGamQ?pwd=5r6i>（提取码：`5r6i`，链接已自带提取码参数）
- **安装步骤**：
  1. 从百度网盘将 `.crx` 安装包下载到电脑本地。
  2. 浏览器地址栏访问 `chrome://extensions/`，开启右上角 **开发者模式（Developer mode）**。
  3. 将下载好的 `.crx` 文件直接拖入扩展管理页面空白处，在弹窗中点击 **添加扩展程序** 完成安装。

### 方式三：从源码构建加载（本地开发）

1. 安装依赖并构建扩展产物：
   ```bash
   pnpm install
   pnpm build       # Chrome -> dist/chrome-mv3
   pnpm build:edge  # Microsoft Edge -> dist/edge-mv3
   ```
2. 打开浏览器扩展管理页并开启 **开发者模式（Developer mode）**：
   - **Chrome**：访问 `chrome://extensions/`（右上角开启开发者模式），点击 **加载已解压的扩展程序** 选择 `dist/chrome-mv3`。
   - **Microsoft Edge**：访问 `edge://extensions/`（左侧栏开启开发人员模式），点击 **加载解压缩的扩展** 选择 `dist/edge-mv3`。

> 安装完成后默认内置 **Bilibili Index-Translate** 免费接口开箱即用，在任意外文网页按 `Alt + A` 或点击页面右侧悬浮快捷签即可开启双语对照；也可点击右上角插件图标进入 **设置中心**，填入你的模型 API Key 或本地 Ollama 地址，点击「测试连接」后使用。

## 开发与测试命令

```bash
pnpm dev         # 启动 Chrome 开发热更新模式
pnpm dev:edge    # 启动 Microsoft Edge 开发热更新模式
pnpm test        # 运行 Vitest 单元测试套件
pnpm typecheck   # 运行严格 TypeScript 类型检查
pnpm build       # 构建生产环境 Chrome 扩展包 (dist/chrome-mv3)
pnpm build:edge  # 构建生产环境 Edge 扩展包 (dist/edge-mv3)
pnpm zip         # 打包 Chrome 发布用 zip 文件
pnpm zip:edge    # 打包 Microsoft Edge Add-ons 提审用 zip 文件
```

## 致谢 (Acknowledgments)

### 开源项目与免费接口致谢

- **[KISS Translator](https://github.com/fishjar/kiss-translator)** 与 **[Immersive Translate (沉浸式翻译)](https://github.com/immersive-translate/immersive-translate)**：本项目在 DOM 段落识别、双语对照交互闭环与站点规则设计上深受这两个优秀项目的启发。
- **[Bilibili Index-Translate](https://github.com/bilibili/Index-Translate)**：感谢阿B开源高质量翻译大模型并提供限时免费接口（**感谢阿B限时免费接口**）。
- **[WuPage](https://github.com/mr-wuliu/wupage)**：感谢其在富文本占位符多级容错兜底、背景对比度自适应着色、防裁切排版同步、无打扰外语自动翻译以及 GitHub 代码注释翻译等细节工程实践上的优秀思路。

### 我在付费订阅的模型与 AI 工具

以下是我日常主力付费订阅并用于本项目开发、测试与日常翻译的模型及工具服务：

- **[小米 MiMo (Xiaomi MiMo)](https://platform.xiaomimimo.com?ref=T56CN9)**（注：含个人推广链接 / 带 aff）
- **Google Antigravity**
- **MiniMax**
- **Kimi (Moonshot AI / Kimi Code)**
