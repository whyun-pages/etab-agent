# 更新日志

本文件记录每个版本的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- 默认数据目录从 `TabAgent` 改名为 `ETabAgent`（如 Windows 上的 `%APPDATA%\ETabAgent\`）。
  旧目录不会自动迁移：升级后需重新填写模型设置，历史会话留在旧目录中，可手动拷贝或删除。
- 对话历史按字符预算（4000 字）带给模型，不再固定只带最近 4 条、每条截到 300 字。
  用户消息最多保留 2000 字，助手回复最多 800 字；超出预算的更早消息会注明「未列出」。

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
