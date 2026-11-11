/**
 * 护眼绿主题（id 'olive'）的编辑器 / 终端色板。
 * 结构沿用 JetBrains Material Forest 的字段，但颜色全部改为低饱和（约 30–50%）的柔和色，
 * 与 theme.css 中护眼绿的底色（#1c241f）配套：语法色对比度约 6–9:1，正文约 10:1，避免高饱和色在深底上刺眼。
 */
export const MATERIAL_FOREST = {
  background: '#1c241f',
  foreground: '#b5c2b8',
  text: '#9aab9e',
  selectionBg: '#34503f',
  selectionFg: '#FFFFFF',
  secondBackground: '#1f2822',
  contrast: '#171e1a',
  buttons: '#2f4538',
  active: '#303d35',
  border: '#29342d',
  highlight: '#2a362f',
  disabled: '#4a5a4f',
  accent: '#d9b878',
  excluded: '#26352b',
  syntax: {
    green: '#a9c79a',
    yellow: '#d6bf8a',
    blue: '#8fb3d6',
    red: '#d68f8f',
    purple: '#bfa0d0',
    orange: '#d6a57f',
    cyan: '#8cc2bd',
    gray: '#4a5a4f',
    /** 正文不用近白，降低长时间编辑的眩光。 */
    white: '#cbd5cd',
    error: '#e07a7a',
    comments: '#7f9a88',
    variables: '#cbd5cd',
    links: '#8cc2bd',
    functions: '#8fb3d6',
    keywords: '#bfa0d0',
    tags: '#d68f8f',
    strings: '#a9c79a',
    operators: '#8cc2bd',
  },
  /** 终端 bright 系列：比普通色提亮一档以便区分，饱和度仍不超过约 50%。 */
  bright: {
    black: '#91a99a',
    red: '#dea6a6',
    green: '#bbd6ad',
    yellow: '#ddcda2',
    blue: '#a6c4e2',
    magenta: '#cfb5dc',
    cyan: '#a2d2cd',
    white: '#d9e1da',
  },
} as const
