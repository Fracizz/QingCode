/**
 * QingCode-tuned JetBrains Material Theme UI — Material Forest palette.
 * UI surfaces are separated more clearly and secondary code stays AA-readable.
 * @see https://material-theme.com/docs/reference/color-palette/
 */
export const MATERIAL_FOREST = {
  background: '#072A27',
  foreground: '#D5E2DD',
  text: '#AABBB5',
  selectionBg: '#255A4D',
  selectionFg: '#FFFFFF',
  secondBackground: '#0B322E',
  contrast: '#041F1D',
  buttons: '#103A35',
  active: '#1B5046',
  border: '#17413B',
  highlight: '#16453E',
  disabled: '#789B94',
  /** UI accent (cursor, CTAs); muted from Material Forest #FFCC80 for filled buttons. */
  accent: '#D3A15B',
  excluded: '#214437',
  syntax: {
    green: '#c3e88d',
    yellow: '#ffcb6b',
    blue: '#82aaff',
    red: '#f07178',
    purple: '#c792ea',
    orange: '#f78c6c',
    cyan: '#89ddff',
    gray: '#789b94',
    /** Soft default / variable fg, aligned with the application shell. */
    white: '#d5e2dd',
    error: '#ff5370',
    comments: '#789b94',
    variables: '#d5e2dd',
    links: '#80cbc4',
    functions: '#82aaff',
    keywords: '#c792ea',
    tags: '#f07178',
    strings: '#c3e88d',
    operators: '#89ddff',
  },
} as const
