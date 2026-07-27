import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [installerPath, componentRoot] = process.argv.slice(2)
if (!installerPath || !componentRoot) {
  throw new Error('Usage: node patch-language-components-nsis.mjs <installer.nsi> <component-root>')
}

const componentDefinitions = [
  ['TypeScript / JavaScript', 'typescript', true],
  ['Python', 'python', true],
  ['Java', 'java', true],
  ['Rust', 'rust', true],
  ['Go', 'go', true],
]

const libraryName = (id) => {
  if (process.platform === 'win32') return `qingcode_language_${id}.dll`
  if (process.platform === 'darwin') return `libqingcode_language_${id}.dylib`
  return `libqingcode_language_${id}.so`
}

const nsisPath = (value) => path.resolve(value).replaceAll('/', '\\').replaceAll('"', '$\\"')
const variableName = (id) => `QingLang${id[0].toUpperCase()}${id.slice(1)}`

let source = fs.readFileSync(installerPath, 'utf8').replaceAll('\r\n', '\n')
if (source.includes('; QINGCODE_LANGUAGE_COMPONENTS_PAGE')) {
  throw new Error(`Installer already contains the QingCode language component patch: ${installerPath}`)
}

const pageMarker = '; 7. Installation page\n!insertmacro MUI_PAGE_INSTFILES'
if (!source.includes(pageMarker)) {
  throw new Error('Unsupported Tauri NSIS template: installation-page marker not found')
}

const variables = componentDefinitions
  .flatMap(([, id]) => [`Var ${variableName(id)}Checkbox`, `Var ${variableName(id)}Selected`])
  .join('\n')
const controls = componentDefinitions
  .map(([label, id], index) => {
    const variable = variableName(id)
    return `  \${NSD_CreateCheckbox} 8u ${32 + index * 22}u 94% 14u "${label}"\n  Pop $${variable}Checkbox\n  \${NSD_SetState} $${variable}Checkbox $${variable}Selected`
  })
  .join('\n')
const reads = componentDefinitions
  .map(([, id]) => {
    const variable = variableName(id)
    return `  \${NSD_GetState} $${variable}Checkbox $${variable}Selected`
  })
  .join('\n')
const defaults = componentDefinitions
  .map(([, id, enabled]) => `  StrCpy $${variableName(id)}Selected \${BST_${enabled ? 'CHECKED' : 'UNCHECKED'}}`)
  .join('\n')

const page = `; QINGCODE_LANGUAGE_COMPONENTS_PAGE
${variables}
Page custom QingLanguageComponentsPage QingLanguageComponentsLeave

Function QingLanguageComponentsPage
  \${If} $PassiveMode = 1
  \${OrIf} \${Silent}
    Abort
  \${EndIf}
  !insertmacro MUI_HEADER_TEXT "语言组件 / Language components" "仅安装需要的代码导航组件，可全部取消。"
  nsDialogs::Create 1018
  Pop $0
  \${If} $0 == error
    Abort
  \${EndIf}
  \${NSD_CreateLabel} 8u 4u 94% 22u "选择用于变量引用、函数引用和定义跳转的语言组件："
  Pop $0
${controls}
  nsDialogs::Show
FunctionEnd

Function QingLanguageComponentsLeave
${reads}
FunctionEnd

; 7. Language-component selection page (before file installation)
${pageMarker}`
source = source.replace(pageMarker, page)

const initMarker = 'Function .onInit\n'
if (!source.includes(initMarker)) {
  throw new Error('Unsupported Tauri NSIS template: .onInit marker not found')
}
source = source.replace(
  initMarker,
  `${initMarker}  ; Default component selection: all languages on; user can deselect any.\n${defaults}\n\n`,
)

const installMarker = '  ; Copy resources\n'
if (!source.includes(installMarker)) {
  throw new Error('Unsupported Tauri NSIS template: resource-copy marker not found')
}
const installs = componentDefinitions
  .map(([, id]) => {
    const variable = variableName(id)
    const componentDir = nsisPath(path.join(componentRoot, id))
    const library = libraryName(id)
    return `  \${If} $${variable}Selected == \${BST_CHECKED}
    SetOutPath "$INSTDIR\\language-components\\${id}"
    File /oname=${library} "${componentDir}\\${library}"
    File /oname=component.json "${componentDir}\\component.json"
  \${Else}
    RMDir /r "$INSTDIR\\language-components\\${id}"
  \${EndIf}`
  })
  .join('\n\n')
source = source.replace(
  installMarker,
  `  ; Copy independently selectable language components\n${installs}\n\n${installMarker}`,
)

fs.writeFileSync(installerPath, source, 'utf8')
console.log(`Patched optional language component page into ${installerPath}`)
