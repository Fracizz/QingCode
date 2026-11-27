// 代码高亮 Worker：shiki 着色是同步的正则匹配，大代码块或回溯严重的语法会占用数秒，放在这里不阻塞界面。
import { createTokenizer } from './shikiCore'
import type { HighlightRequest, HighlightResponse } from './shiki'

// renderer 的 tsconfig 只带 DOM 类型，这里按 Worker 作用域的最小接口使用 self。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null
  postMessage: (message: HighlightResponse) => void
}

let tokenizer: ReturnType<typeof createTokenizer> | null = null
// 按到达顺序逐个处理，语法加载完成前不处理后续请求。
let queue: Promise<void> = Promise.resolve()

scope.onmessage = (event) => {
  const request = event.data
  queue = queue.then(async () => {
    if (request.themes) tokenizer ??= createTokenizer(request.themes)
    const tokens = tokenizer ? await tokenizer.tokenize(request.code, request.lang, request.grammars) : null
    scope.postMessage({ id: request.id, tokens })
  })
}
