# QingCode Next — 开发约定（给所有 Agent）

先读 `docs/mvp.md`（架构、协议、接口的唯一依据）。涉及 Codex / Claude 等 Agent 的改动必须同时遵守 `docs/agent-adapters.md`（合规红线，优先于 mvp）。旧项目 `D:\code\qingcode` 只读参考，**不得修改**。

## 工作方式

- 你会拿到一张任务卡（`docs/tasks/Tn-*.md`）。**只改任务卡"范围"列出的目录/文件**；多个 Agent 在同一工作区并行，越界修改会互相覆盖。
- **不要运行 `pnpm install` / `pnpm add` / `npm install`**，不要改任何 `package.json`、`pnpm-lock.yaml`、根目录配置。依赖已装好；缺依赖时在最终报告里写明需要什么、为什么，由总管安装。
- 不要 `git commit` / `git push` / `git checkout` / `git stash`，由总管审查后提交。
- 不确定接口时以 `docs/mvp.md` 为准；文档没写清的，按最简单可行的方式实现，并在报告里列出你的假设。不要改 `docs/mvp.md`。
- 网络：本机访问外网不稳定，不要在任务里下载东西；需要时报告给总管。

## 代码规范

- TypeScript strict，ESM，两空格缩进，单引号，无分号风格不强求但同一文件保持一致（默认：无分号）。
- 注释用中文，只写"为什么"，不复述代码。
- 纯逻辑与 IO 分离；纯逻辑写 vitest 单测，文件放在同目录 `*.test.ts`。
- Node 侧只用内置模块，除非任务卡允许的依赖（已装在对应包里）。
- 不打印 token、密码、私钥内容。
- 界面颜色只用 `@theme` token，颜色组合必须满足 `docs/design/contrast.md`（可输入控件外框 ≥ 3:1、次要文字 ≥ 4.5:1）。

## 完成标准

1. 在仓库根运行 `pnpm exec tsc -p <你的包>/tsconfig.json`（桌面端：`pnpm --filter @qn/desktop typecheck`）无错误。
2. `pnpm exec vitest run <你的目录>` 全部通过。
3. 最终回复给出：改动文件列表、实现要点、测试结果（命令 + 结果）、未完成项与假设、需要总管处理的事项（依赖、跨包接口问题）。
