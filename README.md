# Tab Agent

说一句中文要什么表，模型给出整份工作簿，代码校验后落笔，右边实时预览，点一下就下载。
没有模板概念，没有表格结构要你手填。

- **运行时零依赖。** `package.json` 里没有 `dependencies`。XLSX 读写是手写的
  （`lib/zip.ts` + `lib/xlsx*.ts`），唯一的外部包 postject 只在打包时用。
- **模型只写「数据」，不写「文件」。** 它输出一份 workbook spec（JSON），把 spec
  变成 xlsx 字节的是确定性代码。同一份 spec 每次产出字节相同的文件。
- **模型的话不算数。** 它只能*声明*意图，不能直接改单元格。见下面的三道闸。

## 快速开始

需要 Node 24 及以上（测试用的 `tools/dev-resolve.js` 依赖 `module.registerHooks`）
和 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 可自动对齐）。

```powershell
pnpm install                    # 只装开发依赖：typescript / tsx / @types/node / postject，
                                # 外加 .verify/ 的 exceljs
pnpm start --port 3179          # 先跑 tsc，再启动 .build/js/server.js
```

源码是 `server.ts` / `desktop.ts` / `lib/*.ts`，仓库里没有可以直接 `node` 的 `.js`。
`pnpm start` 和 `pnpm desktop` 启动前都会先编译（`prestart` / `predesktop`），
跑的永远是最新代码；直接 `node .build/js/server.js` 则需要自己先 `pnpm build:js`。

`pnpm start:dev` 用 tsx 直接跑 `server.ts`，省掉编译步骤。它只擦类型、不做类型检查，
而且跑的是 esbuild 的转译结果而不是 `tsc` 的产物——出现「开发正常、打包后不对」时，
先用 `pnpm start` 复现。

打开 http://127.0.0.1:3179，在中间输入框写一句话，比如「做一个销售台账，三个客户，
金额和签约日期」，回车。

想直接在桌面窗口里跑（不需要打包）：

```powershell
pnpm desktop
```

桌面窗口用的是 Microsoft Edge 的 app 模式，Windows、macOS、Linux 都会去常见安装
位置找。找不到 Edge 不算失败：服务照常起来，终端单独打印一行地址，用任意浏览器
打开即可。

**开始之前要先配模型。** 这个应用没有内置规则可退——没配模型时它会直接落到设置页，
并在状态栏说明原因。配一次就好。

端口和数据目录都支持环境变量，优先级一律是 **命令行开关 > 环境变量 > 默认值**，
只有一套规则要记：

```powershell
$env:TAB_AGENT_PORT = 3179      # 等价于 --port
$env:TAB_AGENT_HOME = "D:\xl"   # 等价于 --data-dir
pnpm start
```

开发模式下不指定时，数据目录是仓库根目录的 `data/`（已被 `.gitignore` 忽略）。

`TAB_AGENT_PORT=0` 是合法的，意思是「让系统挑一个空闲端口」，不是「没设置」。
给了非法值（非整数、超出 0–65535）会**直接报错退出，并说明是哪个设置错了**——
静默退回默认端口的样子，跟这个变量完全没生效是一样的，那种难查不值得省。

## 界面

三栏：左边会话列表，中间对话，右边表格预览。左、右两条 5px 分隔条可以拖动，
双击复位，宽度记在本地。

打开时是空的，三张建议卡点一下把文字**填进输入框**（不直接发送——「把上面这张表
按金额排序」这种话，没有上文是没法执行的），确认或改完再回车。

一次对话的生命周期：

1. 你说要什么表 → 模型输出一份完整 spec → 校验 → 预览出现在右栏。
2. 你接着说「加一列备注」「金额那列改成两位小数」→ 模型输出**新的整份 spec**。
3. 你点下载 → 拿到 `.xlsx`。

会话存在磁盘上（存 spec，不存文件字节），关掉窗口下次还在。

## 三道闸：模型不能直接改表

这是整个设计的核心。模型输出的是*提议*，不是结果。

| 闸 | 位置 | 作用 |
|---|---|---|
| `looksLikeWork` | [lib/agent.ts](lib/agent.ts) | 便宜的预筛。问句根本走不到能替换工作簿的代码路径。 |
| `intent` | 同上 | 模型必须在回复里显式声明意图（`answer` / `action` / `question`）。只有 `action` 可以携带 spec，而且必须真的携带。 |
| `guardChange` | 同上 | 确定性校验。不看模型对自己的评价，只看这份 spec 和上一份比改了什么。 |

