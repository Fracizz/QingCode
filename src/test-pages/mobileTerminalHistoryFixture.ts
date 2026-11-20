const lines = Array.from({ length: 600 }, (_, index) => `历史输出 ${String(index + 1).padStart(3, '0')}`)

export function mobileTerminalHistoryFixture() {
  const requests: number[] = []
  return {
    requests,
    preview: () => ({
      screen: '手机端实时画面', alternate: false, cols: 42, rows: 30,
      history: lines.slice(-200), historyBefore: lines.length - 200, historyMore: true,
    }),
    read(before: number) {
      requests.push(before)
      const start = Math.max(0, before - 120)
      return { lines: lines.slice(start, before), before: start, more: start > 0, truncated: false }
    },
  }
}
