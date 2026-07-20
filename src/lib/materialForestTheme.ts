/**
 * JetBrains Material Theme UI — Material Forest palette.
 * Official UI/syntax colors are retained; text and comments are lifted for readability.
 * @see https://material-theme.com/docs/reference/color-palette/
 */
export const MATERIAL_FOREST = {
  background: '#002626',
  foreground: '#B2C2B0',
  text: '#94A596',
  selectionBg: '#1E611E',
  selectionFg: '#FFFFFF',
  secondBackground: '#002E2E',
  contrast: '#002020',
  buttons: '#003535',
  active: '#104110',
  border: '#003838',
  highlight: '#003F3F',
  disabled: '#005454',
  accent: '#FFCC80',
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
    /** Softened from official #eeffff to reduce glare in long editing sessions. */
    white: '#d1e0e0',
    error: '#ff5370',
    comments: '#789b94',
    variables: '#d1e0e0',
    links: '#80cbc4',
    functions: '#82aaff',
    keywords: '#c792ea',
    tags: '#f07178',
    strings: '#c3e88d',
    operators: '#89ddff',
  },
} as const
