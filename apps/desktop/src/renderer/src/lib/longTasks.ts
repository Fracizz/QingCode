/** 主线程单个任务超过该时长记一条警告，用于定位界面卡顿（转圈停住等）。 */
const LONG_TASK_WARN_MS = 200

/** 监听长任务并输出到控制台；只记时长和开始时间，不含任何对话内容。 */
export function watchLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < LONG_TASK_WARN_MS) continue
      // i18n-ignore: 控制台日志
      console.warn(`[renderer] 主线程长任务 ${Math.round(entry.duration)}ms`, { startTime: Math.round(entry.startTime) })
    }
  }).observe({ type: 'longtask', buffered: true })
}
