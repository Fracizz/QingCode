//! Wire data shared by local/SSH file commands. No desktop runtime dependency.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
pub struct FileStat {
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
pub struct FileSlice {
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub offset: u64,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub len: u64,
    pub text: String,
    pub eof: bool,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub file_size: u64,
}

/// Result of streaming scan for a 1-based line start offset.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
pub struct LineOffsetResult {
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub line: u64,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub offset: u64,
    pub found: bool,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub total_lines: u64,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub file_size: u64,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
pub struct RemoteFileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSlice {
    pub content: String,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub offset: u64,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub next_offset: u64,
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub file_size: u64,
    pub eof: bool,
}

// SSH and local stat serialize identically. Keep one Rust definition.
pub type RemoteFileStat = FileStat;
