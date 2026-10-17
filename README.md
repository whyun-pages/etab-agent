# Tab Agent

说一句中文要什么表，模型用工具建表、改表，代码校验后落笔，右边实时预览，点一下就下载。
没有模板概念，没有表格结构要你手填。

- **模型只写「数据」，不写「文件」。** 它通过工具（新建工作簿、改单元格、加列、
  删行……）修改一份 workbook spec（JSON），把 spec 变成 xlsx 字节的是确定性代码。
  同一份 spec 每次产出字节相同的文件。
- **模型的话不算数。** 回复里说「改好了」不会改动任何东西，只有工具调用才会，
  而且每次调用的结果都要先过校验。见下面的三道闸。
- **对话轮跑在 [pi-agent](https://github.com/earendil-works/pi) 上**
  （`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 1.x），支持 OpenAI 兼容、
  Anthropic、Gemini 三种接口协议。

## 快速开始

需要 Node 24 及以上
和 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 可自动对齐）。

```powershell
pnpm install                    # 运行时依赖 pi-agent（pi-agent-core / pi-ai），开发依赖
                                # typescript / tsx / esbuild / @types/node / postject，
                                # 外加 .verify/ 的 exceljs
pnpm start --port 3179          # 先跑 tsc，再启动 .build/js/server.js
```

源码全部在 `src/` 下（TypeScript），仓库里没有可以直接 `node` 的 `.js`：

```
src/
  cli.ts server.ts desktop.ts   入口：npm bin、HTTP 服务、桌面窗口
  formats/    zip / xlsx / xlsx-writer / xls 编解码，attachments 把上传文件读成文本或行
  workbook/   spec 校验与落笔、编辑操作（spec-ops）、表查询、预览、导出、公式
  agent/      一轮对话（agent）、模型接入（llm / model / pi）、抓取、本机文件访问、pi-tools/
  store/      settings、session-store：落盘的状态，各自带串行队列
  platform/   SEA 资源读取、用系统默认程序打开文件
  http/       Koa 应用（server）、进程内状态（app-state）、routes/
public/       前端，原样作为静态资源（打包时嵌进 exe）
tests/        node:test 单元与接口测试（.ts，经 tsx 直接跑源码）
.verify/      本机才能跑的端到端检查，按用途分目录（见「验证」）
tools/        构建、打包与静态检查脚本
```

依赖方向自上而下：`http` → `agent` / `store` → `workbook` → `formats`，`platform` 谁都可以用。
同一层的 `agent` 和 `store` 之间有引用：`store/settings` 校验时要用 `agent/` 里协议和文件访问模式的定义。
HTTP 层是 [Koa](https://koajs.com/)：`src/http/server.ts` 组装应用，接口按领域分在 `src/http/routes/` 下。
`pnpm start` 和 `pnpm desktop` 启动前都会先编译（`prestart` / `predesktop`），
跑的永远是最新代码；直接 `node .build/js/server.js` 则需要自己先 `pnpm build:js`。

`pnpm start:dev` 用 tsx 直接跑 `src/server.ts`，省掉编译步骤。它只擦类型、不做类型检查，
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

1. 你说要什么表 → 模型调用 `create_workbook` 给出整张表 → 校验 → 预览出现在右栏。
2. 你接着说「加一列备注」「把第 3 行金额改成 40 万」→ 模型调用**增量工具**
   （`add_columns`、`update_cells`……），只改你说的那部分。
3. 你点下载 → 拿到 `.xlsx`；下载按钮旁可以改选 CSV（导出当前预览的工作表）或 JSON。
   也可以直接在对话里说「保存成 csv」，见下面的[保存与联网抓取](#保存与联网抓取)。

模型看到的当前表格每行都带编号，工具按「行号 + 列名」定位，不按内容去猜哪一行
是哪一行；地址不存在就报错给模型，由它自己改正，而不是就近改到别的行上。

会话存在磁盘上（存 spec，不存文件字节），关掉窗口下次还在。

## 三道闸：模型不能直接改表

这是整个设计的核心。模型的工具调用改的是本轮的*草稿*，不是结果。

| 闸 | 位置 | 作用 |
|---|---|---|
| `looksLikeWork` | [src/agent/agent.ts](src/agent/agent.ts) | 便宜的预筛，结果报给调用方。 |
| 意图由结构推出 | 同上 | 不再让模型自报意图：有编辑工具成功执行才是 `action`，调用了 `ask_user` 是 `question`，其余都是 `answer`。纯文本没有任何途径改表；关闭「允许修改」时连编辑工具都不提供。 |
| `guardChange` | 同上 | 确定性校验，在本轮结束时对**累计结果**判一次：不看模型怎么说，只看草稿和本轮开始时的表比少了多少行。十次小删除按一次大删除算。 |

于是这些情况都不会造成事故：模型嘴上说改好了但没调用工具（回复里会标明「没有形成
可执行的修改」）、工具参数写错（报错交回模型自己改）、改出结构性破坏（被拦下并说明原因）。

落盘时也不直接写回本轮算出的 spec：服务端在会话存储的队列槽里，把本轮的操作列表
**重放**到最新的表上（[src/workbook/spec-ops.ts](src/workbook/spec-ops.ts) 是纯函数，没有并发时结果完全一致）。
两轮对话同时进行时，后完成的那轮不会抹掉先完成那轮的修改；行号已经对不上时，
本轮修改不落盘，并在回复里说明。

分不清是提问还是命令时，它选回答或反问，**不选修改**。

## 接入模型

设置页选协议、填三项，点「测试连接」会发一次最小请求并把服务商的原文回显——
key 错、模型名错、地址错是三种不同的修法，不会糊成一句「连接失败」。

| 字段 | 说明 |
|---|---|
| 接口协议 | OpenAI 兼容（默认）/ Anthropic Messages / Google Gemini |
| 接口地址 (baseUrl) | 该协议的地址。OpenAI 兼容填 `/v1` 地址；Anthropic 不带 `/v1`；Gemini 带版本号（`/v1beta`）。切换协议时，地址和模型名如果还是上一个协议的默认值，会自动换成新协议的默认值；自己填的保持不变 |
| API key | 自己填，只存在本机 |
| 模型名 (model) | 你账号可用的模型名 |

OpenAI 兼容协议默认按保守的兼容设置发请求（系统提示用 `system` 而不是
`developer` 角色、不发 `store` 和工具的 `strict` 字段），照顾各家国产兼容接口。
接口必须支持流式输出（`stream: true`）：只返回一整段 JSON 的接口会明确报错，
而不是当成空回复。

「对话」一组有两个开关：

- **允许对话修改字段** — 关掉后模型只能回答，不能改表。
- **修改前需要确认** — 默认开。关掉后修改直接落到预览。

> **存前须知：** key 以**明文**存在数据目录的 `settings.json`（仅本机用户可读，
> 未加密）。附件内容会发给你填的接口地址。

`useForAttachments` 是后端设置项，目前没有 UI 出口。

### 保存与联网抓取

设置页「保存与联网」一组：

| 设置 | 默认 | 说明 |
|---|---|---|
| 允许对话保存文件 | 开 | 对话里说「保存成 csv」「导出 json」，模型调用 `save_file`，文件写进导出目录 |
| 导出目录 | 空 = 下载文件夹 | 必须是完整路径 |
| 允许对话联网抓取 | **关** | 模型可以调用 `fetch_url` 下载网页 / CSV / JSON / xlsx；带 `importAs` 时把抓到的表格整张导入为工作表 |
| 禁止抓取的网站 | 空 | 每行一个域名，同时禁止其子域名 |

- **保存发生在修改落定之后。** `save_file` 只登记请求，服务端在本轮修改真正写入会话后才导出，
  保存的一定是落盘后的表。修改在等待确认时，确认后才保存；修改被拦下或与并发修改冲突时不保存，
  并在回复里说明。模型只能指定文件名，不能指定目录（「允许读写本机文件」为读写时除外，见下）；
  同名文件不覆盖，自动加 ` (1)`、` (2)`。
- **CSV** 带 UTF-8 BOM（Excel 打开中文不乱码）、CRLF 换行；以 `=` `+` `-` `@` 开头的文本单元格
  前面加 `'`，防止 Excel 把抓来的内容当公式执行。合计行按 xlsx 的同一算法写成数值。
- **抓取的安全限制**（[src/agent/fetch-url.ts](src/agent/fetch-url.ts)）：只允许 http/https；回环、私网、
  链路本地等地址一律拒绝，检查发生在实际连接时（DNS 重绑定绕不过），每次重定向都重新检查，
  最多 5 次；20 秒超时；正文上限 5 MB（按解压后计）。不走系统代理。
- **风险：** 抓取是黑名单模式，不限制能访问哪些网站。抓到的网页可能藏着诱导模型的文字，
  让它把表格数据拼进网址发出去。系统提示要求模型不照做，但这挡不住所有情况——表里有敏感数据时
  不要开启抓取。这是它默认关闭的原因。
- `.m3u` / `.m3u8` 播放列表会读成表格（频道名、标识名、分组、台标、播放地址），可以直接导入。
- 开关关闭时模型拿不到对应工具，但会被告知开关在哪，用户要求抓取或保存时它会提示去设置里打开。
- 导入是一个普通的编辑操作（`create_workbook` 或 `add_sheet`），抓到的行写在操作参数里：
  照样过校验和删行保护，服务端重放时也不会重新联网。

### 读写本机文件

| 设置 | 默认 | 说明 |
|---|---|---|
| 允许读写本机文件 | **关** | 只读：模型可以 `read`、`ls`、`find`、`grep`、`import_file`；读写：另有 `write`、`edit`、执行命令（Windows 上是 `powershell`，其他系统是 `bash`），`save_file` 可指定文件夹 |
| 禁止访问的路径 | 空 | 每行一个：文件夹路径（连同里面的内容）或文件名模式（`*.bak`） |

- 文件工具是 [pi](https://github.com/earendil-works/pi) 的 `read`、`write`、`edit`、`ls`、`find`、`grep`、
  `bash`/`powershell`，源码移植在 [src/agent/pi-tools/](src/agent/pi-tools/)（MIT），每次磁盘访问都经过下面的检查。
  `find`、`grep` 在进程内实现，不下载也不调用 `fd`、`ripgrep`。
- 在对话里给出完整路径（`D:\tmp\box3.zip 统计订单状态`）即可，相对路径以用户主目录为准。`read` 读文本和图片；
  表格要统计时用 `import_file`：读文件、文件夹（最多 4 层、100 个文件、共 200 MB）或 zip，
  读到的每个文件成为会话附件，之后用 `query_table` 统计。
- **始终禁止**（不能在设置里去掉，见 [src/agent/file-access.ts](src/agent/file-access.ts)）：`~/.ssh` 等密钥目录、
  浏览器配置、Windows 凭据、系统目录、本程序的数据目录（存着 API key），以及 `*.pem`、`id_rsa*`、
  `.env` 等文件名。检查在解析符号链接之后进行；`\\` 开头的网络共享路径一律拒绝（在 Windows 上
  访问它就会把当前用户的 NTLM 凭据发给对方）。
- **写入更严：** 只能写文本类文件（txt、md、csv、json……），不能写脚本和可执行文件。
  `write`、`edit` 在本轮中只是记下新内容（本轮后面的读取能看到），本轮结束、修改落定后才真正写入：
  先写临时文件再替换，执行前重新检查路径；修改被拦下时不写。
- **执行命令不受以上任何限制。** 读写模式下模型可以执行命令，命令立即执行，
  能读写这个账户能访问的一切，禁止列表管不到。只在确实需要时选「读写」。
- 只对**本机**发起的请求提供文件工具，设置也只能在本机修改：用 `--host` 开放到局域网时，
  别人的对话读不到这台电脑的文件。
- **风险：** 和联网抓取一样是黑名单模式。读到的文件内容可能诱导模型去读别的文件；
  敏感数据所在的位置请加到禁止列表，或者保持关闭。

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
| POST | `/api/settings` | 保存协议 / key / baseUrl / model / 开关 / 导出目录 / 禁止抓取的网站，只接受白名单字段；不认识的协议、相对路径的导出目录返回 400 |
| POST | `/api/settings/test` | 发一次最小请求验证连接，错误原文透传 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建会话 |
| GET | `/api/sessions/:id` | 会话详情 + 当前预览 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/sessions/:id/turn` | 发一句话，返回意图 / 回复 / 待确认的修改 / 已保存的文件路径（`saved`） |
| POST | `/api/sessions/:id/apply` | 确认或放弃待确认的修改；确认时执行该轮登记的保存 |
| GET | `/api/sessions/:id/workbook.(xlsx\|csv\|json)` | 下载当前表格；`?sheet=` 指定工作表（CSV 默认第一个） |
| POST | `/api/sessions/:id/attachments` | 给该会话添加附件：`multipart`，字段 `files`（可多个） |
| GET / DELETE | `/api/sessions/:id/attachments` | 列出 / 清空该会话的附件（附件只在内存里，重启后需要重新添加） |
| POST | `/api/sessions/:id/attachments/:attId/open` | 用电脑上的默认程序打开附件的副本。只接受本机、本应用页面发来的请求；只打开文档 / 表格 / 图片类扩展名，可执行文件一律拒绝 |

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
   同一条命令），把 `src/**/*.ts` 发射成 `.build/js/` 下的 CommonJS
   `.js`（`module: nodenext` + `package.json` 的 `type: commonjs`），顺带做一次类型检查。这一层曾经是
   `stripTypeScriptTypes`，但它只擦类型不改模块语法，`export` 会留在产物里而
   打包器把它包进函数体直接语法报错。
1. **合并模块。** SEA 的 `require` 只认内置模块，`require('./http/server.js')` 会报
   `ERR_UNKNOWN_BUILTIN_MODULE`。[tools/bundle.js](tools/bundle.js) 用 esbuild
   把项目模块和 npm 依赖（pi-agent 是纯 ESM，经 `import()` 加载）合并成一个
   CommonJS 文件，约 3.7 MB。pi-ai 里设置页没有开放的 provider（Bedrock、Mistral、
   Vertex 等）被替换成占位模块，不打进去。
2. **内嵌资源。** `public/` 下 16 个文件作为 SEA assets 嵌入，`src/platform/assets.ts` 用
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

`.verify/` 不在 CI 里：它们要开真实的 Edge 窗口、用 CDP 发真实鼠标事件，
还依赖 PowerShell 和已登录的桌面会话，托管 runner 都没有。

## 验证

```powershell
pnpm typecheck                   # tsc --noEmit
pnpm test                        # 静态导入检查 + 核心测试（tsx 直接跑 src/，不用先编译）
pnpm bundle                      # 合并器：外部依赖只剩内置模块和已知可选包；探针包拷到没有
                                 # node_modules 的临时目录里，真跑一次请求和一轮带工具调用的对话
pnpm verify:live                 # 先重新打包 exe，再跑真机探针子集（需要 Windows 桌面 + Edge + 已配模型）
```

`pnpm test` 先跑 `tools/check-imports.cjs`：前端 ES 模块如果调用了一个没导入的
名字，只有用户点到那个按钮时才会炸，这一步把它提前到测试里。

`src/` 只放 TypeScript 源，**没有 `.js` 双胞胎**。运行树是 `.build/js/`，由
`tsc`（`pnpm build:js`）生成。测试是 `.ts`，`import` 的就是 `src/` 里的源文件，
经 tsx 运行——编辑器里能跳转、有类型提示，改完源码不用编译就能重跑。
`tests/tsconfig.json` 只给编辑器和手动 `tsc -p tests` 用，不是严格模式，也不卡 `pnpm test`。

代价是测试不再经过编译产物。只有产物会出的问题（`.ts` → `.js` 的说明符改写、
`src/agent/pi.ts` 里保留的动态 `import()`、产物里缺模块）由 `pnpm bundle` 兜住：
它从 `.build/js/` 打包，再拿到没有 node_modules 的目录里真跑。CI 和发布流程都在测试后跑它。

Windows 注意：`node --test tests/` 不认目录，必须写 glob。

`.verify/` 是 pnpm workspace 的子包，唯一的依赖 exceljs 随根目录的 `pnpm install`
一起装好（CI 用 `--filter tab-agent` 跳过它，因为这些检查不在 CI 里跑）。
脚本直接 `node .verify/<目录>/<脚本>.js` 运行；要用源码的脚本自己在开头加载 `tsx/cjs`。
按用途分目录：

| 目录 | 内容 | 需要 |
|---|---|---|
| `node/` | 真实 HTTP / 真实进程，不开浏览器：会话路由、附件路由、端口、并发写、settings 队列（含 sabotage 反证） | 仅 Node |
| `external/` | 用 exceljs 这个独立实现对照：`verify.js` 比对同一份输入，`workbook-verify.js` 比对落笔结果 | exceljs |
| `browser/` | 开发服务器 + 真 Edge，用 CDP 发真实鼠标键盘事件（不是 `element.click()`——那个跳过命中测试，有浮层盖着也发现不了）；模型是假的 | Windows + Edge |
| `model/` | 同上，但接用户本机配置的真实模型 | 另需已配模型 |
| `exe/` | 针对打包好的 `dist/TabAgent.exe`：资源、窗口、单实例、生命周期 | 先 `pnpm build` |
| `shots/` | 截图与测量，产出图片，不判对错 | Windows + Edge |
| `support/` | 共用代码（CDP、假模型 transport）和清理残留进程 / 窗口的脚本 | — |

## 已知限制

- **PDF 不解析。** 附件里的 PDF 会被明确标记为不支持，不会静默忽略。抓取到的 PDF 同样如此。
- **旧版 `.xls` 只读 Excel 97-2003（BIFF8）。** 读单元格值和公式的缓存结果，不读样式与合并单元格；
  Excel 95 及更早的格式和加密文件会明确提示另存为 `.xlsx` 或去掉密码。
- **联网抓取不走代理。** 必须经代理才能上网的环境下，抓取会报连接错误。
- **图片 / 文档的模型解析要自己配 key；未配置时回退到内置规则**
  （图片只能读尺寸，文档能读文字），不报错。
- **附件模块目前没有 UI 入口。** 路由和解析都在，前端还没接回去。
- **拖动宽度是窗口属性**，记在本地，不随会话走。
- **一次一个工作簿。** 每个会话只保留当前这一份 spec。
- **打包版只有 Windows。** macOS / Linux 能跑开发入口和桌面窗口，但还没有
  可执行文件；macOS 注入后的代码签名也还没处理。