于是这些情况都不会造成事故：模型答得很自信但没给 spec（降级成回答）、
声明要改却没给内容（降级成反问）、改出结构性破坏（被拦下并说明原因）。

分不清是提问还是命令时，它选回答或反问，**不选修改**。

## 接入模型

设置页填三项，点「测试连接」会发一次最小请求并把服务商的原文回显——
key 错、模型名错、地址错是三种不同的修法，不会糊成一句「连接失败」。

| 字段 | 说明 |
|---|---|
| 接口地址 (baseUrl) | 任何 OpenAI 兼容的 `/v1` 地址 |
| API key | 自己填，只存在本机 |
| 模型名 (model) | 你账号可用的模型名 |

设置页只暴露两个开关：

- **允许对话修改字段** — 关掉后模型只能回答，不能改表。
- **修改前需要确认** — 默认开。关掉后修改直接落到预览。

> **存前须知：** key 以**明文**存在数据目录的 `settings.json`（仅本机用户可读，
> 未加密）。附件内容会发给你填的接口地址。

`useForAttachments` 是后端设置项，目前没有 UI 出口。

### 快捷键

| 键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| `Esc` | 关闭浮层 |

## HTTP 接口

除下载外全部返回 JSON。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `app` 标识 + 附件数 + 模型是否已配置 |
| GET | `/api/settings` | 模型配置（**不含 key**，只回 `hasKey` 与掩码提示） |
| POST | `/api/settings` | 保存 key / baseUrl / model / 开关，只接受白名单字段 |
| POST | `/api/settings/test` | 发一次最小请求验证连接，错误原文透传 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建会话 |
| GET | `/api/sessions/:id` | 会话详情 + 当前预览 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/sessions/:id/turn` | 发一句话，返回意图 / 回复 / 待确认的修改 |
| POST | `/api/sessions/:id/apply` | 确认或放弃待确认的修改 |
| GET | `/api/sessions/:id/workbook.xlsx` | 下载当前 `.xlsx` |
| POST | `/api/attachments` | `multipart`，字段 `files`（可多个） |
| GET / DELETE | `/api/attachments` | 列出 / 清空 |

`/api/health` 返回的 `app: 'tab-agent'` 不是装饰——桌面端的单实例判定靠它。
之前它靠的是「响应里有没有 `templates` 字段」，模板概念一删就会静默失灵，
第二个实例会照常启动。测试里钉了这条断言。

## 构建桌面客户端

```powershell
pnpm install                       # 开发依赖（postject 只在这里用到）
pnpm build                         # -> dist/TabAgent.exe（约 90 MB）
```

> 打包前先确认没有实例在跑，否则会 `EBUSY`——目标文件被锁着。
>
> 目前只产出 Windows 的 `.exe`：打包流程假定载体是 `node.exe`，CI 也只在
> `windows-latest` 上构建。macOS / Linux 请用上面的 `pnpm desktop`。

双击即可运行。端口自动挑空闲的（不会和开发时起的服务撞车），关掉窗口即退出。
数据目录（`TAB_AGENT_HOME` 可覆盖）：

| 平台 | 默认位置 |
|---|---|
| Windows | `%APPDATA%\ETabAgent\` |
| macOS | `~/Library/Application Support/ETabAgent/` |
| Linux | `~/.local/share/ETabAgent/` |

命令行开关：

| 开关 | 作用 |
|---|---|
| `--headless` | 只起服务并打印地址，不开窗口（供自动化验证用） |
| `--port <n>` | 固定端口，不自选 |
| `--data-dir <p>` | 覆盖数据目录 |
| `--debug-assets` | 打印资源解析诊断后退出（排查页面空白用） |
| `--new-instance` | 无视已在运行的实例，强行再起一个 |
| `--extensions` | 应用窗口加载浏览器插件（默认不加载；也可设 `TAB_AGENT_EXTENSIONS=1`）。需先关掉所有应用窗口才生效 |

**打包是怎么回事**（[tools/build-exe.js](tools/build-exe.js)）：

0. **编译 TypeScript。** 直接跑 `tsc -p tsconfig.json`（和 `pnpm build:js`
   同一条命令），把 `lib/*.ts` 和两个入口发射成 `.build/js/` 下的 `.js`
   （`module: commonjs`），顺带做一次类型检查。这一层曾经是
   `stripTypeScriptTypes`，但它只擦类型不改模块语法，`export` 会留在产物里而
   打包器把它包进函数体直接语法报错。
1. **合并模块。** SEA 的 `require` 只认内置模块，`require('./lib/x')` 会报
   `ERR_UNKNOWN_BUILTIN_MODULE`。[tools/bundle.js](tools/bundle.js) 把 14 个模块
   合并成一个文件（手写，不引入打包器）。
2. **内嵌资源。** `public/` 下 16 个文件作为 SEA assets 嵌入，`lib/assets.ts` 用
   `sea.getAsset()` 读。
3. 生成 manifest → 4. 生成 blob → 5. 复制 `node.exe` 并注入（postject）。

**两个代价**：约 90 MB（整个 Node 运行时在里面，SEA 的固有成本）；
数字签名失效（postject 改了 `node.exe`，首次运行大概率弹 SmartScreen）。

## CI 与发布

两条 GitHub Actions 工作流，权限按需分开：

- **[ci.yml](.github/workflows/ci.yml)** — 每次推送和 PR 触发。Linux 上跑类型检查、
  编译、`pnpm test` 和合并器检查；通过后在 Windows 上打包 exe，用 `--headless`
  启动它并读 `/api/health` 做冒烟测试，产物作为 artifact 上传。
- **[release.yml](.github/workflows/release.yml)** — 推送 `vX.Y.Z` 标签触发，
  构建并验证 exe，连同 SHA256 校验和一起挂到 GitHub Release 上。

```powershell
git tag v0.1.0
git push origin v0.1.0
```

标签必须是 `vX.Y.Z` 格式，且和 `package.json` 的 `version` 一致，否则直接失败——
没有别的东西在保持这两者同步。

`.verify/live-*.js` 不在 CI 里：它们要开真实的 Edge 窗口、用 CDP 发真实鼠标事件，
还依赖 PowerShell 和已登录的桌面会话，托管 runner 都没有。

## 验证

```powershell
pnpm typecheck                   # tsc --noEmit
pnpm build:js                    # 先编译（测试跑在 .build/js，pnpm test 不会自动编译）
pnpm test                        # 静态导入检查 + 236 项核心测试
pnpm bundle                      # 合并器：依赖图无环、无第三方模块
pnpm verify:live                 # 先重新打包 exe，再跑真机探针子集（需要 Windows 桌面 + Edge + 已配模型）
```

`pnpm test` 先跑 `.verify/check-imports.cjs`：前端 ES 模块如果调用了一个没导入的
名字，只有用户点到那个按钮时才会炸，这一步把它提前到测试里。

`lib/` 只放 TypeScript 源，**没有 `.js` 双胞胎**。运行树是 `.build/js/`，由
`tsc`（`pnpm build:js`）生成；`lib/*.ts` 是唯一源。测试和 `.verify/` 之所以能继续写
`require('../lib/x')`，是因为 `tools/dev-resolve.js`（Node 24 的
`module.registerHooks`）在解析期把它重定向到构建树——测试因此一个字都不用改，
构建布局也不渗进测试。开发入口不需要这个钩子：编译产物之间的相对 `require`
本来就落在 `.build/js/` 里。

Windows 注意：`node --test tests/` 不认目录，必须写 glob。

`.verify/` 是 pnpm workspace 的子包，唯一的依赖 exceljs 随根目录的 `pnpm install`
一起装好（CI 用 `--filter tab-agent` 跳过它，因为这些探针不在 CI 里跑）。
里面的探针分两类，都值得跑：

- **离线对照** — `verify.js` 用 exceljs 独立实现比对同一份输入；
  `workbook-verify.js` 比对落笔结果。
- **真机** — `live-agent.js` / `live-session-api.js` / `live-ui.js` /
  `live-attachments.js` / `live-port.js` / `live-exe.js` / `live-click.js`。
  这一类打的是真实 HTTP、真实进程、真实模型，用 CDP 发真实鼠标事件
  （不是 `element.click()`——那个跳过命中测试，有浮层盖着也发现不了）。

## 已知限制

- **PDF 不解析。** 附件里的 PDF 会被明确标记为不支持，不会静默忽略。
- **图片 / 文档的模型解析要自己配 key；未配置时回退到内置规则**
  （图片只能读尺寸，文档能读文字），不报错。
- **附件模块目前没有 UI 入口。** 路由和解析都在，前端还没接回去。
- **拖动宽度是窗口属性**，记在本地，不随会话走。
- **一次一个工作簿。** 每个会话只保留当前这一份 spec。
- **打包版只有 Windows。** macOS / Linux 能跑开发入口和桌面窗口，但还没有
  可执行文件；macOS 注入后的代码签名也还没处理。
