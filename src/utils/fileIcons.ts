import {
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Braces,
  Hash,
  FileType2,
  Image as ImageIcon,
  Settings2,
  FileTerminal,
  Package,
  FileText as MdIcon,
  type LucideIcon,
} from 'lucide-react'

const EXT_MAP: Record<string, LucideIcon> = {
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  ts: FileCode,
  tsx: FileCode,
  json: FileJson,
  jsonc: FileJson,
  html: FileType2,
  htm: FileType2,
  css: Braces,
  scss: Braces,
  less: Braces,
  md: MdIcon,
  markdown: MdIcon,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  cc: FileCode,
  toml: Settings2,
  yaml: Hash,
  yml: Hash,
  xml: FileText,
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  bat: FileTerminal,
  ps1: FileTerminal,
  txt: FileText,
  log: FileText,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  webp: ImageIcon,
  svg: ImageIcon,
  lock: Hash,
  env: Settings2,
  gitignore: Hash,
  dockerfile: Package,
}

const NAME_MAP: Record<string, LucideIcon> = {
  packagejson: Package,
  packagelock: Package,
  cargotoml: Package,
  cargolock: Package,
  dockerfile: Package,
  makefile: FileTerminal,
  readme: FileText,
  license: FileText,
}

export function getFileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase()
  const stripped = lower.replace(/[^a-z0-9]/g, '')
  if (NAME_MAP[stripped]) return NAME_MAP[stripped]
  const ext = lower.split('.').pop() || ''
  return EXT_MAP[ext] || FileIcon
}
