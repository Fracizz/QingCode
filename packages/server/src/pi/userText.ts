/**
 * pi 发给模型前会把技能和 `@文件` 展开进用户消息正文，历史里只有展开后的内容；
 * 这里收回成用户看到的样子（纯函数）。
 */
const FILE_HEAD = /^<file name="([^"\n]*)">/
const FILE_CLOSE = '</file>'
// 与 pi 自身解析技能块的格式一致（core/agent-session）。
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/

/** 开头连续的文件块拆成路径，正文只留用户输入。 */
function takeFiles(source: string): { text: string; files: string[] } {
  const files: string[] = []
  let text = source
  for (;;) {
    const head = FILE_HEAD.exec(text)
    if (!head) return { text, files }
    // 文件内容可能自带结束标签：取下一个文件块之前的那个，最后一块取全文最后一个。
    let end = -1
    for (let at = text.indexOf(FILE_CLOSE, head[0].length); at >= 0; at = text.indexOf(FILE_CLOSE, at + 1)) {
      const after = text.slice(at + FILE_CLOSE.length)
      if (after && !after.startsWith('\n')) continue
      end = at
      if (FILE_HEAD.test(after.slice(1))) break
    }
    if (end < 0) return { text, files }
    files.push(head[1]!)
    text = text.slice(end + FILE_CLOSE.length).replace(/^\n/, '')
  }
}

export function piUserText(source: string): { text: string; files: string[] } {
  const { text, files } = takeFiles(source)
  const skill = SKILL_BLOCK.exec(text)
  if (!skill) return { text, files }
  // 写成发送时的 /skill:名称，客户端按技能标签展示。
  return { text: [`/skill:${skill[1]}`, skill[2]].filter(Boolean).join(' '), files }
}
