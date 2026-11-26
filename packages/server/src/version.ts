import pkg from '../package.json'

/** 打包时由 esbuild 内联，远端/本机运行的是同一份版本常量。 */
export const VERSION: string = pkg.version
