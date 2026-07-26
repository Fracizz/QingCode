use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCandidate {
    pub symbol_id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub relative: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub confidence: String,
    pub approximate: bool,
    pub usage_kind: Option<String>,
    pub caller_name: Option<String>,
    pub caller_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSymbolResponse {
    pub symbol_id: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub definitions: Vec<SemanticCandidate>,
    pub files_indexed: usize,
    pub complete: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindUsagesResponse {
    pub symbol_id: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub definition: Option<SemanticCandidate>,
    pub usages: Vec<SemanticCandidate>,
    pub total_count: usize,
    pub files_indexed: usize,
    pub complete: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbolIndexResponse {
    pub definitions: Vec<SemanticCandidate>,
    pub files_indexed: usize,
    pub available: bool,
    pub complete: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexStatus {
    pub root: String,
    pub files_indexed: usize,
    pub complete: bool,
    pub truncated: bool,
}
