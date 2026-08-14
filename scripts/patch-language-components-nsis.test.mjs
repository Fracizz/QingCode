import assert from 'node:assert/strict'
import test from 'node:test'

import { patchInstallerSource } from './patch-language-components-nsis.mjs'

const fixture = `Function .onInit
FunctionEnd

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

Section Install
  SetOutPath $INSTDIR
  ; Copy resources
SectionEnd

Function CreateOrUpdateDesktopShortcut
  CreateShortcut "$DESKTOP\\QingCode.lnk" "$INSTDIR\\qingcode.exe"
FunctionEnd
`

test('restores the installer output directory before resources and shortcuts', () => {
  const patched = patchInstallerSource(fixture, String.raw`D:\stage\language-components`)

  const reset = '  SetOutPath "$INSTDIR"\n\n  ; Copy resources'
  assert.ok(patched.includes(reset))
  assert.ok(patched.indexOf(reset) < patched.indexOf('CreateShortcut'))
  assert.match(patched, /SetOutPath "\$INSTDIR\\language-components\\go"/)
})

test('refuses to patch an installer twice', () => {
  const patched = patchInstallerSource(fixture, String.raw`D:\stage\language-components`)
  assert.throws(
    () => patchInstallerSource(patched, String.raw`D:\stage\language-components`),
    /already contains/
  )
})
