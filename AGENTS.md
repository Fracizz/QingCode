# QingCode Next 开发约定

先读 [MVP 设计](docs/mvp.md)，它是 MVP 架构、协议和接口的唯一依据，只读。再读对应的 `docs/tasks/Tn-*.md`，按卡片的范围修改、按验收项验证。文件工作区、Git、终端等后续功能可从[路线图](docs/roadmap.md)定位任务卡。文档未明确的细节采用最简单可行方案，交付时注明假设。

## 改动从哪里入手

桌面请求从 renderer 经 MessagePort 到 backend，再连接目标机上的 daemon。本机和 SSH 目标运行同一份 server。手机通过已配对电脑的网关访问目标。

双端功能与交互变化记录在[电脑版与手机版能力对齐](docs/client-capabilities.md)。

| 改动内容 | 代码入口 |
| --- | --- |
| backend 与 daemon 之间的帧、请求和事件类型 | `packages/protocol/src`。Codex 官方协议生成物在 `vendor/codex-protocol`，只读。 |
| 目标机上的 Agent 会话、文件、Git、终端 | `packages/server/src`。文件和 Git 操作在 `workspace/`，终端在 `terminal/`。 |
| 桌面与手机共用的对话状态、额度、RPC | `packages/codex-client/src`。两端共用的消息处理逻辑放在这里。 |
| Electron 进程间调用、SSH、部署 | `apps/desktop/src/shared/backendApi.ts` 定义桌面调用契约；`apps/desktop/src` 下的 `backend/` 负责连接与部署，`main/` 负责原生窗口和 safeStorage，`preload/` 暴露桥接接口。 |
| 桌面界面 | `apps/desktop/src/renderer/src`。文件、Git、终端、设置等功能在 `features/`，布局遵循[桌面 UI 规范](docs/design/ui-shell.md)。 |
| 手机界面、原生能力、电脑侧网关 | `apps/mobile/web/src`、`apps/mobile/android`、`apps/desktop/src/backend/mobile`。新增手机 RPC 时核对网关白名单。 |

## 实现约束

- 改 Codex、Claude 或 pi 前读 [Agent 适配规范](docs/agent-adapters.md)，合规条款优先。daemon 负责 Codex 初始化。适配器只用获准的公开接口，认证交给官方程序，审批由用户决定。日志禁止输出 token、密码或私钥。
- TypeScript strict、ESM、两空格、单引号。分号沿用文件风格，默认省略。中文注释说明原因。纯逻辑与 I/O 分离，Vitest 单测就近放在 `*.test.ts`。
- UI 颜色只用 `@theme` token。可输入控件外框对比度 ≥ 3:1，次要文字 ≥ 4.5:1，详见[对比度规范](docs/design/contrast.md)。
- Node 侧仅用内置模块和任务卡允许的已装依赖。禁止运行 `pnpm install`、`pnpm add`、`npm install` 或下载资源。任何 `package.json`、`pnpm-lock.yaml` 和根配置均不得修改。缺依赖时报告名称和用途，由总管处理。
- 旧项目 `D:\code\qingcode` 只读。禁止执行 `git commit`、`git push`、`git checkout`、`git stash`，由总管审查后提交。

## 开发与验收

以下命令从仓库根运行。桌面联调用 `pnpm dev`，它先构建 server，再启动 Electron。

| 场景 | 命令或验收入口 |
| --- | --- |
| 类型检查 | 桌面用 `pnpm --filter @qn/desktop typecheck`，覆盖 Node 和 Web 两套配置。其他包用 `pnpm exec tsc -p <包路径>/tsconfig.json`。 |
| 定向测试 | `pnpm exec vitest run <改动目录>`。例如手机网关联动可用 `pnpm exec vitest run apps/mobile/web/src apps/desktop/src/backend/mobile`。 |
| 全仓回归 | `pnpm check` 运行各包类型检查和 Vitest。 |
| 平台验收 | 手机 Web 构建用 `pnpm --filter @qn/mobile build:web`。原生改动见 [Android 测试说明](apps/mobile/android/tests/README.md)，Windows 目标见 [Windows 验收说明](docs/windows-acceptance.md)。 |

交付时列出改动文件、实现要点、验证命令及结果、未完成项与假设，以及需总管处理的依赖或跨包接口问题。
