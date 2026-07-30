/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly QINGCODE_VERSION?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.svg?raw' {
  const content: string
  export default content
}

declare module '*.md?raw' {
  const content: string
  export default content
}
