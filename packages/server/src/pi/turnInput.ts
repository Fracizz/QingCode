/** turn/start 的 v2 UserInput[] → pi RPC prompt 命令参数（纯逻辑）。 */
import { resolveTurnInput, type LocalImageIo, type TurnContent } from '../claude/userInput'
import { asRecord, scalarText, type Json } from '../claude/v2'

export interface PiImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface PiPrompt {
  message: string
  images?: PiImage[]
}

export interface ResolvedPiPrompt {
  prompt: PiPrompt
  /** 回显给客户端的 v2 userMessage.content。 */
  echo: Json[]
}

/** pi 的 prompt 只接受 base64 图片；http(s) URL 图片忽略并在 README 说明。 */
export function promptFromContent(content: TurnContent): PiPrompt {
  const images: PiImage[] = []
  for (const block of content.blocks) {
    if (block.type !== 'image') continue
    const source = asRecord(block.source)
    if (source?.type !== 'base64') continue
    const data = scalarText(source.data)
    const mimeType = scalarText(source.media_type)
    if (data && mimeType) images.push({ type: 'image', data, mimeType })
  }
  return { message: content.text, ...(images.length > 0 ? { images } : {}) }
}

/** 复用 Claude 桥已单测的输入解析（含本地图片读取），再转成 pi 的形状。 */
export async function resolvePiPrompt(
  input: unknown,
  io?: LocalImageIo,
): Promise<ResolvedPiPrompt> {
  const content = io ? await resolveTurnInput(input, io) : await resolveTurnInput(input)
  return { prompt: promptFromContent(content), echo: content.echo }
}
