import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildQingcodeCliSkillMarkdown,
  QINGCODE_CLI_REPO_BINARY,
} from '../src/lib/qingcodeCliSkill.ts'

const skillPath = fileURLToPath(new URL('../.agents/skills/qingcode-cli/SKILL.md', import.meta.url))

await writeFile(skillPath, buildQingcodeCliSkillMarkdown(QINGCODE_CLI_REPO_BINARY), 'utf8')

process.stdout.write(`Updated ${skillPath}\n`)
