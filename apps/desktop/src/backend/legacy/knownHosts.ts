// 主机指纹统一走 T5 的 hostKeys.ts，避免两处各写一份 known_hosts.json。
// 这里只保留导入侧使用的别名，格式与 mvp.md §5 一致：键 host:port，值 SHA256:...
export type { KnownHosts } from '../hostKeys'
export {
  hostKeyId,
  readKnownHosts as readKnownHostsFile,
  writeKnownHosts as writeKnownHostsFile,
} from '../hostKeys'
