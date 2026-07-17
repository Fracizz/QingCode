/** Display name for an editor tab from its path. */
export function tabNameFromPath(path: string): string {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return sep >= 0 ? path.slice(sep + 1) || path : path
}

/** Keep global default-settings.json open across project switches. */
export function isPinnedSettingsTab(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.endsWith('/default-settings.json')
}

/** Guess CodeMirror language id from file path / extension. */
export function guessLanguage(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (
    normalized.endsWith('/default-settings.json') ||
    normalized.endsWith('/project-settings.json')
  ) {
    return 'json5'
  }
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    json: 'json',
    json5: 'json5',
    jsonc: 'json5',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    rs: 'rust',
    toml: 'toml',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sh: 'shell',
    bat: 'bat',
    ps1: 'powershell',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
  }
  return map[ext] || 'plain'
}
