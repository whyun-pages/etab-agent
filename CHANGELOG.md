# 更新日志

本文件记录每个版本的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 对话可以**保存文件**：说「保存成 csv」「导出 json」，模型调用 `save_file`，文件写进设置里的
  导出目录（默认下载文件夹）。保存在本轮修改真正落盘之后执行；等待确认的修改在确认后保存，
  被拦下或冲突的修改不保存。同名文件不覆盖，自动编号。设置项「允许对话保存文件」默认开。
- 对话可以**联网抓取**：模型调用 `fetch_url` 读取网页、CSV、JSON、xlsx，带 `importAs` 时把表格整张
  导入为工作表（大表不必让模型逐格抄写）。默认关闭；黑名单模式，可在设置里填「禁止抓取的网站」。
  内网地址、重定向到内网、超过 5 MB 或 20 秒的请求一律拒绝。
- 下载支持 **CSV 和 JSON**：预览栏下载按钮旁可选格式；接口为 `workbook.csv` / `workbook.json`，
  `?sheet=` 指定工作表。CSV 带 BOM，并对以 `=` `+` `-` `@` 开头的文本做公式注入防护。
- `.m3u` / `.m3u8` 播放列表（抓取或上传）读成表格：频道名、各项属性（标识名、分组、台标……）、播放地址，
  可整张导入。
- 附件和抓取支持旧版 **`.xls`**（Excel 97-2003）：按文件内容识别，扩展名写错的也能读；每个工作表读成一张表。
  之前这类文件会被报「无法识别内容类型」。加密或 Excel 95 格式的文件会提示原因。
- 抓取或保存的开关关闭时，模型会告诉用户去设置里打开，而不是说自己没有这项能力。

### 修复

- 测试偶发失败：本机动态端口范围从 1024 开始时，测试服务器偶尔分到 `fetch` 拒绝的端口
  （5060、6000、6665–6669、10080 等），报 `fetch failed: bad port`。测试改用 `tests/listen.js`
  监听，分到这类端口会换一个。

### 变更

- 对话轮改用 [pi-agent](https://github.com/badlogic/pi-mono)（`@mariozechner/pi-agent-core` +
  `@mariozechner/pi-ai`）。模型不再每轮输出整份表格，而是调用工具增量修改：`create_workbook`、
  `update_cells`、`add_rows`、`delete_rows`、`add_columns`、`remove_columns`、`update_columns`、
  `sort_rows`、`set_totals`、`add_sheet`、`remove_sheet`、`rename`，另有 `read_rows`（读取未列出的行）
  和 `ask_user`（信息不够时反问）。行按编号、列按列名定位；工具参数写错时报错交回模型改正。
  大表不再因为整份重写而撞上输出上限。
- 意图改为由结构推出：有编辑工具成功执行才算修改，模型自报的 `intent` 字段不再使用。
  关闭「允许修改」时，模型拿不到任何编辑工具。删行保护对一轮内的累计结果判定。
- 设置页新增「接口协议」：OpenAI 兼容（默认）、Anthropic Messages、Google Gemini。
  旧的设置文件没有这一项，按 OpenAI 兼容处理。
- 两轮对话同时修改同一个会话时，服务端把后完成那轮的操作重放到最新的表上，不再用它开始时的
  快照覆盖，先完成那轮的修改不会丢；行号已对不上时该轮不落盘并在回复里说明。
- 只返回整段 JSON、不支持流式输出的接口会明确报错（以前能读这种响应；pi-ai 只读事件流）。
- 运行时不再零依赖：新增 pi-agent 两个包。打包改用 esbuild，exe 体积基本不变（约 92 MB）。

- 默认数据目录从 `TabAgent` 改名为 `ETabAgent`（如 Windows 上的 `%APPDATA%\ETabAgent\`）。
  旧目录不会自动迁移：升级后需重新填写模型设置，历史会话留在旧目录中，可手动拷贝或删除。
- 对话历史按字符预算（4000 字）带给模型，不再固定只带最近 4 条、每条截到 300 字。
  用户消息最多保留 2000 字，助手回复最多 800 字；超出预算的更早消息会注明「未列出」。
- 会话记录每次真正生效的表格修改（用户原话 + 由代码比较前后表格得出的变化），
  最近 10 次随「当前状态」一起发给模型。早期对话滑出历史窗口后，模型仍知道表格经历过哪些修改。
  被拒绝、只读模式下未生效的提议不会记入。
- 应用窗口默认不加载浏览器插件（`--disable-extensions`）。窗口里登录 Edge 账号后，同步会把
  日常插件装进应用的配置目录并注入页面。需要插件时用 `--extensions` 或 `TAB_AGENT_EXTENSIONS=1`。
- 会话列表可以折叠成窄条（列表标题栏的按钮，或 Ctrl+B），折叠状态在窗口里记住；
  折叠条上仍可新建会话，展开后恢复拖动过的宽度。

### 修复

- 带附件发送后，聊天气泡里出现整段 `--- 附件资料 ---`。附件内容现在只在当轮发给模型，
  不再存进会话；消息下方改为显示附件文件名。附件保留期间不会在每轮重复存一份，
  也不再占用历史记录的预算。
- 对话时提示「请求超时（60 秒）」：模型生成整份表格（尤其是推理模型）常超过 60 秒。
  对话请求改为流式，按「60 秒没有任何输出」判断超时，总时长上限 5 分钟；
  连接测试和附件识别仍为一次性请求。
- 窗口宽度小于 820px 时聊天栏消失、只剩表格预览：隐藏的列被移出网格，后面各列错位。
- 问与表格无关的问题时，模型有时拒答或把话题拉回表格：提示词明确要求照常回答。
- 模型在回复里用了未转义的英文引号时，界面会显示一整段原始 JSON：解析时现在会修复
  字符串里未转义的引号和换行。

## [0.1.1] - 2026-10-04

### 新增

- 发布到 npm：`@whyun/etab-agent`，安装后提供 `etab` 命令（等同于启动桌面入口）。
- `LICENSE`（MIT），`package.json` 补充 `license`、`repository`、`homepage`、`bugs`。
- `publish.yml`：推送 `v*` tag 时校验版本号、跑测试，再带 provenance 发布到 npm。
- 桌面入口在 macOS 和 Linux 上也能找到 Edge；找不到浏览器时打印可点击的地址，
  服务照常运行。

### 变更

- 包管理切换到 pnpm（版本由 `packageManager` 固定），TypeScript 改由 `tsc` 直接编译。
- `pnpm start` / `pnpm desktop` 运行编译产物，启动前自动编译。

### 修复

- Windows 上运行 `etab` 弹出「打开方式」对话框。0.1.0 的 npm 包用了过期的编译产物，
  入口缺少 shebang；现在 `prepack` 每次打包前重新编译，shebang 放在独立的 `cli.ts`
  入口里，不影响 exe 打包。
- 开发入口所有页面 404（`/api/health` 却正常）：编译后的入口把 `.build/js/` 当成了
  仓库根目录，找不到 `public/`。

## [0.1.0] - 2026-09-26

首个版本。

- 用中文描述想要的表格，模型生成 workbook spec，代码校验后写成 xlsx，右侧实时预览，
  一键下载。
- 运行时零依赖：ZIP 与 XLSX 读写均为手写实现。
- Windows 单文件可执行程序（Node SEA），通过 GitHub Release 发布，附 SHA256 校验和。

[Unreleased]: https://github.com/whyun-pages/etab-agent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/whyun-pages/etab-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/whyun-pages/etab-agent/releases/tag/v0.1.0
