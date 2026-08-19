import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const componentIds = ['typescript', 'python', 'java', 'rust', 'go']

const libraryName = id => {
  if (process.platform === 'win32') return `qingcode_language_${id}.dll`
  if (process.platform === 'darwin') return `libqingcode_language_${id}.dylib`
  return `libqingcode_language_${id}.so`
}

const nsisPath = value => path.resolve(value).replaceAll('/', '\\').replaceAll('"', '$\\"')

export function patchInstallerSource(input, componentRoot) {
  let source = input.replaceAll('\r\n', '\n')
  if (source.includes('; QINGCODE_LANGUAGE_COMPONENTS')) {
    throw new Error('Installer already contains the QingCode language component patch')
  }

  const installMarker = '  ; Copy resources\n'
  if (!source.includes(installMarker)) {
    throw new Error('Unsupported Tauri NSIS template: resource-copy marker not found')
  }

  const installs = componentIds
    .map(id => {
      const componentDir = nsisPath(path.join(componentRoot, id))
      const library = libraryName(id)
      return `  SetOutPath "$INSTDIR\\language-components\\${id}"
  File /oname=${library} "${componentDir}\\${library}"
  File /oname=component.json "${componentDir}\\component.json"`
    })
    .join('\n\n')

  source = source.replace(
    installMarker,
    `  ; QINGCODE_LANGUAGE_COMPONENTS — install all navigation components by default.\n${installs}\n\n  ; Restore the installer output directory before Tauri creates shortcuts.\n  ; NSIS uses $OUTDIR as a shortcut's working directory.\n  SetOutPath "$INSTDIR"\n\n${installMarker}`
  )

  return source
}

function main() {
  const [installerPath, componentRoot] = process.argv.slice(2)
  if (!installerPath || !componentRoot) {
    throw new Error(
      'Usage: node patch-language-components-nsis.mjs <installer.nsi> <component-root>'
    )
  }

  const source = fs.readFileSync(installerPath, 'utf8')
  fs.writeFileSync(installerPath, patchInstallerSource(source, componentRoot), 'utf8')
  console.log(`Patched language component install into ${installerPath}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
