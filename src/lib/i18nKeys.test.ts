import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EN_JSON_PATH = path.join(SRC_ROOT, 'locales', 'en.json')

const CALL_NAME_RE = /\b(t|translate|translateFor)\s*\(/g

type KeyHit = { key: string; file: string; line: number }

/** Walk source files under src/, skipping locales and test files. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'locales' || ent.name === 'node_modules') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSourceFiles(full, acc)
      continue
    }
    if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) {
      acc.push(full)
    }
  }
  return acc
}

/** Strip // and block comments without destroying string contents. */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '')
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

function unescapeString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0' }
    return map[esc] ?? esc
  })
}

/**
 * Split a call's argument list (text inside the outer parentheses) into top-level args.
 * Respects nested (), [], {}, and string / template literals.
 */
function splitTopLevelArgs(argsSource: string): string[] {
  const args: string[] = []
  let start = 0
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let i = 0
  while (i < argsSource.length) {
    const ch = argsSource[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < argsSource.length) {
        if (argsSource[i] === '\\') {
          i += 2
          continue
        }
        if (argsSource[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')') depthParen--
    else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket--
    else if (ch === '{') depthBrace++
    else if (ch === '}') depthBrace--
    else if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      args.push(argsSource.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  const last = argsSource.slice(start).trim()
  if (last) args.push(last)
  return args
}

/**
 * Extract static i18n key literals from a call's key argument.
 * - Plain `'key'` / `"key"` first args are collected.
 * - Ternaries like `cond === 'dark' ? '深色' : '浅色'` only collect branch literals
 *   (after `?`), so comparison operands are ignored.
 * - Template literals and fully dynamic args yield nothing (documented skip).
 */
function extractStringLiterals(expr: string): string[] {
  // For ternary key args, only the consequent/alternate are translation keys.
  const scanFrom = expr.includes('?') ? expr.indexOf('?') + 1 : 0
  const region = expr.slice(scanFrom)
  const keys: string[] = []
  let i = 0
  while (i < region.length) {
    const ch = region[i]
    if (ch === '`') {
      // Dynamic template keys are skipped.
      i++
      while (i < region.length) {
        if (region[i] === '\\') {
          i += 2
          continue
        }
        if (region[i] === '`') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let raw = ''
      i++
      while (i < region.length) {
        if (region[i] === '\\') {
          raw += region[i] + (region[i + 1] ?? '')
          i += 2
          continue
        }
        if (region[i] === quote) {
          i++
          break
        }
        raw += region[i]
        i++
      }
      keys.push(unescapeString(raw))
      continue
    }
    i++
  }
  return keys
}

/**
 * Find the matching closing ')' for a call that starts at openParenIndex ('(').
 * Returns the index of ')' or -1.
 */
function findCallEnd(source: string, openParenIndex: number): number {
  let depth = 0
  let i = openParenIndex
  while (i < source.length) {
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

/**
 * Skip `function translate(` / `function translateFor(` declarations.
 * Note: `t: (` in useI18n is already excluded because CALL_NAME_RE requires `t(` with
 * no `:` between the name and `(`. Do NOT treat `label: t('…')` as a definition.
 */
function isDefinitionSite(source: string, nameStart: number): boolean {
  const before = source.slice(Math.max(0, nameStart - 40), nameStart)
  return /\b(?:export\s+)?function\s+$/.test(before)
}

function scanFile(filePath: string): KeyHit[] {
  const rel = path.relative(SRC_ROOT, filePath).replace(/\\/g, '/')
  const text = stripComments(fs.readFileSync(filePath, 'utf8'))
  const hits: KeyHit[] = []
  CALL_NAME_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CALL_NAME_RE.exec(text))) {
    const name = match[1]
    const nameStart = match.index
    if (isDefinitionSite(text, nameStart)) continue

    const openParen = nameStart + match[0].length - 1
    const closeParen = findCallEnd(text, openParen)
    if (closeParen < 0) continue

    const argsSource = text.slice(openParen + 1, closeParen)
    const args = splitTopLevelArgs(argsSource)
    const keyArgIndex = name === 'translateFor' ? 1 : 0
    const keyArg = args[keyArgIndex]
    if (!keyArg) continue

    // Fully dynamic first arg (variable / property / call) — no static string literals.
    // Documented skip: e.g. t(option.label), t(SORT_LABELS[k]), translate(action).
    const literals = extractStringLiterals(keyArg)
    if (literals.length === 0) continue

    const line = text.slice(0, nameStart).split('\n').length
    for (const key of literals) {
      hits.push({ key, file: rel, line })
    }
  }
  return hits
}

function scanAllKeys(): KeyHit[] {
  const files = collectSourceFiles(SRC_ROOT)
  return files.flatMap(scanFile)
}

describe('i18n English message coverage', () => {
  it('every static t()/translate()/translateFor() key exists in en.json messages', () => {
    const hits = scanAllKeys()
    const uniqueKeys = [...new Set(hits.map(h => h.key))]
    const enLocale = JSON.parse(fs.readFileSync(EN_JSON_PATH, 'utf8')) as {
      messages: Record<string, string>
    }
    const messages = enLocale.messages

    expect(uniqueKeys.length, 'expected to discover static i18n keys in source').toBeGreaterThan(0)

    const missing = uniqueKeys
      .filter(key => !(key in messages))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))

    if (missing.length > 0) {
      const details = missing.map(key => {
        const locs = hits
          .filter(h => h.key === key)
          .slice(0, 5)
          .map(h => `${h.file}:${h.line}`)
          .join(', ')
        return `  ${JSON.stringify(key)} @ ${locs}`
      })
      expect.fail(
        `${missing.length} i18n key(s) used in source but missing from src/locales/en.json messages:\n${details.join('\n')}\n\n` +
          `Add English translations for each Chinese source key (keys are the zh-CN strings; zh-CN.json messages may be empty).`,
      )
    }

    // Sanity: the UI surface uses hundreds of static Chinese source keys.
    expect(uniqueKeys.length).toBeGreaterThan(300)
  })
})
