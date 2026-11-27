/** get_commands（官方 docs/rpc-commands.md）里的技能 → v2 skills/list 条目（纯逻辑）。 */
import { asRecord, scalarText, type Json } from '../claude/v2'

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
