// 国际化守卫：界面文案必须走 t()，跨进程提示必须在词典里。
// 可用环境变量 I18N_SCOPE（逗号分隔的路径片段）只检查部分文件。
// 确实不该翻译的内容（发给模型的提示词、匹配用常量等）在本行或上一行注释 i18n-ignore 并说明原因。
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const uiRoots = ['apps/desktop/src/renderer/src', 'apps/mobile/web/src', 'packages/codex-client/src']
const nodeRoots = [
  'apps/desktop/src/backend',
  'apps/desktop/src/main',
  'apps/desktop/src/preload',
  'apps/desktop/src/shared',
  'packages/server/src',
  'packages/protocol/src',
]
const skipped = /\.test\.tsx?$|\.d\.ts$|\.en\.ts$|\/backend\/dev\/|\/mobile\/web\/src\/mock\.ts$/
const cjk = /[一-鿿]/
const scope = (process.env['I18N_SCOPE'] ?? '').split(',').filter(Boolean)

function walk(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

interface Found {
  where: string
  text: string
  /** 作为 t() 首参出现 */
  translated: boolean
}

function scan(file: string): Found[] {
  const content = readFileSync(join(root, file), 'utf8')
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const lines = content.split('\n')
  const found: Found[] = []
  const visit = (node: ts.Node): void => {
    let text: string | undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
    else if (ts.isJsxText(node)) text = node.text.trim()
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join('')
    }
    const parent = node.parent
    const translated = !!parent && ts.isCallExpression(parent) && parent.arguments[0] === node &&
      ts.isIdentifier(parent.expression) && parent.expression.text === 't'
    // 类型位置的字面量是取值约束，不是展示文案。
    if (text !== undefined && cjk.test(text) && !ts.isLiteralTypeNode(parent)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      if (![lines[line], lines[line - 1]].some((value) => value?.includes('i18n-ignore'))) {
        found.push({ where: `${file}:${line + 1}`, text, translated })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const placeholders = (text: string) => text.match(/\{\w+\}/g) ?? []
const shape = (text: string) => text.replace(/\{\w+\}/g, '{}')

const allFiles = [...uiRoots, ...nodeRoots].flatMap(walk)
const dictionaries = await Promise.all(
  allFiles.filter((file) => file.endsWith('.en.ts')).map(async (file) => ({
    file,
    messages: ((await import(/* @vite-ignore */ pathToFileURL(join(root, file)).href)) as { default: Record<string, string> }).default,
  })),
)
const entries = dictionaries.flatMap(({ file, messages }) =>
  Object.entries(messages).map(([source, english]) => ({ file, source, english })),
)
const keys = new Set(entries.map((entry) => entry.source))
const shapes = new Set([...keys].map(shape))
const targets = allFiles.filter((file) => !skipped.test(file) && (!scope.length || scope.some((part) => file.includes(part))))
const found = targets.flatMap((file) =>
  scan(file).map((item) => ({ ...item, ui: uiRoots.some((prefix) => file.startsWith(`${prefix}/`)) })),
)
const describeItem = (item: Found) => `${item.where} ${item.text}`

describe('中英文覆盖', () => {
  it('界面中文都经过 t()', () => {
    expect(found.filter((item) => item.ui && !item.translated).map(describeItem)).toEqual([])
  })

  it('t() 词条都有英文', () => {
    expect(found.filter((item) => item.translated && !keys.has(item.text)).map(describeItem)).toEqual([])
  })

  it('Node 侧中文提示都有可匹配的英文', () => {
    expect(found.filter((item) => !item.ui && !shapes.has(shape(item.text))).map(describeItem)).toEqual([])
  })

  it('译文占位符都能从原文取到，且不残留中文', () => {
    const bad = entries.filter(({ source, english }) =>
      !english.trim() || cjk.test(english) || placeholders(english).some((name) => !source.includes(name)),
    )
    expect(bad).toEqual([])
  })

  it('同一原文在各词典里译法一致', () => {
    const seen = new Map<string, string>()
    const conflicts = entries.filter(({ source, english }) => {
      const previous = seen.get(source)
      seen.set(source, english)
      return previous !== undefined && previous !== english
    })
    expect(conflicts).toEqual([])
  })
})
