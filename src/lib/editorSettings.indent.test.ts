import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_PREFERENCES,
  detectIndentFromContent,
} from './editorSettings'

describe('detectIndentFromContent', () => {
  it('detects four-space Python without collapsing it to two spaces', () => {
    const source = [
      'class FileTool:',
      '    def method(self):',
      '        return True',
      '',
    ].join('\n')

    expect(detectIndentFromContent(source)).toEqual({
      tabSize: 4,
      insertSpaces: true,
    })
  })

  it('detects two-space JSON so first-level guides remain visible', () => {
    const source = [
      '{',
      '  "editor": {',
      '    "fontSize": 14',
      '  }',
      '}',
    ].join('\n')

    expect(detectIndentFromContent(source)).toEqual({
      tabSize: 2,
      insertSpaces: true,
    })
  })

  it.each([
    ['JavaScript', 'const value = {\n  nested: {\n    ok: true,\n  },\n}\n', 2],
    ['TypeScript', 'interface Item {\n  nested: {\n    ok: boolean\n  }\n}\n', 2],
    ['JSX/TSX', 'const view = (\n  <section>\n    <span />\n  </section>\n)\n', 2],
    ['JSON5', '{\n  // comment\n  nested: {\n    ok: true,\n  },\n}\n', 2],
    ['CSS', '.root {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n', 2],
    ['HTML', '<main>\n  <section>\n    <span>text</span>\n  </section>\n</main>\n', 2],
    ['Java', 'class Main {\n    void run() {\n        work();\n    }\n}\n', 4],
    ['Markdown', '- item\n  - child\n    - grandchild\n', 2],
  ])('detects indentation for supported %s content', (_name, source, tabSize) => {
    expect(detectIndentFromContent(source)).toEqual({
      tabSize,
      insertSpaces: true,
    })
  })

  it('detects tab-indented content without inventing a space width', () => {
    const source = 'if ok:\n\twork()\n\tif nested:\n\t\twork()\n'
    expect(detectIndentFromContent(source)).toEqual({
      tabSize: DEFAULT_EDITOR_PREFERENCES.tabSize,
      insertSpaces: false,
    })
  })

  it('returns no override when content has no indentation evidence', () => {
    expect(detectIndentFromContent('const value = 1\n')).toBeNull()
  })
})
