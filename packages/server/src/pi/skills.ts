/** get_commands（官方 docs/rpc-commands.md）→ 技能列表与斜杠命令列表（纯逻辑）。 */
import { asRecord, scalarText, type Json } from '../claude/v2'

/** 扩展命令、提示模板和技能都可以用 `/name` 经 prompt 执行；pi 不提供参数提示。 */
export function piCommands(commands: unknown): Json[] {
  if (!Array.isArray(commands)) return []
  return commands.flatMap((entry) => {
    const command = asRecord(entry)
    const name = scalarText(command?.name)
    return name ? [{ name, description: scalarText(command?.description) }] : []
  })
}

export function piSkills(commands: unknown): Json[] {
  if (!Array.isArray(commands)) return []
  return commands.flatMap((entry) => {
    const command = asRecord(entry)
    // 名称已带 skill: 前缀，发送时拼成 /skill:name 由 pi 展开。扩展命令与提示模板不算技能。
    const name = scalarText(command?.name)
    if (!command || command.source !== 'skill' || !name) return []
    const source = asRecord(command.sourceInfo)
    return [{
      name,
      description: scalarText(command.description),
      path: scalarText(source?.path),
      scope: source?.scope === 'project' ? 'repo' : 'user',
      enabled: true,
    }]
  })
}
