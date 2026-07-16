export function formatTerminalName(name: string) {
  if (/^终端 \d+$/.test(name)) return name
  const match = /^Terminal (\d+)$/.exec(name)
  return match ? `终端 ${match[1]}` : name
}
