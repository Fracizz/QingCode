/**
 * JetBrains Material Theme UI — Material Forest palette.
 * @see https://material-theme.com/docs/reference/color-palette/
 */
export const MATERIAL_FOREST = {
  background: '#002626',
  foreground: '#B2C2B0',
  text: '#49694D',
  selectionBg: '#1E611E',
  selectionFg: '#FFFFFF',
  secondBackground: '#002E2E',
  contrast: '#002020',
  buttons: '#003535',
  active: '#104110',
  border: '#003838',
  highlight: '#003F3F',
  disabled: '#005454',
  /** UI accent (cursor, CTAs); muted from Material Forest #FFCC80 for filled buttons. */
  accent: '#B8894A',
  excluded: '#113711',
  syntax: {
    green: '#c3e88d',
    yellow: '#ffcb6b',
    blue: '#82aaff',
    red: '#f07178',
    purple: '#c792ea',
    orange: '#f78c6c',
    cyan: '#89ddff',
    gray: '#005454',
    /** Soft default / variable fg — avoid Material's near-white #eeffff glare. */
    white: '#c8d6c8',
    error: '#ff5370',
    comments: '#005454',
    variables: '#c8d6c8',
    links: '#80cbc4',
    functions: '#82aaff',
    keywords: '#c792ea',
    tags: '#f07178',
    strings: '#c3e88d',
    operators: '#89ddff',
  },
} as const
