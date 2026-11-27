# T13 Codex 额度显示（共用逻辑 + 电脑端界面）

范围：`packages/codex-client/src/rateLimits.ts`（+ 测试、`index.ts` 导出、`rpc.ts` 的 `ClientRequestMap` 补 `account/rateLimits/read`、`account/read` 类型）与 `apps/desktop/src/renderer/**`（新增组件 + 在对话区/目标列表接入）。

依据：`docs/mvp.md` §10；类型见 `vendor/codex-protocol/ts/v2/GetAccountRateLimitsResponse.ts`、`RateLimitSnapshot.ts`、`RateLimitWindow.ts`、`AccountRateLimitsUpdatedNotification.ts`、`GetAccountResponse.ts`。

- `rateLimits.ts`：`pickSnapshot(resp)`（优先 `rateLimitsByLimitId.codex`，否则 `rateLimits`）、`mergeSnapshot(prev, sparse)`、`windowLabel(mins)`、`severity(snapshot)`（ok/warn/danger）、`formatReset(resetsAt, now)`（"2 小时 13 分后重置（今天 18:40）"）、`compactText(snapshot)`（"5h 32% · 周 12%"）。全部纯函数并单测。
- 电脑端：每个目标一个额度 store（codex.open 后读取；订阅 `account/rateLimits/updated`；可见时 60s 刷新；`turn/completed` 后刷新）；徽标 + 详情弹层 + 目标列表行内最紧张百分比。

验收：`pnpm exec tsc -p packages/codex-client/tsconfig.json`、`pnpm --filter @qn/desktop typecheck`、相关 vitest、`build`、`--smoke` 均通过。
