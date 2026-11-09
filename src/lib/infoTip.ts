/** 悬停卡片的内容：标题、可选状态和若干键值行，由 InfoTipCard 渲染。 */
export interface InfoTipDetails {
  title: string
  status?: { text: string; tone: 'muted' | 'ok' | 'warn' | 'danger' }
  rows: ReadonlyArray<{ label: string; value: string; mono?: boolean }>
}
