# Tab Agent

说一句中文要什么表，模型给出整份工作簿，代码校验后落笔，右边实时预览，点一下就下载。
没有模板概念，没有表格结构要你手填。

- **运行时零依赖。** `package.json` 里没有 `dependencies`。XLSX 读写是手写的
  （`lib/zip.ts` + `lib/xlsx*.ts`），唯一的外部包 postject 只在打包时用。
- **模型只写「数据」，不写「文件」。** 它输出一份 workbook spec（JSON），把 spec
  变成 xlsx 字节的是确定性代码。同一份 spec 每次产出字节相同的文件。
- **模型的话不算数。** 它只能*声明*意图，不能直接改单元格。见下面的三道闸。

## 快速开始

```powershell
node server.js --port 3179
```

打开 http://127.0.0.1:3179，在中间输入框写一句话，比如「做一个销售台账，三个客户，
金额和签约日期」，回车。

想直接在桌面窗口里跑（不需要打包）：

```powershell
node desktop.js
```

**开始之前要先配模型。** 这个应用没有内置规则可退——没配模型时它会直接落到设置页，
并在状态栏说明原因。配一次就好。

端口和数据目录都支持环境变量，优先级一律是 **命令行开关 > 环境变量 > 默认值**，
只有一套规则要记：

```powershell
$env:TAB_AGENT_PORT = 3179      # 等价于 --port
$env:TAB_AGENT_HOME = "D:\xl"   # 等价于 --data-dir
node server.js
```

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
npm install --strict-ssl=false     # 只装 postject（开发期）
node tools/build-exe.js            # -> dist/TabAgent.exe（约 90 MB）
```

> 打包前先确认没有实例在跑，否则会 `EBUSY`——目标文件被锁着。

双击即可运行。数据目录在 `%APPDATA%\TabAgent\`，端口自动挑空闲的（不会和开发时
起的服务撞车），关掉窗口即退出。

命令行开关：

| 开关 | 作用 |
|---|---|
| `--headless` | 只起服务并打印地址，不开窗口（供自动化验证用） |
| `--port <n>` | 固定端口，不自选 |
| `--data-dir <p>` | 覆盖数据目录 |
| `--debug-assets` | 打印资源解析诊断后退出（排查页面空白用） |
| `--new-instance` | 无视已在运行的实例，强行再起一个 |

**打包是怎么回事**（[tools/build-exe.js](tools/build-exe.js)）：

0. **编译 TypeScript。** [tools/build-js.js](tools/build-js.js) 调 `tsc`，把
   `lib/*.ts` 发射成 `.build/js/lib/*.js`（`module: commonjs`）。仍未迁移的
   几个入口文件原样拷过去。这一层曾经是 `stripTypeScriptTypes`，但它只擦类型
   不改模块语法，`export` 会留在产物里而打包器把它包进函数体直接语法报错。
1. **合并模块。** SEA 的 `require` 只认内置模块，`require('./lib/x')` 会报
   `ERR_UNKNOWN_BUILTIN_MODULE`。[tools/bundle.js](tools/bundle.js) 把 14 个模块
   合并成一个文件（手写，不引入打包器）。
2. **内嵌资源。** `public/` 下 16 个文件作为 SEA assets 嵌入，`lib/assets.ts` 用
   `sea.getAsset()` 读。
3. 生成 manifest → 4. 生成 blob → 5. 复制 `node.exe` 并注入（postject）。

**两个代价**：约 90 MB（整个 Node 运行时在里面，SEA 的固有成本）；
数字签名失效（postject 改了 `node.exe`，首次运行大概率弹 SmartScreen）。

## 目录

```
lib/                 零依赖核心（TypeScript 源，12 个模块 + 2 个未迁移）
  zip.ts                 ZIP 容器读写（ZIP64、data descriptor、deflate）
  xlsx.ts                SpreadsheetML 读取
  xlsx-writer.ts         工作簿写入（从零构建 + styles）
  workbook.ts            spec 归一化 / 校验 / 落笔
  workbook-preview.ts    网格预览 + 格式码
  agent.ts               对话轮：三道闸都在这里
  session-store.js       会话持久化（存 spec 不存字节）
  attachments.ts         附件解析（CSV / JSON / docx；PDF 显式标记不支持）
  extract.ts             中文取值抽取
  formula.ts             公式缓存重算
  llm.ts                 模型调用（OpenAI 兼容，错误原文透传）
  settings.ts            配置读写（key 不回客户端）
  assets.ts              UI 资源注册表（内嵌 / 磁盘二选一）
  server.js              HTTP API（未迁移）
public/              前端（原生 ES 模块，无构建步骤，17 个文件）
  index.html             外壳
  css/app.css            主题
  js/app.js              控制器
  js/{api,state,dom,ui,icons,colname,composer,splitters}.js
  js/views/{chat,sessions,preview,sheet,settings}.js
server.js            开发入口（只起服务，默认端口 3179）
desktop.js           桌面入口（起服务 + Edge 窗口，也是 SEA 的 main）
tools/               开发工具（编译 + 打包器 + 合并器 + 示例生成）
tests/               node:test 测试
.verify/             开发期外部验证（exceljs 对照 + 真机 + 打包 exe + CDP 点击）
dist/                构建产物（不入库）
```

## 验证

```powershell
npm run build:js                 # 先编译（测试与开发入口都跑在 .build/js）
npm test                         # 231 项核心测试
node tools/verify-bundle.js      # 合并器：依赖图无环、无第三方模块
```

`lib/` 只放 TypeScript 源，**没有 `.js` 双胞胎**。运行树是 `.build/js/`，由
`tools/build-js.js` 生成；`lib/*.ts` 是唯一源。测试和开发入口之所以能继续写
`require('../lib/x')`，是因为 `tools/dev-resolve.js`（Node 24 的
`module.registerHooks`）在解析期把它重定向到构建树——测试因此一个字都不用改，
构建布局也不渗进测试。开发入口已通过 `--require` 自动带上这个钩子。

Windows 注意：`node --test tests/` 不认目录，必须写 glob。

`.verify/` 里的探针分两类，都值得跑：

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
