import pkg from '../package.json'

// 打包时由 build.mjs 替换为产物内容哈希；源码直接运行（vitest/dev）时不存在。
declare const __QN_BUILD_ID__: string | undefined

/**
 * 打包时由 esbuild 内联，远端/本机运行的是同一份版本常量。
 * 附带构建哈希：package.json 版本号不变时，ensure --replace 也能认出旧 daemon 并替换。
 */
export const VERSION: string =
  typeof __QN_BUILD_ID__ === 'string' && __QN_BUILD_ID__ ? `${pkg.version}+${__QN_BUILD_ID__}` : pkg.version
