// Generated from qingcode-contracts by ts-rs. Do not edit.
// Regenerate: pnpm ipc:generate
// u64 maps to JSON number; file commands operate within safe integer limits.

export type FileNode = { name: string, path: string, is_dir: boolean, children?: Array<FileNode>, };
export type FileStat = { size: number, is_dir: boolean, };
export type FileSlice = { offset: number, len: number, text: string, eof: boolean, file_size: number, };
export type LineOffsetResult = { line: number, offset: number, found: boolean, total_lines: number, file_size: number, };
export type RemoteFileNode = { name: string, path: string, is_dir: boolean, };
export type RemoteFileSlice = { content: string, offset: number, nextOffset: number, fileSize: number, eof: boolean, };
