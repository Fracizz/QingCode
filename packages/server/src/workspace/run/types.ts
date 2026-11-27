import type { WorkspaceMethods } from '@qn/protocol'

// protocol 的 index.ts 不在本卡范围内，run.* 类型先从 WorkspaceMethods 推导；
// 总管在 index.ts 补导出后可直接改为从 '@qn/protocol' 导入。

export type RunStartParams = WorkspaceMethods['run.start']['params']
export type RunStartTask = RunStartParams['task']
export type RunTaskType = RunStartTask['type']
export type RunOs = WorkspaceMethods['run.list']['result']['platform']
export type RunTaskOverride = NonNullable<NonNullable<RunStartTask['os']>[RunOs]>
export type RunInfo = WorkspaceMethods['run.list']['result']['runs'][number]
export type RunOutputResult = WorkspaceMethods['run.output']['result']
export type RunOutputChunk = RunOutputResult['chunks'][number]
export type RunDataEvt = { runId: string } & RunOutputChunk
export type RunExitEvt = { runId: string; exitCode: number | null; signal: string | null }
