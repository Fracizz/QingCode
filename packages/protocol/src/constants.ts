/** hello/welcome 的版本号由 mvp.md §4 固定，两端必须一致。 */
export const PROTOCOL_VERSION = 1

/** 帧长度上限；超限属于协议错误，不能再继续等后续字节。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
