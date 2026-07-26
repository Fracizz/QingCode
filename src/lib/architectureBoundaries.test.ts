import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function storeDependencyGraph(): Map<string, string[]> {
  const storeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'store')
  const files = readdirSync(storeDir).filter(
    file => file.endsWith('Store.ts') && !file.endsWith('.test.ts')
  )
  const names = new Set(files.map(file => file.replace(/\.ts$/, '')))
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const name = file.replace(/\.ts$/, '')
    const source = readFileSync(join(storeDir, file), 'utf8')
    const dependencies = [...source.matchAll(/from\s+['"]\.\/([A-Za-z0-9]+Store)['"]/g)]
      .map(match => match[1])
      .filter(dependency => names.has(dependency))
    graph.set(name, dependencies)
  }
  return graph
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []

  const visit = (node: string): string[] | null => {
    if (active.has(node)) {
      const start = stack.indexOf(node)
      return [...stack.slice(start), node]
    }
    if (visited.has(node)) return null
    visited.add(node)
    active.add(node)
    stack.push(node)
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    active.delete(node)
    return null
  }

  for (const node of graph.keys()) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'test') files.push(...sourceFiles(path))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

describe('architecture boundaries', () => {
  it('keeps Zustand stores acyclic', () => {
    expect(findCycle(storeDependencyGraph())).toBeNull()
  })

  it('keeps Git and terminal command strings inside typed IPC clients', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const violations = sourceFiles(srcDir)
      .filter(path => !path.includes(`${join('lib', 'ipc')}`))
      .filter(path => {
        const source = readFileSync(path, 'utf8')
        return /['"](?:git_[a-z_]+|get_git_[a-z_]+|create_terminal|kill_terminal|write_terminal|resize_terminal|spawn_script)['"]/.test(
          source
        )
      })
    expect(violations).toEqual([])
  })
})
