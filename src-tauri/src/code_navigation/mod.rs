//! QingCode's incremental, syntax-aware code-navigation engine.
//!
//! This module deliberately stops short of compiler-grade type checking. It
//! builds a compact scope graph, binds lexical references, resolves explicit
//! imports, and keeps uncertain member matches marked as approximate.

use crate::path_guard::PathAllowlist;
use ignore::{WalkBuilder, WalkState};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tauri::State;
use tree_sitter::{Node, Parser};

mod dto;
mod language;
mod query;

pub use dto::{
    FindUsagesResponse, ResolveSymbolResponse, SemanticCandidate, SemanticIndexStatus,
    WorkspaceSymbolIndexResponse,
};
use language::{language_for_path, LanguageFamily};
use query::resolve_query;

// Keep background indexing focused on normal source files. The active editor
// may still request semantic navigation for a larger file explicitly.
const MAX_INDEX_FILE_BYTES: u64 = 256 * 1024;
const MAX_OPEN_FILE_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 8000;
const DEFAULT_MAX_RESULTS: usize = 120;
const HARD_MAX_RESULTS: usize = 500;
const MAX_CACHED_FILES: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeKind {
    Module,
    Function,
    Class,
    Block,
}

#[derive(Debug, Clone)]
struct SemanticScope {
    parent: Option<usize>,
    kind: ScopeKind,
    start: usize,
    end: usize,
    owner_name: Option<String>,
    owner_kind: Option<String>,
}

#[derive(Debug, Clone)]
struct ImportBinding {
    module: String,
    imported_name: String,
    namespace: bool,
}

#[derive(Debug, Clone)]
struct JavascriptPathMapping {
    pattern: String,
    targets: Vec<String>,
}

#[derive(Debug, Clone)]
struct JavascriptModuleConfig {
    base_url: PathBuf,
    paths: Vec<JavascriptPathMapping>,
}

#[derive(Debug, Clone, Default)]
struct WorkspaceModuleConfig {
    javascript: Option<JavascriptModuleConfig>,
    go_module: Option<String>,
}

#[derive(Debug, Clone)]
struct SemanticDefinition {
    symbol_id: String,
    name: String,
    kind: String,
    path: String,
    relative: String,
    line: u32,
    column: u32,
    text: String,
    start: usize,
    end: usize,
    scope_id: usize,
    exported: bool,
    default_export: bool,
    import: Option<ImportBinding>,
    inferred_type: Option<String>,
    owner_type: Option<String>,
}

#[derive(Debug, Clone)]
struct SemanticReference {
    name: String,
    kind: String,
    path: String,
    relative: String,
    line: u32,
    column: u32,
    text: String,
    start: usize,
    end: usize,
    scope_id: usize,
    resolved_symbol_id: Option<String>,
    receiver: Option<String>,
    caller_name: Option<String>,
    caller_kind: Option<String>,
    approximate: bool,
}

#[derive(Debug, Clone)]
struct SemanticFile {
    path: PathBuf,
    definitions: Vec<Arc<SemanticDefinition>>,
    references: Vec<Arc<SemanticReference>>,
    re_exports: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedSemanticFile {
    modified: Option<SystemTime>,
    len: u64,
    overlay_revision: Option<u64>,
    content_fingerprint: Option<u64>,
    semantics: Arc<SemanticFile>,
}

#[derive(Debug, Default)]
struct WorkspaceSemanticIndex {
    root: PathBuf,
    files: HashMap<String, Arc<SemanticFile>>,
    definitions_by_name: HashMap<String, Vec<Arc<SemanticDefinition>>>,
    references_by_name: HashMap<String, Vec<Arc<SemanticReference>>>,
    symbols_by_id: HashMap<String, Arc<SemanticDefinition>>,
    aliases: HashMap<String, String>,
    module_config: WorkspaceModuleConfig,
    complete: bool,
    files_indexed: usize,
    truncated: bool,
}

#[derive(Debug, Default)]
struct SemanticIndexInner {
    cache: HashMap<String, CachedSemanticFile>,
    workspaces: HashMap<String, WorkspaceSemanticIndex>,
}

#[derive(Clone, Default)]
pub struct SemanticNavigationState {
    inner: Arc<RwLock<SemanticIndexInner>>,
    root_generations: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
}

impl SemanticNavigationState {
    pub fn new() -> Self {
        Self::default()
    }

    fn begin_root_index(&self, root: &Path) -> (String, Arc<AtomicU64>, u64) {
        let key = path_key(root);
        let generation = {
            let mut roots = self
                .root_generations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            roots
                .entry(key.clone())
                .or_insert_with(|| Arc::new(AtomicU64::new(0)))
                .clone()
        };
        let value = generation.fetch_add(1, Ordering::SeqCst) + 1;
        (key, generation, value)
    }

    fn cancel_root_index(&self, root: &Path) {
        let key = path_key(root);
        let generation = self
            .root_generations
            .lock()
            .ok()
            .and_then(|roots| roots.get(&key).cloned());
        if let Some(generation) = generation {
            generation.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn ensure_workspace_root(&self, root: &Path) {
        if let Ok(mut inner) = self.inner.write() {
            inner
                .workspaces
                .entry(path_key(root))
                .or_insert_with(|| WorkspaceSemanticIndex::new(root.to_path_buf()));
        }
    }

    fn cached_disk(
        &self,
        root: &Path,
        path: &Path,
        modified: Option<SystemTime>,
        len: u64,
    ) -> Option<Arc<SemanticFile>> {
        self.inner
            .read()
            .ok()?
            .cache
            .get(&file_cache_key(root, path))
            .filter(|entry| {
                entry.overlay_revision.is_none() && entry.modified == modified && entry.len == len
            })
            .map(|entry| entry.semantics.clone())
    }

    fn cache_file(&self, root: &Path, path: &Path, entry: CachedSemanticFile) {
        let Ok(mut inner) = self.inner.write() else {
            return;
        };
        if inner.cache.len() >= MAX_CACHED_FILES {
            inner.cache.clear();
        }
        inner.cache.insert(file_cache_key(root, path), entry);
    }

    pub(crate) fn invalidate_path(&self, path: &Path) {
        let key = path_key(path);
        let Ok(mut inner) = self.inner.write() else {
            return;
        };
        let suffix = format!("|{key}");
        inner
            .cache
            .retain(|cache_key, _| !cache_key.ends_with(&suffix));
        for workspace in inner.workspaces.values_mut() {
            if workspace.files.remove(&key).is_some() {
                workspace.rebuild_maps();
            }
        }
    }
}

fn path_key(path: &Path) -> String {
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir => Some(String::new()),
            Component::CurDir => None,
            Component::ParentDir => Some("..".to_string()),
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
        })
        .collect::<Vec<_>>()
        .join("/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn file_cache_key(root: &Path, path: &Path) -> String {
    format!("{}|{}", path_key(root), path_key(path))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or_default()
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character| matches!(character, '\'' | '"' | '`'))
        .to_string()
}

fn line_text(source: &[u8], start: usize) -> String {
    let line_start = source[..start.min(source.len())]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |position| position + 1);
    let line_end = source[start.min(source.len())..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(source.len(), |position| start.min(source.len()) + position);
    String::from_utf8_lossy(&source[line_start..line_end])
        .trim()
        .chars()
        .take(240)
        .collect()
}

fn location(source: &[u8], start: usize) -> (u32, u32) {
    let safe_start = start.min(source.len());
    let line_start = source[..safe_start]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |position| position + 1);
    let line = source[..safe_start]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        .saturating_add(1) as u32;
    let column = String::from_utf8_lossy(&source[line_start..safe_start])
        .encode_utf16()
        .count()
        .saturating_add(1) as u32;
    (line, column)
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn named_children_with_fields(node: Node<'_>) -> Vec<(Node<'_>, Option<&'static str>)> {
    (0..node.child_count())
        .filter_map(|index| {
            let child = node.child(index as u32)?;
            child
                .is_named()
                .then(|| (child, node.field_name_for_child(index as u32)))
        })
        .collect()
}

fn field_name_for_node(parent: Node<'_>, child: Node<'_>) -> Option<&'static str> {
    (0..parent.child_count()).find_map(|index| {
        (parent.child(index as u32) == Some(child))
            .then(|| parent.field_name_for_child(index as u32))
            .flatten()
    })
}

fn field_contains(parent: Node<'_>, field: &str, child: Node<'_>) -> bool {
    parent.child_by_field_name(field).is_some_and(|field_node| {
        field_node.start_byte() <= child.start_byte() && field_node.end_byte() >= child.end_byte()
    })
}

fn first_named_descendant<'a>(node: Node<'a>, kinds: &[&str]) -> Option<Node<'a>> {
    if kinds.contains(&node.kind()) {
        return Some(node);
    }
    for child in named_children(node) {
        if let Some(found) = first_named_descendant(child, kinds) {
            return Some(found);
        }
    }
    None
}

fn named_descendant_with_text<'a>(
    node: Node<'a>,
    source: &'a [u8],
    kinds: &[&str],
    expected: &str,
) -> Option<Node<'a>> {
    if kinds.contains(&node.kind()) && normalize_identifier(node_text(node, source)) == expected {
        return Some(node);
    }
    for child in named_children(node) {
        if let Some(found) = named_descendant_with_text(child, source, kinds, expected) {
            return Some(found);
        }
    }
    None
}

fn normalize_identifier(value: &str) -> String {
    value.trim().trim_start_matches('#').to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedImport {
    local_name: String,
    module: String,
    imported_name: String,
    namespace: bool,
}

fn split_top_level(value: &str, delimiter: char) -> Vec<&str> {
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut output = Vec::new();
    for (index, character) in value.char_indices() {
        match character {
            '{' => depth = depth.saturating_add(1),
            '}' => depth = depth.saturating_sub(1),
            _ if character == delimiter && depth == 0 => {
                output.push(value[start..index].trim());
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    output.push(value[start..].trim());
    output
}

fn parse_rust_use_item(prefix: &str, value: &str, output: &mut Vec<ParsedImport>) {
    let value = value.trim();
    if value.is_empty() || value == "*" {
        return;
    }
    if let (Some(open), Some(close)) = (value.find('{'), value.rfind('}')) {
        if close > open {
            let base = value[..open].trim().trim_end_matches("::");
            let combined = if prefix.is_empty() {
                base.to_string()
            } else if base.is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix}::{base}")
            };
            for item in split_top_level(&value[open + 1..close], ',') {
                parse_rust_use_item(&combined, item, output);
            }
            return;
        }
    }

    let (path, alias) = value
        .rsplit_once(" as ")
        .map_or((value, None), |(path, alias)| {
            (path.trim(), Some(alias.trim()))
        });
    let full_path = if prefix.is_empty() {
        path.to_string()
    } else if path.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}::{path}")
    };
    let mut parts = full_path
        .split("::")
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let Some(imported) = parts.pop() else {
        return;
    };
    if imported == "self" {
        let Some(module_name) = parts.last().copied() else {
            return;
        };
        output.push(ParsedImport {
            local_name: alias.unwrap_or(module_name).to_string(),
            module: parts.join("::"),
            imported_name: "*".to_string(),
            namespace: true,
        });
        return;
    }
    let module = if parts.is_empty() {
        "crate".to_string()
    } else {
        parts.join("::")
    };
    output.push(ParsedImport {
        local_name: alias.unwrap_or(imported).to_string(),
        module,
        imported_name: imported.to_string(),
        namespace: false,
    });
}

fn parse_rust_use(value: &str) -> Vec<ParsedImport> {
    let Some(use_start) = value.find("use ") else {
        return Vec::new();
    };
    let body = value[use_start + 4..].trim().trim_end_matches(';').trim();
    let mut output = Vec::new();
    parse_rust_use_item("", body, &mut output);
    output
}

fn is_identifier_kind(language: LanguageFamily, kind: &str) -> bool {
    match language {
        LanguageFamily::JavaScript => matches!(
            kind,
            "identifier"
                | "shorthand_property_identifier"
                | "property_identifier"
                | "type_identifier"
        ),
        LanguageFamily::Python => kind == "identifier",
        LanguageFamily::Rust => {
            matches!(kind, "identifier" | "type_identifier" | "field_identifier")
        }
        LanguageFamily::Go => matches!(kind, "identifier" | "field_identifier" | "type_identifier"),
        LanguageFamily::Java => kind == "identifier" || kind == "type_identifier",
    }
}

struct SemanticBuilder<'a> {
    root: &'a Path,
    path: &'a Path,
    source: &'a [u8],
    language: LanguageFamily,
    scopes: Vec<SemanticScope>,
    definitions: Vec<SemanticDefinition>,
    references: Vec<SemanticReference>,
    re_exports: Vec<String>,
    definition_ranges: HashSet<(usize, usize)>,
    reference_skip_ranges: Vec<(usize, usize)>,
    python_globals: HashMap<usize, HashSet<String>>,
    python_nonlocals: HashMap<usize, HashSet<String>>,
}

impl<'a> SemanticBuilder<'a> {
    fn new(root: &'a Path, path: &'a Path, source: &'a [u8], language: LanguageFamily) -> Self {
        Self {
            root,
            path,
            source,
            language,
            scopes: vec![SemanticScope {
                parent: None,
                kind: ScopeKind::Module,
                start: 0,
                end: source.len(),
                owner_name: None,
                owner_kind: None,
            }],
            definitions: Vec::new(),
            references: Vec::new(),
            re_exports: Vec::new(),
            definition_ranges: HashSet::new(),
            reference_skip_ranges: Vec::new(),
            python_globals: HashMap::new(),
            python_nonlocals: HashMap::new(),
        }
    }

    fn finish(mut self) -> SemanticFile {
        self.bind_lexical_references();
        SemanticFile {
            path: self.path.to_path_buf(),
            definitions: self.definitions.into_iter().map(Arc::new).collect(),
            references: self.references.into_iter().map(Arc::new).collect(),
            re_exports: self.re_exports,
        }
    }

    fn add_scope(
        &mut self,
        parent: usize,
        kind: ScopeKind,
        node: Node<'_>,
        owner_name: Option<String>,
        owner_kind: Option<String>,
    ) -> usize {
        let id = self.scopes.len();
        self.scopes.push(SemanticScope {
            parent: Some(parent),
            kind,
            start: node.start_byte(),
            end: node.end_byte(),
            owner_name,
            owner_kind,
        });
        id
    }

    fn nearest_function_scope(&self, mut scope_id: usize) -> usize {
        loop {
            let scope = &self.scopes[scope_id];
            if matches!(scope.kind, ScopeKind::Function | ScopeKind::Module) {
                return scope_id;
            }
            let Some(parent) = scope.parent else {
                return scope_id;
            };
            scope_id = parent;
        }
    }

    fn scope_at(&self, position: usize) -> usize {
        self.scopes
            .iter()
            .enumerate()
            .filter(|(_, scope)| scope.start <= position && position <= scope.end)
            .min_by_key(|(_, scope)| scope.end.saturating_sub(scope.start))
            .map_or(0, |(index, _)| index)
    }

    fn symbol_id(&self, name: &str, kind: &str, start: usize) -> String {
        format!("{}#{start}:{kind}:{name}", path_key(self.path))
    }

    fn existing_lexical_definition(&self, scope_id: usize, name: &str) -> Option<usize> {
        self.definitions.iter().position(|definition| {
            definition.scope_id == scope_id
                && definition.name == name
                && matches!(
                    definition.kind.as_str(),
                    "variable" | "parameter" | "import" | "constant"
                )
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn add_definition(
        &mut self,
        node: Node<'_>,
        name: String,
        kind: &str,
        scope_id: usize,
        exported: bool,
        import: Option<ImportBinding>,
        inferred_type: Option<String>,
        owner_type: Option<String>,
        canonical_lexical: bool,
    ) -> Option<String> {
        let name = normalize_identifier(&name);
        if name.is_empty() {
            return None;
        }
        if canonical_lexical {
            if let Some(index) = self.existing_lexical_definition(scope_id, &name) {
                return Some(self.definitions[index].symbol_id.clone());
            }
        }
        let start = node.start_byte();
        let end = node.end_byte();
        let (line, column) = location(self.source, start);
        let symbol_id = self.symbol_id(&name, kind, start);
        self.definition_ranges.insert((start, end));
        self.definitions.push(SemanticDefinition {
            symbol_id: symbol_id.clone(),
            name,
            kind: kind.to_string(),
            path: self.path.to_string_lossy().into_owned(),
            relative: relative_path(self.root, self.path),
            line,
            column,
            text: line_text(self.source, start),
            start,
            end,
            scope_id,
            exported,
            default_export: false,
            import,
            inferred_type,
            owner_type,
        });
        Some(symbol_id)
    }

    fn mark_skip_references(&mut self, node: Node<'_>) {
        self.reference_skip_ranges
            .push((node.start_byte(), node.end_byte()));
    }

    fn references_skipped_at(&self, start: usize, end: usize) -> bool {
        self.reference_skip_ranges
            .iter()
            .any(|range| range.0 <= start && range.1 >= end)
    }

    fn collect_binding_nodes(&self, node: Node<'a>, output: &mut Vec<Node<'a>>) {
        match self.language {
            LanguageFamily::JavaScript => {
                if matches!(
                    node.kind(),
                    "identifier" | "shorthand_property_identifier_pattern"
                ) {
                    output.push(node);
                    return;
                }
                if matches!(
                    node.kind(),
                    "type_annotation"
                        | "predefined_type"
                        | "member_expression"
                        | "subscript_expression"
                ) {
                    return;
                }
                for (child, field) in named_children_with_fields(node) {
                    if matches!(node.kind(), "pair_pattern" | "pair") && field == Some("key") {
                        continue;
                    }
                    if matches!(node.kind(), "assignment_pattern" | "required_parameter")
                        && matches!(field, Some("right") | Some("value") | Some("type"))
                    {
                        continue;
                    }
                    self.collect_binding_nodes(child, output);
                }
            }
            LanguageFamily::Python => {
                if node.kind() == "identifier" {
                    output.push(node);
                    return;
                }
                if matches!(
                    node.kind(),
                    "attribute" | "subscript" | "type" | "type_parameter"
                ) {
                    return;
                }
                for (child, field) in named_children_with_fields(node) {
                    if matches!(node.kind(), "default_parameter" | "typed_default_parameter")
                        && matches!(field, Some("value") | Some("type"))
                    {
                        continue;
                    }
                    if node.kind() == "typed_parameter" && field == Some("type") {
                        continue;
                    }
                    self.collect_binding_nodes(child, output);
                }
            }
            _ => {
                if matches!(node.kind(), "identifier" | "field_identifier") {
                    output.push(node);
                    return;
                }
                for child in named_children(node) {
                    self.collect_binding_nodes(child, output);
                }
            }
        }
    }

    fn inferred_type_from(
        &self,
        value: Option<Node<'_>>,
        annotation: Option<Node<'_>>,
    ) -> Option<String> {
        if let Some(annotation) = annotation {
            if let Some(identifier) =
                first_named_descendant(annotation, &["type_identifier", "identifier"])
            {
                let name = normalize_identifier(node_text(identifier, self.source));
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        let value = value?;
        match (self.language, value.kind()) {
            (LanguageFamily::JavaScript, "new_expression") => value
                .child_by_field_name("constructor")
                .map(|node| normalize_identifier(node_text(node, self.source))),
            (LanguageFamily::Python, "call") => value
                .child_by_field_name("function")
                .filter(|node| node.kind() == "identifier")
                .map(|node| normalize_identifier(node_text(node, self.source))),
            (LanguageFamily::Java, "object_creation_expression") => value
                .child_by_field_name("type")
                .and_then(|node| {
                    first_named_descendant(node, &["type_identifier", "identifier"]).or(Some(node))
                })
                .map(|node| normalize_identifier(node_text(node, self.source))),
            _ => None,
        }
        .filter(|name| !name.is_empty())
    }

    fn walk_definitions(
        &mut self,
        node: Node<'a>,
        scope_id: usize,
        owner_type: Option<String>,
        exported: bool,
    ) {
        match self.language {
            LanguageFamily::JavaScript => {
                self.walk_javascript_definitions(node, scope_id, owner_type, exported)
            }
            LanguageFamily::Python => self.walk_python_definitions(node, scope_id, owner_type),
            _ => self.walk_generic_definitions(node, scope_id, owner_type),
        }
    }

    fn walk_javascript_definitions(
        &mut self,
        node: Node<'a>,
        scope_id: usize,
        owner_type: Option<String>,
        exported: bool,
    ) {
        match node.kind() {
            "export_statement" => {
                if node.child_by_field_name("source").is_some() {
                    self.mark_skip_references(node);
                    self.add_javascript_reexports(node, scope_id);
                    return;
                }
                let definition_start = self.definitions.len();
                let default_export = node_text(node, self.source)
                    .trim_start()
                    .starts_with("export default ");
                for child in named_children(node) {
                    self.walk_javascript_definitions(child, scope_id, owner_type.clone(), true);
                }
                if default_export {
                    for definition in &mut self.definitions[definition_start..] {
                        if definition.scope_id == scope_id {
                            definition.default_export = true;
                        }
                    }
                }
                return;
            }
            "import_statement" => {
                self.mark_skip_references(node);
                self.add_javascript_imports(node, scope_id);
                return;
            }
            "function_declaration" | "generator_function_declaration" | "function_signature" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                    self.add_definition(
                        name_node,
                        name,
                        "function",
                        scope_id,
                        exported,
                        None,
                        None,
                        owner_type.clone(),
                        false,
                    );
                }
                let function_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    name,
                    Some("function".to_string()),
                );
                if let Some(parameters) = node.child_by_field_name("parameters") {
                    self.add_parameters(parameters, function_scope);
                }
                for child in named_children(node) {
                    if Some(child) == name_node
                        || node.child_by_field_name("parameters") == Some(child)
                    {
                        continue;
                    }
                    self.walk_javascript_definitions(
                        child,
                        function_scope,
                        owner_type.clone(),
                        false,
                    );
                }
                return;
            }
            "function_expression" | "generator_function" | "arrow_function" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                let function_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    name.clone(),
                    Some("function".to_string()),
                );
                if let (Some(name_node), Some(name)) = (name_node, name) {
                    self.add_definition(
                        name_node,
                        name,
                        "function",
                        function_scope,
                        false,
                        None,
                        None,
                        owner_type.clone(),
                        false,
                    );
                }
                if let Some(parameters) = node.child_by_field_name("parameters") {
                    self.add_parameters(parameters, function_scope);
                } else if let Some(parameter) = node.child_by_field_name("parameter") {
                    self.add_parameters(parameter, function_scope);
                }
                for child in named_children(node) {
                    if Some(child) == name_node
                        || node.child_by_field_name("parameters") == Some(child)
                        || node.child_by_field_name("parameter") == Some(child)
                    {
                        continue;
                    }
                    self.walk_javascript_definitions(
                        child,
                        function_scope,
                        owner_type.clone(),
                        false,
                    );
                }
                return;
            }
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                    self.add_definition(
                        name_node,
                        name,
                        "method",
                        scope_id,
                        exported,
                        None,
                        None,
                        owner_type.clone(),
                        false,
                    );
                }
                let function_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    name,
                    Some("method".to_string()),
                );
                if let Some(parameters) = node.child_by_field_name("parameters") {
                    self.add_parameters(parameters, function_scope);
                }
                for child in named_children(node) {
                    if Some(child) == name_node
                        || node.child_by_field_name("parameters") == Some(child)
                    {
                        continue;
                    }
                    self.walk_javascript_definitions(
                        child,
                        function_scope,
                        owner_type.clone(),
                        false,
                    );
                }
                return;
            }
            "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "enum_declaration" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                let kind = match node.kind() {
                    "interface_declaration" => "interface",
                    "enum_declaration" => "enum",
                    _ => "class",
                };
                if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                    self.add_definition(
                        name_node, name, kind, scope_id, exported, None, None, None, false,
                    );
                }
                let class_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Class,
                    node,
                    name.clone(),
                    Some(kind.to_string()),
                );
                for child in named_children(node) {
                    if Some(child) == name_node {
                        continue;
                    }
                    self.walk_javascript_definitions(child, class_scope, name.clone(), exported);
                }
                return;
            }
            "type_alias_declaration" | "module" | "internal_module" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let kind = if node.kind() == "type_alias_declaration" {
                        "type"
                    } else {
                        "module"
                    };
                    self.add_definition(
                        name_node,
                        node_text(name_node, self.source).to_string(),
                        kind,
                        scope_id,
                        exported,
                        None,
                        None,
                        None,
                        false,
                    );
                }
            }
            "variable_declarator" => {
                let Some(pattern) = node.child_by_field_name("name") else {
                    return;
                };
                let value = node.child_by_field_name("value");
                let annotation = pattern
                    .child_by_field_name("type")
                    .or_else(|| node.child_by_field_name("type"));
                let inferred_type = self.inferred_type_from(value, annotation);
                let definition_kind = if value.is_some_and(|value| {
                    matches!(
                        value.kind(),
                        "arrow_function" | "function_expression" | "generator_function"
                    )
                }) {
                    "function"
                } else {
                    "variable"
                };
                let declaration_scope = if node
                    .parent()
                    .is_some_and(|parent| parent.kind() == "variable_declaration")
                {
                    self.nearest_function_scope(scope_id)
                } else {
                    scope_id
                };
                let mut bindings = Vec::new();
                self.collect_binding_nodes(pattern, &mut bindings);
                for binding in bindings {
                    self.add_definition(
                        binding,
                        node_text(binding, self.source).to_string(),
                        definition_kind,
                        declaration_scope,
                        exported,
                        None,
                        inferred_type.clone(),
                        owner_type.clone(),
                        definition_kind == "variable",
                    );
                }
                if let Some(value) = value {
                    self.walk_javascript_definitions(value, scope_id, owner_type.clone(), false);
                }
                return;
            }
            "catch_clause" => {
                let catch_scope = self.add_scope(scope_id, ScopeKind::Block, node, None, None);
                if let Some(parameter) = node.child_by_field_name("parameter") {
                    self.add_parameters(parameter, catch_scope);
                }
                for child in named_children(node) {
                    if node.child_by_field_name("parameter") == Some(child) {
                        continue;
                    }
                    self.walk_javascript_definitions(child, catch_scope, owner_type.clone(), false);
                }
                return;
            }
            "statement_block" => {
                let block_scope = self.add_scope(scope_id, ScopeKind::Block, node, None, None);
                for child in named_children(node) {
                    self.walk_javascript_definitions(
                        child,
                        block_scope,
                        owner_type.clone(),
                        exported,
                    );
                }
                return;
            }
            _ => {}
        }

        for child in named_children(node) {
            self.walk_javascript_definitions(child, scope_id, owner_type.clone(), exported);
        }
    }

    fn add_parameters(&mut self, parameters: Node<'a>, scope_id: usize) {
        let mut bindings = Vec::new();
        self.collect_binding_nodes(parameters, &mut bindings);
        let owner_type = self.class_owner_for_scope(scope_id);
        for binding in bindings {
            let annotation = binding
                .parent()
                .and_then(|parent| parent.child_by_field_name("type"));
            let mut inferred_type = self.inferred_type_from(None, annotation);
            let name = node_text(binding, self.source).to_string();
            if inferred_type.is_none() && matches!(name.as_str(), "self" | "cls" | "this") {
                inferred_type.clone_from(&owner_type);
            }
            self.add_definition(
                binding,
                name,
                "parameter",
                scope_id,
                false,
                None,
                inferred_type,
                owner_type.clone(),
                true,
            );
        }
    }

    fn class_owner_for_scope(&self, mut scope_id: usize) -> Option<String> {
        loop {
            let scope = &self.scopes[scope_id];
            if scope.kind == ScopeKind::Class {
                return scope.owner_name.clone();
            }
            let parent = scope.parent?;
            scope_id = parent;
        }
    }

    fn python_binding_scope(&self, scope_id: usize, name: &str) -> usize {
        if self
            .python_globals
            .get(&scope_id)
            .is_some_and(|bindings| bindings.contains(name))
        {
            return 0;
        }
        if !self
            .python_nonlocals
            .get(&scope_id)
            .is_some_and(|bindings| bindings.contains(name))
        {
            return scope_id;
        }
        let mut parent = self.scopes[scope_id].parent;
        let mut nearest_function = None;
        while let Some(parent_scope) = parent {
            if self.scopes[parent_scope].kind == ScopeKind::Function {
                nearest_function.get_or_insert(parent_scope);
                if self
                    .existing_lexical_definition(parent_scope, name)
                    .is_some()
                {
                    return parent_scope;
                }
            }
            parent = self.scopes[parent_scope].parent;
        }
        nearest_function.unwrap_or(scope_id)
    }

    fn add_python_scope_directive(&mut self, node: Node<'_>, scope_id: usize, global: bool) {
        let names = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "identifier")
            .map(|child| node_text(child, self.source).to_string())
            .collect::<Vec<_>>();
        let directives = if global {
            &mut self.python_globals
        } else {
            &mut self.python_nonlocals
        };
        directives.entry(scope_id).or_default().extend(names);
    }

    fn add_import_definition(
        &mut self,
        node: Node<'_>,
        local_name: String,
        scope_id: usize,
        module: String,
        imported_name: String,
        namespace: bool,
    ) {
        self.add_import_definition_with_export(
            node,
            local_name,
            scope_id,
            module,
            imported_name,
            namespace,
            false,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn add_import_definition_with_export(
        &mut self,
        node: Node<'_>,
        local_name: String,
        scope_id: usize,
        module: String,
        imported_name: String,
        namespace: bool,
        exported: bool,
    ) {
        self.add_definition(
            node,
            local_name,
            "import",
            scope_id,
            exported,
            Some(ImportBinding {
                module,
                imported_name,
                namespace,
            }),
            None,
            None,
            true,
        );
    }

    fn add_javascript_imports(&mut self, node: Node<'a>, scope_id: usize) {
        let Some(source_node) = node.child_by_field_name("source") else {
            return;
        };
        let module = unquote(node_text(source_node, self.source));
        let Some(clause) = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "import_clause")
        else {
            return;
        };
        for child in named_children(clause) {
            match child.kind() {
                "identifier" => self.add_import_definition(
                    child,
                    node_text(child, self.source).to_string(),
                    scope_id,
                    module.clone(),
                    "default".to_string(),
                    false,
                ),
                "namespace_import" => {
                    if let Some(local) = first_named_descendant(child, &["identifier"]) {
                        self.add_import_definition(
                            local,
                            node_text(local, self.source).to_string(),
                            scope_id,
                            module.clone(),
                            "*".to_string(),
                            true,
                        );
                    }
                }
                "named_imports" => {
                    for specifier in named_children(child)
                        .into_iter()
                        .filter(|candidate| candidate.kind() == "import_specifier")
                    {
                        let Some(imported) = specifier.child_by_field_name("name") else {
                            continue;
                        };
                        let local = specifier.child_by_field_name("alias").unwrap_or(imported);
                        self.add_import_definition(
                            local,
                            node_text(local, self.source).to_string(),
                            scope_id,
                            module.clone(),
                            unquote(node_text(imported, self.source)),
                            false,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    fn add_javascript_reexports(&mut self, node: Node<'a>, scope_id: usize) {
        let Some(source_node) = node.child_by_field_name("source") else {
            return;
        };
        let module = unquote(node_text(source_node, self.source));
        let export_clause = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "export_clause");
        if let Some(export_clause) = export_clause {
            for specifier in named_children(export_clause)
                .into_iter()
                .filter(|candidate| candidate.kind() == "export_specifier")
            {
                let Some(imported) = specifier.child_by_field_name("name") else {
                    continue;
                };
                let local = specifier.child_by_field_name("alias").unwrap_or(imported);
                self.add_import_definition_with_export(
                    local,
                    unquote(node_text(local, self.source)),
                    scope_id,
                    module.clone(),
                    unquote(node_text(imported, self.source)),
                    false,
                    true,
                );
            }
            return;
        }
        if let Some(namespace) = named_children(node)
            .into_iter()
            .find(|child| child.kind() == "namespace_export")
            .and_then(|child| first_named_descendant(child, &["identifier"]))
        {
            self.add_import_definition_with_export(
                namespace,
                node_text(namespace, self.source).to_string(),
                scope_id,
                module,
                "*".to_string(),
                true,
                true,
            );
            return;
        }
        self.re_exports.push(module);
    }

    fn walk_python_definitions(
        &mut self,
        node: Node<'a>,
        scope_id: usize,
        owner_type: Option<String>,
    ) {
        match node.kind() {
            "global_statement" => {
                self.add_python_scope_directive(node, scope_id, true);
                return;
            }
            "nonlocal_statement" => {
                self.add_python_scope_directive(node, scope_id, false);
                return;
            }
            "import_statement" | "import_from_statement" => {
                self.mark_skip_references(node);
                self.add_python_imports(node, scope_id);
                return;
            }
            "function_definition" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                    self.add_definition(
                        name_node,
                        name,
                        if owner_type.is_some() {
                            "method"
                        } else {
                            "function"
                        },
                        scope_id,
                        scope_id == 0,
                        None,
                        None,
                        owner_type.clone(),
                        false,
                    );
                }
                let function_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    name,
                    Some(if owner_type.is_some() {
                        "method".to_string()
                    } else {
                        "function".to_string()
                    }),
                );
                if let Some(parameters) = node.child_by_field_name("parameters") {
                    self.add_parameters(parameters, function_scope);
                }
                for child in named_children(node) {
                    if Some(child) == name_node
                        || node.child_by_field_name("parameters") == Some(child)
                    {
                        continue;
                    }
                    self.walk_python_definitions(child, function_scope, owner_type.clone());
                }
                return;
            }
            "lambda" => {
                let function_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    None,
                    Some("function".to_string()),
                );
                if let Some(parameters) = node.child_by_field_name("parameters") {
                    self.add_parameters(parameters, function_scope);
                }
                for child in named_children(node) {
                    if node.child_by_field_name("parameters") == Some(child) {
                        continue;
                    }
                    self.walk_python_definitions(child, function_scope, owner_type.clone());
                }
                return;
            }
            "class_definition" => {
                let name_node = node.child_by_field_name("name");
                let name = name_node.map(|name| node_text(name, self.source).to_string());
                if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                    self.add_definition(
                        name_node,
                        name,
                        "class",
                        scope_id,
                        scope_id == 0,
                        None,
                        None,
                        None,
                        false,
                    );
                }
                let class_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Class,
                    node,
                    name.clone(),
                    Some("class".to_string()),
                );
                for child in named_children(node) {
                    if Some(child) == name_node {
                        continue;
                    }
                    self.walk_python_definitions(child, class_scope, name.clone());
                }
                return;
            }
            "assignment" | "named_expression" => {
                let left = node
                    .child_by_field_name("left")
                    .or_else(|| node.child_by_field_name("name"));
                let value = node
                    .child_by_field_name("right")
                    .or_else(|| node.child_by_field_name("value"));
                if let Some(left) = left {
                    let annotation = node.child_by_field_name("type");
                    let inferred_type = self.inferred_type_from(value, annotation);
                    let mut bindings = Vec::new();
                    self.collect_binding_nodes(left, &mut bindings);
                    for binding in bindings {
                        let name = node_text(binding, self.source).to_string();
                        let binding_scope = self.python_binding_scope(scope_id, &name);
                        self.add_definition(
                            binding,
                            name,
                            "variable",
                            binding_scope,
                            binding_scope == 0,
                            None,
                            inferred_type.clone(),
                            owner_type.clone(),
                            true,
                        );
                    }
                }
                if let Some(value) = value {
                    self.walk_python_definitions(value, scope_id, owner_type.clone());
                }
                return;
            }
            "for_statement" | "for_in_clause" => {
                if let Some(left) = node.child_by_field_name("left") {
                    let mut bindings = Vec::new();
                    self.collect_binding_nodes(left, &mut bindings);
                    for binding in bindings {
                        let name = node_text(binding, self.source).to_string();
                        let binding_scope = self.python_binding_scope(scope_id, &name);
                        self.add_definition(
                            binding,
                            name,
                            "variable",
                            binding_scope,
                            false,
                            None,
                            None,
                            owner_type.clone(),
                            true,
                        );
                    }
                }
                for child in named_children(node) {
                    if node.child_by_field_name("left") == Some(child) {
                        continue;
                    }
                    self.walk_python_definitions(child, scope_id, owner_type.clone());
                }
                return;
            }
            "list_comprehension"
            | "set_comprehension"
            | "dictionary_comprehension"
            | "generator_expression" => {
                let comprehension_scope = self.add_scope(
                    scope_id,
                    ScopeKind::Function,
                    node,
                    None,
                    Some("comprehension".to_string()),
                );
                for child in named_children(node) {
                    self.walk_python_definitions(child, comprehension_scope, owner_type.clone());
                }
                return;
            }
            _ => {}
        }
        for child in named_children(node) {
            self.walk_python_definitions(child, scope_id, owner_type.clone());
        }
    }

    fn add_python_imports(&mut self, node: Node<'a>, scope_id: usize) {
        if node.kind() == "import_from_statement" {
            let module = node
                .child_by_field_name("module_name")
                .map(|module| node_text(module, self.source).to_string())
                .unwrap_or_default();
            for (child, field) in named_children_with_fields(node) {
                if field != Some("name") {
                    continue;
                }
                if child.kind() == "aliased_import" {
                    let Some(imported) = child.child_by_field_name("name") else {
                        continue;
                    };
                    let Some(alias) = child.child_by_field_name("alias") else {
                        continue;
                    };
                    self.add_import_definition(
                        alias,
                        node_text(alias, self.source).to_string(),
                        scope_id,
                        module.clone(),
                        node_text(imported, self.source)
                            .rsplit('.')
                            .next()
                            .unwrap_or_default()
                            .to_string(),
                        false,
                    );
                } else {
                    let imported_name = node_text(child, self.source)
                        .rsplit('.')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    if let Some(local) = first_named_descendant(child, &["identifier"]) {
                        self.add_import_definition(
                            local,
                            imported_name.clone(),
                            scope_id,
                            module.clone(),
                            imported_name,
                            false,
                        );
                    }
                }
            }
            return;
        }

        for (child, field) in named_children_with_fields(node) {
            if field != Some("name") {
                continue;
            }
            if child.kind() == "aliased_import" {
                let Some(imported) = child.child_by_field_name("name") else {
                    continue;
                };
                let Some(alias) = child.child_by_field_name("alias") else {
                    continue;
                };
                self.add_import_definition(
                    alias,
                    node_text(alias, self.source).to_string(),
                    scope_id,
                    node_text(imported, self.source).to_string(),
                    "*".to_string(),
                    true,
                );
            } else {
                let module = node_text(child, self.source).to_string();
                if let Some(local) = first_named_descendant(child, &["identifier"]) {
                    self.add_import_definition(
                        local,
                        node_text(local, self.source).to_string(),
                        scope_id,
                        module,
                        "*".to_string(),
                        true,
                    );
                }
            }
        }
    }

    fn add_java_import(&mut self, node: Node<'a>, scope_id: usize) {
        let text = node_text(node, self.source)
            .trim()
            .trim_start_matches("import")
            .trim();
        let (static_import, path) = if let Some(path) = text.strip_prefix("static") {
            (true, path.trim())
        } else {
            (false, text)
        };
        let path = path.trim_end_matches(';').trim();
        if path.is_empty() || path.ends_with(".*") {
            return;
        }
        let mut parts = path.split('.').collect::<Vec<_>>();
        let Some(imported_name) = parts.pop() else {
            return;
        };
        let module = if static_import {
            parts.join(".")
        } else {
            path.to_string()
        };
        let Some(local) = named_descendant_with_text(
            node,
            self.source,
            &["identifier", "type_identifier"],
            imported_name,
        ) else {
            return;
        };
        self.add_import_definition(
            local,
            imported_name.to_string(),
            scope_id,
            module,
            imported_name.to_string(),
            false,
        );
    }

    fn add_rust_imports(&mut self, node: Node<'a>, scope_id: usize) {
        let source = node_text(node, self.source);
        let exported = source.trim_start().starts_with("pub ");
        for import in parse_rust_use(source) {
            let local = named_descendant_with_text(
                node,
                self.source,
                &["identifier", "type_identifier", "self", "crate", "super"],
                &import.local_name,
            )
            .unwrap_or(node);
            self.add_import_definition_with_export(
                local,
                import.local_name,
                scope_id,
                import.module,
                import.imported_name,
                import.namespace,
                exported,
            );
        }
    }

    fn add_go_import(&mut self, node: Node<'a>, scope_id: usize) {
        let Some(path_node) = node.child_by_field_name("path") else {
            return;
        };
        let module = unquote(node_text(path_node, self.source));
        let explicit_name = node.child_by_field_name("name");
        let local_name = explicit_name
            .map(|name| normalize_identifier(node_text(name, self.source)))
            .unwrap_or_else(|| module.rsplit('/').next().unwrap_or_default().to_string());
        if local_name.is_empty() || matches!(local_name.as_str(), "_" | ".") {
            return;
        }
        self.add_import_definition(
            explicit_name.unwrap_or(path_node),
            local_name,
            scope_id,
            module,
            "*".to_string(),
            true,
        );
    }

    fn walk_generic_definitions(
        &mut self,
        node: Node<'a>,
        scope_id: usize,
        owner_type: Option<String>,
    ) {
        match (self.language, node.kind()) {
            (LanguageFamily::Java, "import_declaration") => {
                self.mark_skip_references(node);
                self.add_java_import(node, scope_id);
                return;
            }
            (LanguageFamily::Rust, "use_declaration") => {
                self.mark_skip_references(node);
                self.add_rust_imports(node, scope_id);
                return;
            }
            (LanguageFamily::Go, "import_spec") => {
                self.mark_skip_references(node);
                self.add_go_import(node, scope_id);
                return;
            }
            _ => {}
        }
        let function_kind = matches!(
            node.kind(),
            "function_item"
                | "function_declaration"
                | "method_declaration"
                | "constructor_declaration"
        );
        let class_kind = matches!(
            node.kind(),
            "struct_item"
                | "enum_item"
                | "union_item"
                | "trait_item"
                | "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "type_declaration"
                | "type_spec"
        );
        if function_kind {
            let name_node = node
                .child_by_field_name("name")
                .or_else(|| first_named_descendant(node, &["identifier", "field_identifier"]));
            let name = name_node.map(|name| node_text(name, self.source).to_string());
            if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                self.add_definition(
                    name_node,
                    name,
                    if owner_type.is_some() {
                        "method"
                    } else {
                        "function"
                    },
                    scope_id,
                    scope_id == 0,
                    None,
                    None,
                    owner_type.clone(),
                    false,
                );
            }
            let function_scope = self.add_scope(
                scope_id,
                ScopeKind::Function,
                node,
                name,
                Some("function".to_string()),
            );
            if let Some(parameters) = node
                .child_by_field_name("parameters")
                .or_else(|| node.child_by_field_name("parameter"))
            {
                self.add_parameters(parameters, function_scope);
            }
            for child in named_children(node) {
                if Some(child) == name_node {
                    continue;
                }
                self.walk_generic_definitions(child, function_scope, owner_type.clone());
            }
            return;
        }
        if class_kind {
            let name_node = node
                .child_by_field_name("name")
                .or_else(|| first_named_descendant(node, &["type_identifier", "identifier"]));
            let name = name_node.map(|name| node_text(name, self.source).to_string());
            if let (Some(name_node), Some(name)) = (name_node, name.clone()) {
                self.add_definition(
                    name_node,
                    name,
                    if node.kind().contains("enum") {
                        "enum"
                    } else if node.kind().contains("trait") || node.kind().contains("interface") {
                        "interface"
                    } else {
                        "class"
                    },
                    scope_id,
                    scope_id == 0,
                    None,
                    None,
                    None,
                    false,
                );
            }
            let class_scope = self.add_scope(
                scope_id,
                ScopeKind::Class,
                node,
                name.clone(),
                Some("class".to_string()),
            );
            for child in named_children(node) {
                if Some(child) == name_node {
                    continue;
                }
                self.walk_generic_definitions(child, class_scope, name.clone());
            }
            return;
        }

        if matches!(
            node.kind(),
            "const_item"
                | "static_item"
                | "let_declaration"
                | "const_spec"
                | "var_spec"
                | "short_var_declaration"
                | "variable_declarator"
        ) {
            let pattern = node
                .child_by_field_name("name")
                .or_else(|| node.child_by_field_name("pattern"))
                .or_else(|| node.child_by_field_name("left"));
            if let Some(pattern) = pattern {
                let mut bindings = Vec::new();
                self.collect_binding_nodes(pattern, &mut bindings);
                let value = node.child_by_field_name("value");
                let annotation = if self.language == LanguageFamily::Java {
                    node.parent()
                        .and_then(|parent| parent.child_by_field_name("type"))
                } else {
                    node.child_by_field_name("type")
                };
                let inferred_type = self.inferred_type_from(value, annotation);
                let field = self.language == LanguageFamily::Java
                    && self.scopes[scope_id].kind == ScopeKind::Class;
                for binding in bindings {
                    self.add_definition(
                        binding,
                        node_text(binding, self.source).to_string(),
                        if node.kind().contains("const") || node.kind() == "static_item" {
                            "constant"
                        } else if field {
                            "field"
                        } else {
                            "variable"
                        },
                        scope_id,
                        scope_id == 0,
                        None,
                        inferred_type.clone(),
                        owner_type.clone(),
                        true,
                    );
                }
            }
        }

        for child in named_children(node) {
            self.walk_generic_definitions(child, scope_id, owner_type.clone());
        }
    }

    fn walk_references(&mut self, node: Node<'a>) {
        let start = node.start_byte();
        let end = node.end_byte();
        if self.references_skipped_at(start, end) {
            return;
        }

        if is_identifier_kind(self.language, node.kind())
            && !self.definition_ranges.contains(&(start, end))
            && !self.should_skip_identifier(node)
        {
            self.add_reference_for_node(node);
        }

        for child in named_children(node) {
            self.walk_references(child);
        }
    }

    fn should_skip_identifier(&self, node: Node<'_>) -> bool {
        let Some(parent) = node.parent() else {
            return false;
        };
        let field = field_name_for_node(parent, node);

        if matches!(
            parent.kind(),
            "function_declaration"
                | "function_definition"
                | "class_declaration"
                | "class_definition"
                | "method_definition"
                | "method_declaration"
                | "constructor_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "type_alias_declaration"
                | "type_spec"
                | "struct_item"
                | "trait_item"
        ) && field == Some("name")
        {
            return true;
        }

        if self.language == LanguageFamily::JavaScript {
            if matches!(
                parent.kind(),
                "pair"
                    | "pair_pattern"
                    | "property_signature"
                    | "public_field_definition"
                    | "method_signature"
                    | "abstract_method_signature"
                    | "jsx_attribute"
                    | "labeled_statement"
                    | "break_statement"
                    | "continue_statement"
            ) && matches!(field, Some("key") | Some("name") | Some("label"))
            {
                return true;
            }
            if parent.kind() == "import_specifier" {
                return true;
            }
        }
        if self.language == LanguageFamily::Python
            && matches!(
                parent.kind(),
                "keyword_argument" | "dotted_name" | "global_statement" | "nonlocal_statement"
            )
            && matches!(field, Some("name") | None)
        {
            return true;
        }
        false
    }

    fn member_receiver(&self, node: Node<'_>) -> Option<String> {
        let parent = node.parent()?;
        let field = field_name_for_node(parent, node);
        let is_member = match self.language {
            LanguageFamily::JavaScript => {
                parent.kind() == "member_expression" && field == Some("property")
            }
            LanguageFamily::Python => parent.kind() == "attribute" && field == Some("attribute"),
            LanguageFamily::Rust => parent.kind() == "field_expression" && field == Some("field"),
            LanguageFamily::Go => parent.kind() == "selector_expression" && field == Some("field"),
            LanguageFamily::Java => {
                (parent.kind() == "field_access" && field == Some("field"))
                    || (parent.kind() == "method_invocation" && field == Some("name"))
            }
        };
        if !is_member {
            return None;
        }
        parent
            .child_by_field_name("object")
            .or_else(|| parent.child_by_field_name("operand"))
            .map(|receiver| node_text(receiver, self.source).trim().to_string())
            .filter(|receiver| {
                !receiver.is_empty()
                    && receiver.chars().all(|character| {
                        character == '_' || character == '$' || character.is_alphanumeric()
                    })
            })
    }

    fn node_is_call_target(&self, node: Node<'_>) -> bool {
        let Some(parent) = node.parent() else {
            return false;
        };
        if matches!(parent.kind(), "call_expression" | "call")
            && parent.child_by_field_name("function") == Some(node)
        {
            return true;
        }
        if self.language == LanguageFamily::Java
            && parent.kind() == "method_invocation"
            && parent.child_by_field_name("name") == Some(node)
        {
            return true;
        }
        if self.member_receiver(node).is_some()
            && matches!(
                parent.kind(),
                "member_expression"
                    | "attribute"
                    | "field_expression"
                    | "selector_expression"
                    | "field_access"
            )
        {
            return parent.parent().is_some_and(|call| {
                matches!(call.kind(), "call_expression" | "call")
                    && call.child_by_field_name("function") == Some(parent)
            });
        }
        false
    }

    fn usage_kind_for_node(&self, node: Node<'_>, member: bool) -> String {
        if self.node_is_call_target(node) {
            return if member {
                "member-call".to_string()
            } else {
                "call".to_string()
            };
        }
        if node.kind() == "type_identifier"
            || node
                .parent()
                .is_some_and(|parent| parent.kind().contains("type"))
        {
            return "type".to_string();
        }

        let mut current = node;
        while let Some(parent) = current.parent() {
            if matches!(
                parent.kind(),
                "assignment_expression" | "assignment" | "named_expression"
            ) && (field_contains(parent, "left", node) || field_contains(parent, "name", node))
            {
                return if member {
                    "member-write".to_string()
                } else {
                    "write".to_string()
                };
            }
            if matches!(
                parent.kind(),
                "augmented_assignment_expression" | "augmented_assignment" | "update_expression"
            ) && (field_contains(parent, "left", node)
                || field_contains(parent, "argument", node))
            {
                return if member {
                    "member-read-write".to_string()
                } else {
                    "read-write".to_string()
                };
            }
            if matches!(parent.kind(), "for_statement" | "for_in_clause")
                && field_contains(parent, "left", node)
            {
                return "write".to_string();
            }
            if matches!(
                parent.kind(),
                "statement_block" | "block" | "program" | "module"
            ) {
                break;
            }
            current = parent;
        }
        if member {
            "member-read".to_string()
        } else {
            "read".to_string()
        }
    }

    fn caller_for_scope(&self, mut scope_id: usize) -> (Option<String>, Option<String>) {
        loop {
            let scope = &self.scopes[scope_id];
            if scope.kind == ScopeKind::Function && scope.owner_name.is_some() {
                return (scope.owner_name.clone(), scope.owner_kind.clone());
            }
            let Some(parent) = scope.parent else {
                return (None, None);
            };
            scope_id = parent;
        }
    }

    fn add_reference_for_node(&mut self, node: Node<'_>) {
        let name = normalize_identifier(node_text(node, self.source));
        if name.is_empty() {
            return;
        }
        let receiver = self.member_receiver(node);
        let member = receiver.is_some();
        let kind = self.usage_kind_for_node(node, member);
        let start = node.start_byte();
        let end = node.end_byte();
        let scope_id = self.scope_at(start);
        let (caller_name, caller_kind) = self.caller_for_scope(scope_id);
        let (line, column) = location(self.source, start);
        self.references.push(SemanticReference {
            name,
            kind,
            path: self.path.to_string_lossy().into_owned(),
            relative: relative_path(self.root, self.path),
            line,
            column,
            text: line_text(self.source, start),
            start,
            end,
            scope_id,
            resolved_symbol_id: None,
            receiver,
            caller_name,
            caller_kind,
            approximate: member || !self.language.supports_precise_binding(),
        });
    }

    fn resolve_name_in_scope(
        &self,
        mut scope_id: usize,
        name: &str,
        position: usize,
    ) -> Option<&SemanticDefinition> {
        loop {
            let mut candidates = self
                .definitions
                .iter()
                .filter(|definition| definition.scope_id == scope_id && definition.name == name)
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                candidates.sort_by_key(|definition| definition.start);
                if self.language == LanguageFamily::JavaScript {
                    return candidates
                        .iter()
                        .rev()
                        .find(|definition| definition.start <= position)
                        .copied()
                        .or_else(|| candidates.first().copied());
                }
                return candidates.first().copied();
            }
            let parent = self.scopes[scope_id].parent?;
            scope_id = parent;
        }
    }

    fn resolve_member_reference(
        &self,
        reference: &SemanticReference,
    ) -> Option<&SemanticDefinition> {
        let receiver = reference.receiver.as_deref()?;
        let inferred_type = if matches!(receiver, "this" | "self" | "cls") {
            self.class_owner_for_scope(reference.scope_id)
        } else {
            self.resolve_name_in_scope(reference.scope_id, receiver, reference.start)
                .and_then(|definition| definition.inferred_type.clone())
        }?;
        self.definitions.iter().find(|definition| {
            definition.name == reference.name
                && definition.owner_type.as_deref() == Some(inferred_type.as_str())
                && matches!(definition.kind.as_str(), "method" | "field")
        })
    }

    fn bind_lexical_references(&mut self) {
        let resolutions = self
            .references
            .iter()
            .map(|reference| {
                if reference.receiver.is_some() {
                    self.resolve_member_reference(reference)
                } else {
                    self.resolve_name_in_scope(reference.scope_id, &reference.name, reference.start)
                }
                .map(|definition| definition.symbol_id.clone())
            })
            .collect::<Vec<_>>();
        for (reference, resolved) in self.references.iter_mut().zip(resolutions) {
            if resolved.is_some() {
                reference.resolved_symbol_id = resolved;
                reference.approximate = false;
            }
        }
    }
}

fn parse_semantic_source(
    root: &Path,
    path: &Path,
    source: &[u8],
) -> Result<Option<SemanticFile>, String> {
    let Some((family, language)) = language_for_path(path) else {
        return Ok(None);
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| format!("{} grammar: {error}", path.display()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| format!("无法解析 {}", path.display()))?;
    let root_node = tree.root_node();
    let mut builder = SemanticBuilder::new(root, path, source, family);
    builder.walk_definitions(root_node, 0, None, false);
    builder.walk_references(root_node);
    Ok(Some(builder.finish()))
}

fn load_javascript_module_config(root: &Path) -> Option<JavascriptModuleConfig> {
    for name in ["tsconfig.json", "jsconfig.json"] {
        let path = root.join(name);
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = json5::from_str::<serde_json::Value>(&source) else {
            continue;
        };
        let Some(compiler_options) = value.get("compilerOptions") else {
            continue;
        };
        let config_dir = path.parent().unwrap_or(root).to_path_buf();
        let base_url = compiler_options
            .get("baseUrl")
            .and_then(serde_json::Value::as_str)
            .map_or_else(|| config_dir.clone(), |base_url| config_dir.join(base_url));
        let paths = compiler_options
            .get("paths")
            .and_then(serde_json::Value::as_object)
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|(pattern, targets)| {
                        let targets = targets
                            .as_array()?
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        (!targets.is_empty()).then(|| JavascriptPathMapping {
                            pattern: pattern.clone(),
                            targets,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return Some(JavascriptModuleConfig { base_url, paths });
    }
    None
}

fn load_go_module(root: &Path) -> Option<String> {
    let source = fs::read_to_string(root.join("go.mod")).ok()?;
    source.lines().find_map(|line| {
        line.trim()
            .strip_prefix("module ")
            .map(str::trim)
            .filter(|module| !module.is_empty())
            .map(str::to_string)
    })
}

fn load_workspace_module_config(root: &Path) -> WorkspaceModuleConfig {
    WorkspaceModuleConfig {
        javascript: load_javascript_module_config(root),
        go_module: load_go_module(root),
    }
}

impl WorkspaceSemanticIndex {
    fn new(root: PathBuf) -> Self {
        Self {
            module_config: load_workspace_module_config(&root),
            root,
            ..Self::default()
        }
    }

    fn insert_file_without_alias_rebuild(&mut self, file: Arc<SemanticFile>) {
        let key = path_key(&file.path);
        for definition in &file.definitions {
            self.definitions_by_name
                .entry(definition.name.to_lowercase())
                .or_default()
                .push(Arc::clone(definition));
            self.symbols_by_id
                .insert(definition.symbol_id.clone(), Arc::clone(definition));
        }
        for reference in &file.references {
            self.references_by_name
                .entry(reference.name.to_lowercase())
                .or_default()
                .push(Arc::clone(reference));
        }
        self.files.insert(key, file);
        self.files_indexed = self.files.len();
    }

    fn remove_file_without_alias_rebuild(&mut self, path: &Path) {
        let key = path_key(path);
        let Some(file) = self.files.remove(&key) else {
            return;
        };
        for definition in &file.definitions {
            let name_key = definition.name.to_lowercase();
            if let Some(definitions) = self.definitions_by_name.get_mut(&name_key) {
                definitions.retain(|candidate| candidate.path != definition.path);
                if definitions.is_empty() {
                    self.definitions_by_name.remove(&name_key);
                }
            }
            self.symbols_by_id.remove(&definition.symbol_id);
        }
        for reference in &file.references {
            let name_key = reference.name.to_lowercase();
            if let Some(references) = self.references_by_name.get_mut(&name_key) {
                references.retain(|candidate| candidate.path != reference.path);
                if references.is_empty() {
                    self.references_by_name.remove(&name_key);
                }
            }
        }
        self.files_indexed = self.files.len();
    }

    fn replace_file(&mut self, file: Arc<SemanticFile>) {
        self.remove_file_without_alias_rebuild(&file.path);
        self.insert_file_without_alias_rebuild(file);
        self.rebuild_aliases();
    }

    fn rebuild_maps(&mut self) {
        self.module_config = load_workspace_module_config(&self.root);
        let files = self.files.values().cloned().collect::<Vec<_>>();
        self.definitions_by_name.clear();
        self.references_by_name.clear();
        self.symbols_by_id.clear();
        self.aliases.clear();
        self.files.clear();
        for file in files {
            self.insert_file_without_alias_rebuild(file);
        }
        self.rebuild_aliases();
    }

    fn rebuild_aliases(&mut self) {
        self.aliases.clear();
        let imports = self
            .symbols_by_id
            .values()
            .filter_map(|definition| {
                definition
                    .import
                    .as_ref()
                    .map(|binding| (definition.clone(), binding.clone()))
            })
            .collect::<Vec<_>>();
        for (definition, binding) in imports {
            if binding.namespace {
                continue;
            }
            let target = self.resolve_exported_definition(
                Path::new(&definition.path),
                &binding.module,
                &binding.imported_name,
            );
            if let Some(target) = target {
                self.aliases
                    .insert(definition.symbol_id.clone(), target.symbol_id.clone());
            }
        }
    }

    fn canonical_symbol_id(&self, symbol_id: &str) -> String {
        let mut current = symbol_id.to_string();
        let mut seen = HashSet::new();
        while seen.insert(current.clone()) {
            let Some(next) = self.aliases.get(&current) else {
                break;
            };
            current.clone_from(next);
        }
        current
    }

    fn matching_file_keys(&self, candidates: Vec<PathBuf>) -> Vec<String> {
        let mut seen = HashSet::new();
        candidates
            .into_iter()
            .map(|candidate| path_key(&candidate))
            .filter(|candidate| self.files.contains_key(candidate))
            .filter(|candidate| seen.insert(candidate.clone()))
            .collect()
    }

    fn unique_suffix_file_keys(&self, suffixes: &[String]) -> Vec<String> {
        let matches = self
            .files
            .keys()
            .filter(|candidate| suffixes.iter().any(|suffix| candidate.ends_with(suffix)))
            .cloned()
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            matches
        } else {
            Vec::new()
        }
    }

    fn javascript_module_candidates(&self, source_path: &Path, module: &str) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if module.starts_with('.') {
            let base = normalize_lexical(
                &source_path
                    .parent()
                    .unwrap_or(source_path)
                    .join(module.replace('/', std::path::MAIN_SEPARATOR_STR)),
            );
            push_javascript_module_candidates(&mut candidates, &base);
            return candidates;
        }
        let Some(config) = &self.module_config.javascript else {
            return candidates;
        };
        for mapping in &config.paths {
            let capture = if let Some((prefix, suffix)) = mapping.pattern.split_once('*') {
                module
                    .strip_prefix(prefix)
                    .and_then(|rest| rest.strip_suffix(suffix))
            } else {
                (mapping.pattern == module).then_some("")
            };
            let Some(capture) = capture else {
                continue;
            };
            for target in &mapping.targets {
                let target = target.replace('*', capture);
                let base = normalize_lexical(&config.base_url.join(target));
                push_javascript_module_candidates(&mut candidates, &base);
            }
        }
        let base = normalize_lexical(&config.base_url.join(module));
        push_javascript_module_candidates(&mut candidates, &base);
        candidates
    }

    fn resolve_module_keys(&self, source_path: &Path, module: &str) -> Vec<String> {
        let Some((source_family, _)) = language_for_path(source_path) else {
            return Vec::new();
        };
        match source_family {
            LanguageFamily::JavaScript => {
                self.matching_file_keys(self.javascript_module_candidates(source_path, module))
            }
            LanguageFamily::Python => {
                let absolute = !module.starts_with('.');
                let mut base = if absolute {
                    self.root.clone()
                } else {
                    let dots = module
                        .chars()
                        .take_while(|character| *character == '.')
                        .count();
                    let mut parent = source_path.parent().unwrap_or(source_path).to_path_buf();
                    for _ in 1..dots {
                        parent = parent.parent().unwrap_or(&parent).to_path_buf();
                    }
                    parent
                };
                let remainder = module.trim_start_matches('.');
                if !remainder.is_empty() {
                    for part in remainder.split('.') {
                        base.push(part);
                    }
                }
                let direct = self
                    .matching_file_keys(vec![base.with_extension("py"), base.join("__init__.py")]);
                if !direct.is_empty() || !absolute {
                    return direct;
                }
                let module_path = module.replace('.', "/").to_lowercase();
                self.unique_suffix_file_keys(&[
                    format!("/{module_path}.py"),
                    format!("/{module_path}/__init__.py"),
                ])
            }
            LanguageFamily::Java => {
                let module_path = module.replace('.', "/").to_lowercase();
                let direct = self.matching_file_keys(vec![self
                    .root
                    .join(module.replace('.', "/"))
                    .with_extension("java")]);
                if !direct.is_empty() {
                    direct
                } else {
                    self.unique_suffix_file_keys(&[format!("/{module_path}.java")])
                }
            }
            LanguageFamily::Rust => {
                let mut parts = module
                    .split("::")
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>();
                let src_root = source_path
                    .ancestors()
                    .find(|path| path.file_name().is_some_and(|name| name == "src"))
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| self.root.clone());
                let mut base = if parts.first().is_some_and(|part| *part == "self") {
                    parts.remove(0);
                    source_path.parent().unwrap_or(source_path).to_path_buf()
                } else if parts.first().is_some_and(|part| *part == "super") {
                    let mut parent = source_path.parent().unwrap_or(source_path).to_path_buf();
                    while parts.first().is_some_and(|part| *part == "super") {
                        parts.remove(0);
                        parent = parent.parent().unwrap_or(&parent).to_path_buf();
                    }
                    parent
                } else {
                    if parts.first().is_some_and(|part| *part == "crate") {
                        parts.remove(0);
                    }
                    src_root
                };
                for part in parts {
                    base.push(part);
                }
                let candidates = vec![
                    base.with_extension("rs"),
                    base.join("mod.rs"),
                    base.join("lib.rs"),
                    base.join("main.rs"),
                ];
                let direct = self.matching_file_keys(candidates);
                if !direct.is_empty() {
                    direct
                } else {
                    let module_path = module
                        .trim_start_matches("crate::")
                        .trim_start_matches("self::")
                        .replace("::", "/")
                        .to_lowercase();
                    self.unique_suffix_file_keys(&[
                        format!("/{module_path}.rs"),
                        format!("/{module_path}/mod.rs"),
                    ])
                }
            }
            LanguageFamily::Go => {
                let relative = self
                    .module_config
                    .go_module
                    .as_deref()
                    .and_then(|prefix| module.strip_prefix(prefix))
                    .map(|path| path.trim_start_matches('/'))
                    .unwrap_or(module);
                let direct_dir_key = path_key(&normalize_lexical(&self.root.join(relative)));
                let mut direct = self
                    .files
                    .iter()
                    .filter(|(_, file)| {
                        file.path
                            .parent()
                            .is_some_and(|parent| path_key(parent) == direct_dir_key)
                    })
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>();
                if !direct.is_empty() {
                    direct.sort();
                    return direct;
                }
                let suffix = format!("/{}", relative.replace('\\', "/").to_lowercase());
                let directories = self
                    .files
                    .values()
                    .filter_map(|file| file.path.parent())
                    .map(path_key)
                    .filter(|directory| directory.ends_with(&suffix))
                    .collect::<HashSet<_>>();
                if directories.len() != 1 {
                    return Vec::new();
                }
                let directory = directories.into_iter().next().unwrap_or_default();
                let mut matches = self
                    .files
                    .iter()
                    .filter(|(_, file)| {
                        file.path
                            .parent()
                            .is_some_and(|parent| path_key(parent) == directory)
                    })
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>();
                matches.sort();
                matches
            }
        }
    }

    fn exported_definition_in_keys(
        &self,
        module_keys: &[String],
        imported_name: &str,
        visited: &mut HashSet<String>,
        allow_members: bool,
    ) -> Option<Arc<SemanticDefinition>> {
        for module_key in module_keys {
            let visit_key = format!("{module_key}:{}", imported_name.to_lowercase());
            if !visited.insert(visit_key) {
                continue;
            }
            let target = if imported_name == "default" {
                self.symbols_by_id.values().find(|candidate| {
                    path_key(Path::new(&candidate.path)) == *module_key && candidate.default_export
                })
            } else {
                self.definitions_by_name
                    .get(&imported_name.to_lowercase())
                    .and_then(|definitions| {
                        definitions.iter().find(|candidate| {
                            path_key(Path::new(&candidate.path)) == *module_key
                                && (candidate.exported
                                    || candidate.scope_id == 0
                                    || candidate.kind == "class"
                                    || (allow_members
                                        && matches!(
                                            candidate.kind.as_str(),
                                            "method" | "field" | "constant"
                                        )))
                        })
                    })
            };
            if let Some(target) = target {
                return Some(Arc::clone(target));
            }
            let Some(file) = self.files.get(module_key) else {
                continue;
            };
            for re_export in &file.re_exports {
                let re_export_keys = self.resolve_module_keys(&file.path, re_export);
                if let Some(target) = self.exported_definition_in_keys(
                    &re_export_keys,
                    imported_name,
                    visited,
                    allow_members,
                ) {
                    return Some(target);
                }
            }
        }
        None
    }

    fn resolve_exported_definition(
        &self,
        source_path: &Path,
        module: &str,
        imported_name: &str,
    ) -> Option<Arc<SemanticDefinition>> {
        let module_keys = self.resolve_module_keys(source_path, module);
        let allow_members = language_for_path(source_path)
            .is_some_and(|(family, _)| family == LanguageFamily::Java);
        self.exported_definition_in_keys(
            &module_keys,
            imported_name,
            &mut HashSet::new(),
            allow_members,
        )
    }

    fn namespace_target(&self, reference: &SemanticReference) -> Option<Arc<SemanticDefinition>> {
        let receiver = reference.receiver.as_deref()?;
        let file = self.files.get(&path_key(Path::new(&reference.path)))?;
        let import = file
            .definitions
            .iter()
            .find(|definition| definition.name == receiver && definition.import.is_some())?;
        let binding = import.import.as_ref()?;

        if !binding.namespace {
            let canonical = self.canonical_symbol_id(&import.symbol_id);
            if let Some(target_type) = self.symbols_by_id.get(&canonical) {
                if matches!(
                    target_type.kind.as_str(),
                    "class" | "interface" | "enum" | "type"
                ) {
                    if let Some(member) = self
                        .definitions_by_name
                        .get(&reference.name.to_lowercase())
                        .and_then(|definitions| {
                            definitions.iter().find(|definition| {
                                definition.owner_type.as_deref() == Some(target_type.name.as_str())
                                    && definition.path == target_type.path
                            })
                        })
                    {
                        return Some(Arc::clone(member));
                    }
                }
            }
        }

        let mut modules = vec![binding.module.clone()];
        if !binding.namespace && binding.imported_name != "*" {
            let separator = match language_for_path(Path::new(&reference.path))?.0 {
                LanguageFamily::JavaScript | LanguageFamily::Go => "/",
                LanguageFamily::Python | LanguageFamily::Java => ".",
                LanguageFamily::Rust => "::",
            };
            modules.insert(
                0,
                format!("{}{separator}{}", binding.module, binding.imported_name),
            );
        }
        for module in modules {
            let module_keys = self.resolve_module_keys(Path::new(&reference.path), &module);
            if let Some(target) = self.exported_definition_in_keys(
                &module_keys,
                &reference.name,
                &mut HashSet::new(),
                language_for_path(Path::new(&reference.path))
                    .is_some_and(|(family, _)| family == LanguageFamily::Java),
            ) {
                return Some(target);
            }
        }
        None
    }

    fn inferred_member_target(
        &self,
        reference: &SemanticReference,
    ) -> Option<Arc<SemanticDefinition>> {
        let receiver = reference.receiver.as_deref()?;
        let source_path = path_key(Path::new(&reference.path));
        let file = self.files.get(&source_path)?;
        let receiver_symbol = file
            .references
            .iter()
            .filter(|candidate| {
                candidate.name == receiver
                    && candidate.start <= reference.start
                    && candidate.resolved_symbol_id.is_some()
            })
            .max_by_key(|candidate| candidate.start)?
            .resolved_symbol_id
            .as_deref()?;
        let receiver_definition = self.symbols_by_id.get(receiver_symbol)?;
        let inferred_type = receiver_definition.inferred_type.as_deref()?;
        let type_binding = file
            .definitions
            .iter()
            .filter(|definition| {
                definition.name == inferred_type
                    && matches!(definition.kind.as_str(), "class" | "import")
            })
            .max_by_key(|definition| definition.start)?;
        let canonical_type = self.canonical_symbol_id(&type_binding.symbol_id);
        let target_type = self.symbols_by_id.get(&canonical_type)?;
        if target_type.kind != "class" {
            return None;
        }
        self.definitions_by_name
            .get(&reference.name.to_lowercase())?
            .iter()
            .find(|definition| {
                definition.owner_type.as_deref() == Some(target_type.name.as_str())
                    && definition.path == target_type.path
                    && matches!(definition.kind.as_str(), "method" | "field")
            })
            .cloned()
    }

    fn resolved_reference_symbol(&self, reference: &SemanticReference) -> Option<String> {
        if let Some(symbol_id) = &reference.resolved_symbol_id {
            return Some(self.canonical_symbol_id(symbol_id));
        }
        self.namespace_target(reference)
            .or_else(|| self.inferred_member_target(reference))
            .map(|definition| definition.symbol_id.clone())
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}

fn push_javascript_module_candidates(output: &mut Vec<PathBuf>, base: &Path) {
    if base.extension().is_some() {
        output.push(base.to_path_buf());
        return;
    }
    for extension in ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] {
        output.push(base.with_extension(extension));
    }
    for extension in ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] {
        output.push(base.join(format!("index.{extension}")));
    }
}

impl SemanticNavigationState {
    fn cached_any(&self, root: &Path, path: &Path) -> Option<Arc<SemanticFile>> {
        self.inner
            .read()
            .ok()?
            .cache
            .get(&file_cache_key(root, path))
            .map(|entry| entry.semantics.clone())
    }

    fn load_disk_file(
        &self,
        root: &Path,
        path: &Path,
    ) -> Result<Option<Arc<SemanticFile>>, String> {
        if let Some(overlay) = self.inner.read().ok().and_then(|inner| {
            inner
                .cache
                .get(&file_cache_key(root, path))
                .filter(|entry| entry.overlay_revision.is_some())
                .map(|entry| entry.semantics.clone())
        }) {
            return Ok(Some(overlay));
        }
        let metadata = fs::metadata(path)
            .map_err(|error| format!("读取 {} 元数据失败: {error}", path.display()))?;
        if metadata.len() > MAX_INDEX_FILE_BYTES {
            return Ok(None);
        }
        let modified = metadata.modified().ok();
        if let Some(cached) = self.cached_disk(root, path, modified, metadata.len()) {
            return Ok(Some(cached));
        }
        let source =
            fs::read(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
        let Some(file) = parse_semantic_source(root, path, &source)? else {
            return Ok(None);
        };
        let file = Arc::new(file);
        self.cache_file(
            root,
            path,
            CachedSemanticFile {
                modified,
                len: metadata.len(),
                overlay_revision: None,
                content_fingerprint: None,
                semantics: file.clone(),
            },
        );
        Ok(Some(file))
    }

    fn update_overlay_internal(
        &self,
        root: &Path,
        path: &Path,
        content: &str,
        revision: u64,
    ) -> Result<Option<Arc<SemanticFile>>, String> {
        if content.len() as u64 > MAX_OPEN_FILE_BYTES {
            return Ok(None);
        }
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let content_fingerprint = hasher.finish();
        let cache_key = file_cache_key(root, path);
        if let Ok(mut inner) = self.inner.write() {
            if let Some(cached) = inner.cache.get_mut(&cache_key) {
                if cached
                    .overlay_revision
                    .is_some_and(|current| current > revision)
                {
                    return Ok(Some(cached.semantics.clone()));
                }
                if cached.overlay_revision.is_some()
                    && cached.len == content.len() as u64
                    && cached.content_fingerprint == Some(content_fingerprint)
                {
                    cached.overlay_revision = Some(revision);
                    return Ok(Some(cached.semantics.clone()));
                }
            }
        }
        let Some(file) = parse_semantic_source(root, path, content.as_bytes())? else {
            return Ok(None);
        };
        let file = Arc::new(file);
        let root_key = path_key(root);
        if let Ok(mut inner) = self.inner.write() {
            if let Some(cached) = inner.cache.get(&cache_key) {
                if cached
                    .overlay_revision
                    .is_some_and(|current| current > revision)
                {
                    return Ok(Some(cached.semantics.clone()));
                }
            }
            if inner.cache.len() >= MAX_CACHED_FILES {
                inner.cache.clear();
            }
            inner.cache.insert(
                cache_key,
                CachedSemanticFile {
                    modified: None,
                    len: content.len() as u64,
                    overlay_revision: Some(revision),
                    content_fingerprint: Some(content_fingerprint),
                    semantics: file.clone(),
                },
            );
            let workspace = inner
                .workspaces
                .entry(root_key)
                .or_insert_with(|| WorkspaceSemanticIndex::new(root.to_path_buf()));
            workspace.replace_file(file.clone());
        }
        Ok(Some(file))
    }

    fn ensure_file(
        &self,
        root: &Path,
        path: &Path,
        content: Option<&str>,
        revision: Option<u64>,
    ) -> Result<Option<Arc<SemanticFile>>, String> {
        let file = if let Some(content) = content {
            self.update_overlay_internal(root, path, content, revision.unwrap_or(0))?
        } else if let Some(cached) = self.cached_any(root, path) {
            Some(cached)
        } else {
            self.load_disk_file(root, path)?
        };
        let Some(file) = file else {
            return Ok(None);
        };
        let root_key = path_key(root);
        if let Ok(mut inner) = self.inner.write() {
            let workspace = inner
                .workspaces
                .entry(root_key)
                .or_insert_with(|| WorkspaceSemanticIndex::new(root.to_path_buf()));
            if !workspace.files.contains_key(&path_key(path)) {
                workspace.replace_file(file.clone());
            }
        }
        Ok(Some(file))
    }

    fn workspace_roots_for_path(&self, path: &Path) -> Vec<PathBuf> {
        let path = path_key(path);
        self.inner
            .read()
            .map(|inner| {
                inner
                    .workspaces
                    .values()
                    .filter(|workspace| {
                        let root = path_key(&workspace.root);
                        path == root || path.starts_with(&format!("{root}/"))
                    })
                    .map(|workspace| workspace.root.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn refresh_path_from_disk(&self, path: &Path) -> Result<(), String> {
        let roots = self.workspace_roots_for_path(path);
        for root in &roots {
            self.cancel_root_index(root);
        }
        self.invalidate_path(path);
        if !path.is_file() || language_for_path(path).is_none() {
            return Ok(());
        }
        for root in roots {
            let Some(file) = self.load_disk_file(&root, path)? else {
                continue;
            };
            if let Ok(mut inner) = self.inner.write() {
                let workspace = inner
                    .workspaces
                    .entry(path_key(&root))
                    .or_insert_with(|| WorkspaceSemanticIndex::new(root.clone()));
                workspace.replace_file(file);
            }
        }
        Ok(())
    }

    fn replace_workspace(&self, key: String, mut workspace: WorkspaceSemanticIndex) {
        if let Ok(mut inner) = self.inner.write() {
            let prefix = format!("{key}|");
            let overlays = inner
                .cache
                .iter()
                .filter(|(cache_key, entry)| {
                    cache_key.starts_with(&prefix) && entry.overlay_revision.is_some()
                })
                .map(|(_, entry)| entry.semantics.clone())
                .collect::<Vec<_>>();
            for overlay in overlays {
                workspace.replace_file(overlay);
            }
            inner.workspaces.insert(key, workspace);
        }
    }
}

fn build_workspace_index(
    state: &SemanticNavigationState,
    root: &Path,
    max_files: usize,
    generation: &AtomicU64,
    expected_generation: u64,
) -> Result<WorkspaceSemanticIndex, String> {
    if !root.is_dir() {
        return Err(format!("项目目录不存在: {}", root.display()));
    }
    let files = Mutex::new(Vec::<Arc<SemanticFile>>::new());
    let files_scanned = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let should_quit = AtomicBool::new(false);
    let max_files = max_files.clamp(1, 50_000);

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .threads(
            std::thread::available_parallelism()
                .map(|count| count.get().clamp(2, 8))
                .unwrap_or(4),
        )
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git"
                    | ".venv"
                    | "venv"
                    | "env"
                    | ".tox"
                    | ".mypy_cache"
                    | ".pytest_cache"
                    | "__pycache__"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | "public"
                    | ".next"
                    | "coverage"
                    | "vendor"
                    | ".pnpm"
                    | "out"
                    | ".turbo"
                    | ".cache"
            )
        });
    builder.add_custom_ignore_filename(".gitignore");

    builder.build_parallel().run(|| {
        let files = &files;
        let files_scanned = &files_scanned;
        let truncated = &truncated;
        let should_quit = &should_quit;
        Box::new(move |entry| {
            if should_quit.load(Ordering::Relaxed)
                || generation.load(Ordering::Relaxed) != expected_generation
            {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let path = entry.path();
            if !entry.file_type().is_some_and(|kind| kind.is_file())
                || language_for_path(path).is_none()
            {
                return WalkState::Continue;
            }
            let scanned = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
            if scanned > max_files {
                truncated.store(true, Ordering::Relaxed);
                should_quit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(Some(file)) = state.load_disk_file(root, path) else {
                return WalkState::Continue;
            };
            if let Ok(mut output) = files.lock() {
                output.push(file);
            }
            WalkState::Continue
        })
    });

    let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
    for file in files.into_inner().unwrap_or_default() {
        workspace.insert_file_without_alias_rebuild(file);
    }
    workspace.rebuild_aliases();
    workspace.files_indexed = files_scanned.load(Ordering::Relaxed).min(max_files);
    workspace.truncated = truncated.load(Ordering::Relaxed);
    workspace.complete =
        !workspace.truncated && generation.load(Ordering::Relaxed) == expected_generation;
    Ok(workspace)
}

fn definition_candidate(
    definition: &SemanticDefinition,
    confidence: &str,
    approximate: bool,
) -> SemanticCandidate {
    SemanticCandidate {
        symbol_id: definition.symbol_id.clone(),
        name: definition.name.clone(),
        kind: definition.kind.clone(),
        path: definition.path.clone(),
        relative: definition.relative.clone(),
        line: definition.line,
        column: definition.column,
        text: definition.text.clone(),
        confidence: confidence.to_string(),
        approximate,
        usage_kind: None,
        caller_name: None,
        caller_kind: None,
    }
}

fn reference_candidate(
    reference: &SemanticReference,
    symbol_id: String,
    approximate: bool,
) -> SemanticCandidate {
    SemanticCandidate {
        symbol_id,
        name: reference.name.clone(),
        kind: reference.kind.clone(),
        path: reference.path.clone(),
        relative: reference.relative.clone(),
        line: reference.line,
        column: reference.column,
        text: reference.text.clone(),
        confidence: if approximate {
            "approximate".to_string()
        } else {
            "bound".to_string()
        },
        approximate,
        usage_kind: Some(reference.kind.clone()),
        caller_name: reference.caller_name.clone(),
        caller_kind: reference.caller_kind.clone(),
    }
}

fn with_workspace<R>(
    state: &SemanticNavigationState,
    root: &Path,
    query: impl FnOnce(&WorkspaceSemanticIndex) -> R,
) -> Option<R> {
    let inner = state.inner.read().ok()?;
    inner.workspaces.get(&path_key(root)).map(query)
}

#[tauri::command]
pub async fn prepare_semantic_index(
    root: String,
    max_files: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<SemanticIndexStatus, String> {
    allowlist.ensure_allowed(&root)?;
    let root_path = PathBuf::from(&root);
    let state = state.inner().clone();
    let max_files = max_files.unwrap_or(DEFAULT_MAX_FILES);
    let mut last_status = SemanticIndexStatus {
        root: root.clone(),
        files_indexed: 0,
        complete: false,
        truncated: false,
    };
    for _ in 0..3 {
        let (root_key, generation, expected_generation) = state.begin_root_index(&root_path);
        state.ensure_workspace_root(&root_path);
        let build_state = state.clone();
        let build_root = root_path.clone();
        let build_generation = generation.clone();
        let workspace = tauri::async_runtime::spawn_blocking(move || {
            build_workspace_index(
                &build_state,
                &build_root,
                max_files,
                &build_generation,
                expected_generation,
            )
        })
        .await
        .map_err(|error| format!("语义索引任务失败: {error}"))??;
        last_status = SemanticIndexStatus {
            root: root.clone(),
            files_indexed: workspace.files_indexed,
            complete: workspace.complete,
            truncated: workspace.truncated,
        };
        if generation.load(Ordering::SeqCst) == expected_generation {
            state.replace_workspace(root_key, workspace);
            return Ok(last_status);
        }
    }
    Ok(last_status)
}

#[tauri::command]
pub async fn update_semantic_overlay(
    root: String,
    path: String,
    content: String,
    revision: Option<u64>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<bool, String> {
    allowlist.ensure_allowed(&root)?;
    allowlist.ensure_allowed(&path)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .update_overlay_internal(
                Path::new(&root),
                Path::new(&path),
                &content,
                revision.unwrap_or(0),
            )
            .map(|file| file.is_some())
    })
    .await
    .map_err(|error| format!("更新未保存语义覆盖层失败: {error}"))?
}

#[tauri::command]
pub async fn clear_semantic_overlay(
    path: String,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<(), String> {
    allowlist.ensure_allowed(&path)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.refresh_path_from_disk(Path::new(&path)))
        .await
        .map_err(|error| format!("清除未保存语义覆盖层失败: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn resolve_symbol_at(
    root: String,
    path: String,
    position: usize,
    content: Option<String>,
    revision: Option<u64>,
    max_results: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<ResolveSymbolResponse, String> {
    allowlist.ensure_allowed(&root)?;
    allowlist.ensure_allowed(&path)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&root);
        let source_path = PathBuf::from(&path);
        let Some(file) =
            state.ensure_file(&root_path, &source_path, content.as_deref(), revision)?
        else {
            return Ok(ResolveSymbolResponse {
                symbol_id: None,
                name: None,
                kind: None,
                definitions: Vec::new(),
                files_indexed: 0,
                complete: false,
                truncated: false,
            });
        };
        Ok(with_workspace(&state, &root_path, |workspace| {
            let resolved = resolve_query(
                workspace,
                &file,
                &source_path,
                position,
                max_results
                    .unwrap_or(DEFAULT_MAX_RESULTS)
                    .clamp(1, HARD_MAX_RESULTS),
            );
            ResolveSymbolResponse {
                symbol_id: resolved.symbol_id,
                name: resolved.name,
                kind: resolved.kind,
                definitions: resolved.definitions,
                files_indexed: workspace.files_indexed,
                complete: workspace.complete,
                truncated: workspace.truncated,
            }
        })
        .unwrap_or(ResolveSymbolResponse {
            symbol_id: None,
            name: None,
            kind: None,
            definitions: Vec::new(),
            files_indexed: 0,
            complete: false,
            truncated: false,
        }))
    })
    .await
    .map_err(|error| format!("解析光标符号失败: {error}"))?
}

#[cfg(test)]
fn collect_symbol_usages(
    workspace: &WorkspaceSemanticIndex,
    name: &str,
    selected_symbol: Option<&str>,
    selected_kind: &str,
    max_results: usize,
) -> (Vec<SemanticCandidate>, usize) {
    collect_symbol_usage_page(
        workspace,
        name,
        selected_symbol,
        selected_kind,
        0,
        max_results,
        None,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn collect_symbol_usage_page(
    workspace: &WorkspaceSemanticIndex,
    name: &str,
    selected_symbol: Option<&str>,
    selected_kind: &str,
    offset: usize,
    max_results: usize,
    usage_kinds: Option<&HashSet<String>>,
    approximate_only: bool,
) -> (Vec<SemanticCandidate>, usize) {
    let mut precise = Vec::new();
    let mut approximate = Vec::new();
    let mut seen = HashSet::new();
    let mut lookup_names = HashSet::from([name.to_lowercase()]);

    if let Some(selected_symbol) = selected_symbol {
        // Declaration site counts as a usage (IDEA/VS Code style), so a
        // symbol with no call sites still surfaces itself instead of "none".
        if let Some(definition) = workspace
            .symbols_by_id
            .get(selected_symbol)
            .filter(|definition| definition.kind != "import")
        {
            let key = format!(
                "{}:{}:{}:definition",
                definition.path, definition.line, definition.column
            );
            if seen.insert(key) {
                let mut candidate = definition_candidate(definition, "bound", false);
                candidate.usage_kind = Some("definition".to_string());
                precise.push(candidate);
            }
        }
        for definition in workspace.symbols_by_id.values() {
            if definition.kind != "import"
                || workspace.canonical_symbol_id(&definition.symbol_id) != selected_symbol
            {
                continue;
            }
            lookup_names.insert(definition.name.to_lowercase());
            let key = format!(
                "{}:{}:{}:import",
                definition.path, definition.line, definition.column
            );
            if seen.insert(key) {
                let mut candidate = definition_candidate(definition, "bound", false);
                candidate.kind = "import".to_string();
                candidate.usage_kind = Some("import".to_string());
                precise.push(candidate);
            }
        }
    }

    for lookup_name in lookup_names {
        if let Some(references) = workspace.references_by_name.get(&lookup_name) {
            for reference in references {
                let resolved_reference = workspace.resolved_reference_symbol(reference);
                let exact = selected_symbol
                    .is_some_and(|selected| resolved_reference.as_deref() == Some(selected));
                if exact {
                    let key = format!(
                        "{}:{}:{}:{}",
                        reference.path, reference.line, reference.column, reference.kind
                    );
                    if seen.insert(key) {
                        precise.push(reference_candidate(
                            reference,
                            selected_symbol.unwrap_or_default().to_string(),
                            false,
                        ));
                    }
                } else if resolved_reference.is_none()
                    && !matches!(
                        selected_kind,
                        "variable" | "parameter" | "import" | "constant"
                    )
                {
                    let key = format!(
                        "{}:{}:{}:{}",
                        reference.path, reference.line, reference.column, reference.kind
                    );
                    if seen.insert(key) {
                        approximate.push(reference_candidate(
                            reference,
                            selected_symbol.unwrap_or_default().to_string(),
                            true,
                        ));
                    }
                }
            }
        }
    }

    precise.sort_by(|left, right| {
        left.relative
            .cmp(&right.relative)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    approximate.sort_by(|left, right| {
        left.relative
            .cmp(&right.relative)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    precise.extend(approximate);
    precise.retain(|candidate| {
        if approximate_only && !candidate.approximate {
            return false;
        }
        usage_kinds.is_none_or(|kinds| {
            candidate
                .usage_kind
                .as_ref()
                .is_some_and(|kind| kinds.contains(kind))
        })
    });
    let total = precise.len();
    let page = precise.into_iter().skip(offset).take(max_results).collect();
    (page, total)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn find_symbol_usages_at(
    root: String,
    path: String,
    position: usize,
    content: Option<String>,
    revision: Option<u64>,
    offset: Option<usize>,
    max_results: Option<usize>,
    usage_kinds: Option<Vec<String>>,
    approximate_only: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<FindUsagesResponse, String> {
    allowlist.ensure_allowed(&root)?;
    allowlist.ensure_allowed(&path)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&root);
        let source_path = PathBuf::from(&path);
        let Some(file) =
            state.ensure_file(&root_path, &source_path, content.as_deref(), revision)?
        else {
            return Ok(FindUsagesResponse {
                symbol_id: None,
                name: None,
                kind: None,
                definition: None,
                usages: Vec::new(),
                total_count: 0,
                files_indexed: 0,
                complete: false,
                truncated: false,
            });
        };
        Ok(with_workspace(&state, &root_path, |workspace| {
            let resolved = resolve_query(workspace, &file, &source_path, position, 20);
            let Some(name) = resolved.name.clone() else {
                return FindUsagesResponse {
                    symbol_id: None,
                    name: None,
                    kind: None,
                    definition: None,
                    usages: Vec::new(),
                    total_count: 0,
                    files_indexed: workspace.files_indexed,
                    complete: workspace.complete,
                    truncated: workspace.truncated,
                };
            };
            let selected_symbol = resolved.symbol_id.clone();
            let selected_kind = resolved.kind.clone().unwrap_or_default();
            let max_results = max_results
                .unwrap_or(DEFAULT_MAX_RESULTS)
                .clamp(1, HARD_MAX_RESULTS);
            let offset = offset.unwrap_or(0);
            let usage_kinds = usage_kinds.map(|kinds| {
                kinds
                    .into_iter()
                    .map(|kind| kind.to_lowercase())
                    .collect::<HashSet<_>>()
            });
            let (usages, total_count) = collect_symbol_usage_page(
                workspace,
                &name,
                selected_symbol.as_deref(),
                &selected_kind,
                offset,
                max_results,
                usage_kinds.as_ref(),
                approximate_only.unwrap_or(false),
            );
            let definition = resolved.definitions.first().cloned();
            let truncated =
                workspace.truncated || offset.saturating_add(usages.len()) < total_count;
            FindUsagesResponse {
                symbol_id: resolved.symbol_id,
                name: Some(name),
                kind: resolved.kind,
                definition,
                usages,
                total_count,
                files_indexed: workspace.files_indexed,
                complete: workspace.complete,
                truncated,
            }
        })
        .unwrap_or(FindUsagesResponse {
            symbol_id: None,
            name: None,
            kind: None,
            definition: None,
            usages: Vec::new(),
            total_count: 0,
            files_indexed: 0,
            complete: false,
            truncated: false,
        }))
    })
    .await
    .map_err(|error| format!("查找符号用法失败: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn find_symbol_usages_by_id(
    root: String,
    symbol_id: String,
    offset: Option<usize>,
    max_results: Option<usize>,
    usage_kinds: Option<Vec<String>>,
    approximate_only: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<FindUsagesResponse, String> {
    allowlist.ensure_allowed(&root)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&root);
        Ok(with_workspace(&state, &root_path, |workspace| {
            let canonical_id = workspace.canonical_symbol_id(&symbol_id);
            let Some(definition) = workspace
                .symbols_by_id
                .get(&canonical_id)
                .or_else(|| workspace.symbols_by_id.get(&symbol_id))
            else {
                return FindUsagesResponse {
                    symbol_id: Some(canonical_id),
                    name: None,
                    kind: None,
                    definition: None,
                    usages: Vec::new(),
                    total_count: 0,
                    files_indexed: workspace.files_indexed,
                    complete: workspace.complete,
                    truncated: workspace.truncated,
                };
            };
            let max_results = max_results
                .unwrap_or(DEFAULT_MAX_RESULTS)
                .clamp(1, HARD_MAX_RESULTS);
            let offset = offset.unwrap_or(0);
            let usage_kinds = usage_kinds.map(|kinds| {
                kinds
                    .into_iter()
                    .map(|kind| kind.to_lowercase())
                    .collect::<HashSet<_>>()
            });
            let (usages, total_count) = collect_symbol_usage_page(
                workspace,
                &definition.name,
                Some(&canonical_id),
                &definition.kind,
                offset,
                max_results,
                usage_kinds.as_ref(),
                approximate_only.unwrap_or(false),
            );
            let truncated =
                workspace.truncated || offset.saturating_add(usages.len()) < total_count;
            FindUsagesResponse {
                symbol_id: Some(canonical_id),
                name: Some(definition.name.clone()),
                kind: Some(definition.kind.clone()),
                definition: Some(definition_candidate(definition, "bound", false)),
                usages,
                total_count,
                files_indexed: workspace.files_indexed,
                complete: workspace.complete,
                truncated,
            }
        })
        .unwrap_or(FindUsagesResponse {
            symbol_id: Some(symbol_id),
            name: None,
            kind: None,
            definition: None,
            usages: Vec::new(),
            total_count: 0,
            files_indexed: 0,
            complete: false,
            truncated: false,
        }))
    })
    .await
    .map_err(|error| format!("按符号查找用法失败: {error}"))?
}

fn fuzzy_symbol_score(name: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let name_lower = name.to_lowercase();
    let query_lower = query.to_lowercase();
    if name_lower == query_lower {
        return Some(1000);
    }
    if name_lower.starts_with(&query_lower) {
        return Some(800usize.saturating_sub(name.len()) as i32);
    }
    if let Some(index) = name_lower.find(&query_lower) {
        return Some(650i32.saturating_sub(index as i32 * 4));
    }
    let mut query_chars = query_lower.chars();
    let mut expected = query_chars.next();
    let mut gaps = 0i32;
    for character in name_lower.chars() {
        if expected == Some(character) {
            expected = query_chars.next();
            if expected.is_none() {
                return Some(400i32.saturating_sub(gaps));
            }
        } else if expected.is_some() {
            gaps = gaps.saturating_add(1);
        }
    }
    None
}

#[tauri::command]
pub fn search_indexed_workspace_symbols(
    root: String,
    query: String,
    max_results: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<WorkspaceSymbolIndexResponse, String> {
    allowlist.ensure_allowed(&root)?;
    Ok(
        with_workspace(state.inner(), Path::new(&root), |workspace| {
            let query = query.trim();
            let mut scored = workspace
                .symbols_by_id
                .values()
                .filter(|definition| !matches!(definition.kind.as_str(), "parameter" | "import"))
                .filter_map(|definition| {
                    let mut score = fuzzy_symbol_score(&definition.name, query)?;
                    if definition.scope_id == 0 {
                        score += 120;
                    }
                    if matches!(
                        definition.kind.as_str(),
                        "class" | "interface" | "enum" | "function" | "method"
                    ) {
                        score += 40;
                    }
                    Some((score, definition))
                })
                .collect::<Vec<_>>();
            let compare =
                |(left_score, left): &(i32, &Arc<SemanticDefinition>),
                 (right_score, right): &(i32, &Arc<SemanticDefinition>)| {
                    right_score
                        .cmp(left_score)
                        .then(left.name.len().cmp(&right.name.len()))
                        .then(left.relative.cmp(&right.relative))
                        .then(left.line.cmp(&right.line))
                };
            let max_results = max_results
                .unwrap_or(DEFAULT_MAX_RESULTS)
                .clamp(1, HARD_MAX_RESULTS);
            let truncated = workspace.truncated || scored.len() > max_results;
            if scored.len() > max_results {
                scored.select_nth_unstable_by(max_results, compare);
                scored.truncate(max_results);
            }
            scored.sort_by(compare);
            let definitions = scored
                .into_iter()
                .map(|(_, definition)| definition_candidate(definition, "indexed", false))
                .collect();
            WorkspaceSymbolIndexResponse {
                definitions,
                files_indexed: workspace.files_indexed,
                available: true,
                complete: workspace.complete,
                truncated,
            }
        })
        .unwrap_or(WorkspaceSymbolIndexResponse {
            definitions: Vec::new(),
            files_indexed: 0,
            available: false,
            complete: false,
            truncated: false,
        }),
    )
}

#[tauri::command]
pub fn semantic_index_status(
    root: String,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SemanticNavigationState>,
) -> Result<SemanticIndexStatus, String> {
    allowlist.ensure_allowed(&root)?;
    Ok(
        with_workspace(state.inner(), Path::new(&root), |workspace| {
            SemanticIndexStatus {
                root: root.clone(),
                files_indexed: workspace.files_indexed,
                complete: workspace.complete,
                truncated: workspace.truncated,
            }
        })
        .unwrap_or(SemanticIndexStatus {
            root,
            files_indexed: 0,
            complete: false,
            truncated: false,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "qingcode-semantic-{name}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn parse(root: &Path, relative: &str, source: &str) -> SemanticFile {
        parse_semantic_source(root, &root.join(relative), source.as_bytes())
            .unwrap()
            .expect("supported source")
    }

    fn reference<'a>(
        file: &'a SemanticFile,
        name: &str,
        kind: &str,
        line: u32,
    ) -> &'a SemanticReference {
        file.references
            .iter()
            .find(|reference| {
                reference.name == name && reference.kind == kind && reference.line == line
            })
            .unwrap_or_else(|| panic!("missing {name} {kind} at line {line}: {file:?}"))
    }

    #[test]
    fn javascript_binds_shadowed_variables_to_the_nearest_scope() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "main.ts",
            r#"const xu_logger = createLogger()
function outer() {
  xu_logger.info()
  function inner(xu_logger: Logger) {
    xu_logger.info()
    xu_logger = other
    xu_logger++
  }
}
"#,
        );
        let top = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger" && definition.kind == "variable")
            .expect("top-level logger");
        let parameter = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger" && definition.kind == "parameter")
            .expect("shadowing parameter");
        assert_ne!(top.symbol_id, parameter.symbol_id);
        assert_eq!(
            reference(&file, "xu_logger", "read", 3)
                .resolved_symbol_id
                .as_deref(),
            Some(top.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "xu_logger", "read", 5)
                .resolved_symbol_id
                .as_deref(),
            Some(parameter.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "xu_logger", "read-write", 7)
                .resolved_symbol_id
                .as_deref(),
            Some(parameter.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "xu_logger", "write", 6)
                .resolved_symbol_id
                .as_deref(),
            Some(parameter.symbol_id.as_str())
        );
    }

    #[test]
    fn find_usages_keeps_shadowed_variables_separate() {
        let root = Path::new("D:/workspace");
        let file = Arc::new(parse(
            root,
            "main.ts",
            r#"const xu_logger = createLogger()
function outer() {
  xu_logger.info()
  function inner(xu_logger: Logger) {
    xu_logger.info()
    xu_logger = other
    xu_logger++
  }
}
"#,
        ));
        let top = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger" && definition.kind == "variable")
            .expect("top-level logger");
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&file));
        let (usages, total_count) = collect_symbol_usages(
            &workspace,
            "xu_logger",
            Some(&top.symbol_id),
            "variable",
            20,
        );

        assert_eq!(total_count, 2);
        assert_eq!(usages.len(), 2);
        assert_eq!(usages[0].usage_kind.as_deref(), Some("definition"));
        assert_eq!(usages[0].line, 1);
        assert_eq!(usages[1].line, 3);
        assert_eq!(usages[1].usage_kind.as_deref(), Some("read"));
        assert!(!usages[1].approximate);
    }

    #[test]
    fn find_usages_includes_definition_even_without_other_references() {
        let root = Path::new("D:/nem-panel");
        let source = Arc::new(parse(
            root,
            "api/app/lt_prd_control/utils.py",
            "def normalize_db_backup_type(ids, backup_type='full'):\n    return backup_type\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "normalize_db_backup_type")
            .expect("source function");
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&source));

        let (usages, total_count) = collect_symbol_usages(
            &workspace,
            "normalize_db_backup_type",
            Some(&target.symbol_id),
            "function",
            20,
        );

        assert_eq!(total_count, 1);
        assert_eq!(usages.len(), 1);
        assert_eq!(usages[0].usage_kind.as_deref(), Some("definition"));
        assert_eq!(usages[0].relative, "api/app/lt_prd_control/utils.py");
        assert_eq!(usages[0].line, 1);
    }

    #[test]
    fn find_usages_pages_and_filters_before_truncating_results() {
        let root = Path::new("D:/workspace");
        let file = Arc::new(parse(
            root,
            "main.ts",
            r#"let target = createTarget()
target()
target = other
target++
target()
"#,
        ));
        let target = file
            .definitions
            .iter()
            .find(|definition| definition.name == "target")
            .expect("target variable");
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&file));
        let call_kinds = HashSet::from(["call".to_string()]);

        let (first_page, total_count) = collect_symbol_usage_page(
            &workspace,
            "target",
            Some(&target.symbol_id),
            "variable",
            0,
            1,
            Some(&call_kinds),
            false,
        );
        let (second_page, second_total) = collect_symbol_usage_page(
            &workspace,
            "target",
            Some(&target.symbol_id),
            "variable",
            1,
            1,
            Some(&call_kinds),
            false,
        );

        assert_eq!(total_count, 2);
        assert_eq!(second_total, 2);
        assert_eq!(first_page[0].line, 2);
        assert_eq!(second_page[0].line, 5);
        assert_eq!(first_page[0].usage_kind.as_deref(), Some("call"));
    }

    #[test]
    fn javascript_resolves_high_confidence_member_calls_from_constructor_types() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "logger.ts",
            r#"class Logger {
  info() {}
}
const xu_logger = new Logger()
xu_logger.info()
"#,
        );
        let method = file
            .definitions
            .iter()
            .find(|definition| definition.name == "info" && definition.kind == "method")
            .expect("info method");
        let call = reference(&file, "info", "member-call", 5);
        assert_eq!(
            call.resolved_symbol_id.as_deref(),
            Some(method.symbol_id.as_str())
        );
        assert!(!call.approximate);
    }

    #[test]
    fn javascript_resolves_this_method_calls_inside_the_class() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "logger.ts",
            r#"class Logger {
  info() {}
  write() { this.info() }
}
"#,
        );
        let method = file
            .definitions
            .iter()
            .find(|definition| definition.name == "info" && definition.kind == "method")
            .expect("info method");
        let call = reference(&file, "info", "member-call", 3);
        assert_eq!(
            call.resolved_symbol_id.as_deref(),
            Some(method.symbol_id.as_str())
        );
        assert!(!call.approximate);
    }

    #[test]
    fn python_tracks_module_and_parameter_bindings_separately() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "main.py",
            r#"xu_logger = build_logger()
def outer():
    print(xu_logger)
def inner(xu_logger):
    xu_logger.info()
    xu_logger = other
"#,
        );
        let module_logger = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger" && definition.scope_id == 0)
            .expect("module logger");
        let parameter = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger" && definition.kind == "parameter")
            .expect("parameter logger");
        assert_eq!(
            reference(&file, "xu_logger", "read", 3)
                .resolved_symbol_id
                .as_deref(),
            Some(module_logger.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "xu_logger", "read", 5)
                .resolved_symbol_id
                .as_deref(),
            Some(parameter.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "xu_logger", "write", 6)
                .resolved_symbol_id
                .as_deref(),
            Some(parameter.symbol_id.as_str())
        );
    }

    #[test]
    fn resolve_query_jumps_from_a_python_variable_usage_to_its_definition() {
        let root = Path::new("D:/workspace");
        let source = "xu_logger: Logger = build_logger()\nprint(xu_logger)\nxu_logger.info()\n";
        let file = Arc::new(parse(root, "main.py", source));
        let definition = file
            .definitions
            .iter()
            .find(|candidate| candidate.name == "xu_logger")
            .expect("xu_logger definition");
        let usage_position = source.find("xu_logger)").expect("print usage") + 2;
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&file));

        let resolved = resolve_query(&workspace, &file, &root.join("main.py"), usage_position, 20);
        assert_eq!(
            resolved.symbol_id.as_deref(),
            Some(definition.symbol_id.as_str())
        );
        assert_eq!(resolved.definitions.len(), 1);
        assert_eq!(resolved.definitions[0].line, 1);
        assert!(!resolved.definitions[0].approximate);
    }

    #[test]
    fn python_variable_definition_cursor_finds_bound_usages() {
        let root = Path::new("D:/workspace");
        let source = "xu_logger = build_logger()\nprint(xu_logger)\nxu_logger.info('ready')\n";
        let file = Arc::new(parse(root, "main.py", source));
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&file));
        let resolved = resolve_query(
            &workspace,
            &file,
            &root.join("main.py"),
            source.find("xu_logger").expect("definition") + 2,
            20,
        );

        let symbol_id = resolved.symbol_id.expect("bound definition symbol");
        let (usages, total_count) =
            collect_symbol_usages(&workspace, "xu_logger", Some(&symbol_id), "variable", 20);

        assert_eq!(total_count, 3);
        assert_eq!(
            usages
                .iter()
                .map(|candidate| (candidate.line, candidate.usage_kind.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (1, Some("definition")),
                (2, Some("read")),
                (3, Some("read")),
            ]
        );
        assert!(usages.iter().all(|candidate| !candidate.approximate));
    }

    #[test]
    fn python_resolves_self_method_calls_inside_the_class() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "logger.py",
            r#"class Logger:
    def info(self):
        pass
    def write(self):
        self.info()
"#,
        );
        let method = file
            .definitions
            .iter()
            .find(|definition| definition.name == "info" && definition.kind == "method")
            .expect("info method");
        let call = reference(&file, "info", "member-call", 5);
        assert_eq!(
            call.resolved_symbol_id.as_deref(),
            Some(method.symbol_id.as_str())
        );
        assert!(!call.approximate);
    }

    #[test]
    fn java_binds_local_variables_and_receiver_method_calls() {
        let root = Path::new("D:/workspace");
        let source = r#"class Logger {
    void info() {}
}
class Service {
    void run() {
        Logger xu_logger = new Logger();
        xu_logger.info();
        System.out.println(xu_logger);
    }
}
"#;
        let file = Arc::new(parse(root, "Service.java", source));
        let logger_variable = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger")
            .expect("local logger variable");
        let info_method = file
            .definitions
            .iter()
            .find(|definition| definition.name == "info" && definition.kind == "method")
            .expect("Logger.info method");
        let variable_usage = source.rfind("xu_logger").expect("println logger usage") + "xu_".len();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(Arc::clone(&file));

        let resolved = resolve_query(
            &workspace,
            &file,
            &root.join("Service.java"),
            variable_usage,
            20,
        );
        assert_eq!(
            resolved.symbol_id.as_deref(),
            Some(logger_variable.symbol_id.as_str())
        );
        assert_eq!(resolved.definitions[0].line, 6);

        let member_call = reference(&file, "info", "member-call", 7);
        assert_eq!(
            member_call.resolved_symbol_id.as_deref(),
            Some(info_method.symbol_id.as_str())
        );
        assert!(!member_call.approximate);
    }

    #[test]
    fn python_honors_global_and_nonlocal_assignment_bindings() {
        let root = Path::new("D:/workspace");
        let file = parse(
            root,
            "scope.py",
            r#"xu_logger = build_logger()
def outer():
    scoped = build_logger()
    def use_global():
        global xu_logger
        xu_logger = other
    def use_nonlocal():
        nonlocal scoped
        scoped = other
"#,
        );
        let global_logger = file
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger")
            .expect("module logger");
        let outer_scoped = file
            .definitions
            .iter()
            .find(|definition| definition.name == "scoped")
            .expect("outer scoped logger");

        assert_eq!(
            reference(&file, "xu_logger", "write", 6)
                .resolved_symbol_id
                .as_deref(),
            Some(global_logger.symbol_id.as_str())
        );
        assert_eq!(
            reference(&file, "scoped", "write", 9)
                .resolved_symbol_id
                .as_deref(),
            Some(outer_scoped.symbol_id.as_str())
        );
        assert_eq!(
            file.definitions
                .iter()
                .filter(|definition| definition.name == "xu_logger")
                .count(),
            1
        );
        assert_eq!(
            file.definitions
                .iter()
                .filter(|definition| definition.name == "scoped")
                .count(),
            1
        );
    }

    #[test]
    fn rust_use_parser_expands_grouped_and_aliased_imports() {
        assert_eq!(
            parse_rust_use("pub use crate::logger::{info, warn as alert};"),
            vec![
                ParsedImport {
                    local_name: "info".to_string(),
                    module: "crate::logger".to_string(),
                    imported_name: "info".to_string(),
                    namespace: false,
                },
                ParsedImport {
                    local_name: "alert".to_string(),
                    module: "crate::logger".to_string(),
                    imported_name: "warn".to_string(),
                    namespace: false,
                },
            ]
        );
    }

    #[test]
    fn javascript_resolves_tsconfig_paths_through_wildcard_reexports() {
        let root = temp_workspace("tsconfig-paths");
        fs::create_dir_all(root.join("src/services")).unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{
              // JSON5 is common in editor-facing tsconfig files.
              compilerOptions: {
                baseUrl: ".",
                paths: { "@/*": ["src/*"], },
              },
            }"#,
        )
        .unwrap();
        let target = Arc::new(parse(
            &root,
            "src/services/logger.ts",
            "export function info() {}\n",
        ));
        let barrel = Arc::new(parse(
            &root,
            "src/logger.ts",
            "export * from '@/services/logger'\n",
        ));
        let consumer_source = "import { info } from '@/logger'\ninfo()\n";
        let consumer = Arc::new(parse(&root, "src/main.ts", consumer_source));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("exported info")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.clone());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(barrel);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("src/main.ts"),
            consumer_source.rfind("info").unwrap() + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(expected.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn javascript_resolves_named_reexports_of_default_exports() {
        let root = temp_workspace("named-reexport");
        fs::create_dir_all(root.join("src/services")).unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{ compilerOptions: { paths: { "@/*": ["src/*"] } } }"#,
        )
        .unwrap();
        let target = Arc::new(parse(
            &root,
            "src/services/logger.ts",
            "export default class Logger {}\n",
        ));
        let barrel = Arc::new(parse(
            &root,
            "src/logger.ts",
            "export { default as Logger } from '@/services/logger'\n",
        ));
        let consumer_source = "import { Logger } from '@/logger'\nnew Logger()\n";
        let consumer = Arc::new(parse(&root, "src/main.ts", consumer_source));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "Logger")
            .expect("default Logger")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.clone());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(barrel);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("src/main.ts"),
            consumer_source.rfind("Logger").unwrap() + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(expected.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_relative_package_reexports_resolve_to_the_source_definition() {
        let root = Path::new("D:/workspace");
        let target = Arc::new(parse(
            root,
            "app/orders/service.py",
            "def process_order():\n    pass\n",
        ));
        let package = Arc::new(parse(
            root,
            "app/orders/__init__.py",
            "from .service import process_order\n",
        ));
        let consumer_source = "from orders import process_order\nprocess_order()\n";
        let consumer = Arc::new(parse(root, "app/main.py", consumer_source));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "process_order")
            .expect("process_order")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(package);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("app/main.py"),
            consumer_source.rfind("process_order").unwrap() + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn java_imports_resolve_project_classes_and_member_calls() {
        let root = Path::new("D:/workspace");
        let target = Arc::new(parse(
            root,
            "src/main/java/com/acme/Logger.java",
            "package com.acme; public class Logger { public void info() {} }\n",
        ));
        let consumer_source = r#"package com.app;
import com.acme.Logger;
class Service {
    void run() {
        Logger logger = new Logger();
        logger.info();
    }
}
"#;
        let consumer = Arc::new(parse(
            root,
            "src/main/java/com/app/Service.java",
            consumer_source,
        ));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("Logger.info")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let call = reference(&consumer, "info", "member-call", 6);
        assert_eq!(
            workspace.resolved_reference_symbol(call).as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn java_static_imports_resolve_project_members() {
        let root = Path::new("D:/workspace");
        let target = Arc::new(parse(
            root,
            "src/main/java/com/acme/Logger.java",
            "package com.acme; public class Logger { public static void info() {} }\n",
        ));
        let consumer_source =
            "import static com.acme.Logger.info;\nclass Service { void run() { info(); } }\n";
        let consumer = Arc::new(parse(
            root,
            "src/main/java/com/app/Service.java",
            consumer_source,
        ));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("Logger.info")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("src/main/java/com/app/Service.java"),
            consumer_source.rfind("info").unwrap() + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn rust_use_resolves_project_module_functions() {
        let root = Path::new("D:/workspace");
        let target = Arc::new(parse(root, "src/logger.rs", "pub fn info() {}\n"));
        let consumer_source = "use crate::logger::info;\nfn run() { info(); }\n";
        let consumer = Arc::new(parse(root, "src/main.rs", consumer_source));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("logger::info")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("src/main.rs"),
            consumer_source.rfind("info").unwrap() + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn go_imports_resolve_project_package_members() {
        let root = temp_workspace("go-module");
        fs::write(root.join("go.mod"), "module example.com/app\n").unwrap();
        let target = Arc::new(parse(
            &root,
            "internal/logger/logger.go",
            "package logger\nfunc Info() {}\n",
        ));
        let consumer = Arc::new(parse(
            &root,
            "main.go",
            "package main\nimport \"example.com/app/internal/logger\"\nfunc main() { logger.Info() }\n",
        ));
        let expected = target
            .definitions
            .iter()
            .find(|definition| definition.name == "Info")
            .expect("logger.Info")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.clone());
        workspace.insert_file_without_alias_rebuild(target);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let call = reference(&consumer, "Info", "member-call", 3);
        assert_eq!(
            workspace.resolved_reference_symbol(call).as_deref(),
            Some(expected.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_canonicalizes_explicit_import_aliases() {
        let root = Path::new("D:/workspace");
        let source = Arc::new(parse(
            root,
            "logger.ts",
            "export const xu_logger = createLogger()\n",
        ));
        let consumer = Arc::new(parse(
            root,
            "consumer.ts",
            "import { xu_logger as logger } from './logger'\nlogger.info()\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger")
            .expect("exported logger")
            .symbol_id
            .clone();
        let usage = reference(&consumer, "logger", "read", 2);
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(consumer.clone());
        workspace.rebuild_aliases();
        assert_eq!(
            workspace.resolved_reference_symbol(usage).as_deref(),
            Some(target.as_str())
        );
        let (usages, total_count) =
            collect_symbol_usages(&workspace, "xu_logger", Some(&target), "variable", 20);
        assert_eq!(total_count, 3);
        assert_eq!(usages.len(), 3);
        assert!(usages
            .iter()
            .any(|candidate| candidate.usage_kind.as_deref() == Some("definition")));
        assert!(usages
            .iter()
            .any(|candidate| candidate.usage_kind.as_deref() == Some("import")));
        assert!(usages.iter().any(|candidate| {
            candidate.name == "logger" && candidate.usage_kind.as_deref() == Some("read")
        }));
    }

    #[test]
    fn workspace_resolves_namespace_member_calls() {
        let root = Path::new("D:/workspace");
        let source = Arc::new(parse(root, "logger.ts", "export function info() {}\n"));
        let consumer = Arc::new(parse(
            root,
            "consumer.ts",
            "import * as logger from './logger'\nlogger.info()\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("exported info")
            .symbol_id
            .clone();
        let usage = reference(&consumer, "info", "member-call", 2);
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(consumer.clone());
        workspace.rebuild_aliases();

        assert_eq!(
            workspace.resolved_reference_symbol(usage).as_deref(),
            Some(target.as_str())
        );
    }

    #[test]
    fn workspace_resolves_members_from_imported_constructor_types() {
        let root = Path::new("D:/workspace");
        let source = Arc::new(parse(
            root,
            "logger.ts",
            "export class Logger {\n  info() {}\n}\n",
        ));
        let consumer = Arc::new(parse(
            root,
            "consumer.ts",
            "import { Logger } from './logger'\nconst xu_logger = new Logger()\nxu_logger.info()\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("Logger.info")
            .symbol_id
            .clone();
        let usage = reference(&consumer, "info", "member-call", 3);
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(consumer.clone());
        workspace.rebuild_aliases();

        assert_eq!(
            workspace.resolved_reference_symbol(usage).as_deref(),
            Some(target.as_str())
        );
    }

    #[test]
    fn workspace_resolves_python_imported_constructor_members() {
        let root = Path::new("D:/workspace");
        let source = Arc::new(parse(
            root,
            "logger.py",
            "class Logger:\n    def info(self):\n        pass\n",
        ));
        let consumer = Arc::new(parse(
            root,
            "consumer.py",
            "from logger import Logger\nxu_logger = Logger()\nxu_logger.info()\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "info")
            .expect("Logger.info")
            .symbol_id
            .clone();
        let usage = reference(&consumer, "info", "member-call", 3);
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(consumer.clone());
        workspace.rebuild_aliases();

        assert_eq!(
            workspace.resolved_reference_symbol(usage).as_deref(),
            Some(target.as_str())
        );
    }

    #[test]
    fn python_source_symbol_id_finds_import_and_calls_after_definition_jump() {
        let root = Path::new("D:/nem-panel");
        let source = Arc::new(parse(
            root,
            "api/app/lt_prd_control/utils.py",
            "def normalize_db_backup_type(ids, backup_type='full'):\n    return backup_type\n",
        ));
        let consumer = Arc::new(parse(
            root,
            "api/app/lt_prd_control/routes.py",
            "from app.lt_prd_control.utils import normalize_db_backup_type\n\
             first = normalize_db_backup_type([])\n\
             second = normalize_db_backup_type([1], 'diff')\n\
             third = normalize_db_backup_type([2])\n",
        ));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "normalize_db_backup_type")
            .expect("source function")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(consumer);
        workspace.rebuild_aliases();

        let (usages, total_count) = collect_symbol_usages(
            &workspace,
            "normalize_db_backup_type",
            Some(&target),
            "function",
            20,
        );

        assert_eq!(total_count, 5);
        assert_eq!(
            usages
                .iter()
                .filter(|usage| usage.usage_kind.as_deref() == Some("definition"))
                .count(),
            1
        );
        assert_eq!(
            usages.iter().filter(|usage| usage.kind == "import").count(),
            1
        );
        assert_eq!(
            usages
                .iter()
                .filter(|usage| usage.usage_kind.as_deref() == Some("call"))
                .count(),
            3
        );
    }

    #[test]
    fn python_dotted_package_imports_support_cross_file_navigation_and_usages() {
        let root = Path::new("D:/workspace");
        let source = Arc::new(parse(
            root,
            "api/xu_box/xu_logger.py",
            "xu_logger = XuLogger()\n",
        ));
        let consumer_source = "from xu_box.xu_logger import xu_logger\nxu_logger.error('failed')\n";
        let consumer = Arc::new(parse(root, "api/retry_decorator.py", consumer_source));
        let target = source
            .definitions
            .iter()
            .find(|definition| definition.name == "xu_logger")
            .expect("exported xu_logger")
            .symbol_id
            .clone();
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.insert_file_without_alias_rebuild(source);
        workspace.insert_file_without_alias_rebuild(Arc::clone(&consumer));
        workspace.rebuild_aliases();

        let resolved = resolve_query(
            &workspace,
            &consumer,
            &root.join("api/retry_decorator.py"),
            consumer_source.rfind("xu_logger").expect("usage") + 2,
            20,
        );
        assert_eq!(resolved.symbol_id.as_deref(), Some(target.as_str()));
        assert_eq!(resolved.definitions[0].relative, "api/xu_box/xu_logger.py");

        let (usages, total_count) =
            collect_symbol_usages(&workspace, "xu_logger", Some(&target), "variable", 20);
        assert_eq!(total_count, 3);
        assert!(usages.iter().any(|candidate| {
            candidate.usage_kind.as_deref() == Some("definition")
                && candidate.relative == "api/xu_box/xu_logger.py"
        }));
        assert!(usages.iter().any(|candidate| {
            candidate.relative == "api/retry_decorator.py"
                && candidate.line == 2
                && candidate.usage_kind.as_deref() == Some("read")
        }));
    }

    #[test]
    fn replacing_a_file_removes_stale_symbol_contributions() {
        let root = Path::new("D:/workspace");
        let first = Arc::new(parse(root, "main.ts", "export const before = 1\n"));
        let second = Arc::new(parse(root, "main.ts", "export const after = 1\n"));
        let mut workspace = WorkspaceSemanticIndex::new(root.to_path_buf());
        workspace.replace_file(first);
        assert!(workspace.definitions_by_name.contains_key("before"));
        workspace.replace_file(second);
        assert!(!workspace.definitions_by_name.contains_key("before"));
        assert!(workspace.definitions_by_name.contains_key("after"));
    }

    #[test]
    fn semantic_overlays_reuse_equal_content_and_reject_stale_revisions() {
        let root = Path::new("D:/workspace");
        let path = root.join("main.ts");
        let state = SemanticNavigationState::new();
        let current = state
            .update_overlay_internal(root, &path, "const current = 1\n", 2)
            .unwrap()
            .expect("current overlay");
        let reused = state
            .update_overlay_internal(root, &path, "const current = 1\n", 3)
            .unwrap()
            .expect("reused overlay");
        let stale = state
            .update_overlay_internal(root, &path, "const stale = 1\n", 1)
            .unwrap()
            .expect("newer overlay wins");

        assert!(Arc::ptr_eq(&current, &reused));
        assert!(Arc::ptr_eq(&current, &stale));
        let names = with_workspace(&state, root, |workspace| {
            workspace
                .symbols_by_id
                .values()
                .map(|definition| definition.name.clone())
                .collect::<HashSet<_>>()
        })
        .expect("workspace");
        assert!(names.contains("current"));
        assert!(!names.contains("stale"));
    }

    #[test]
    fn disk_refresh_incrementally_replaces_and_removes_file_symbols() {
        let root = temp_workspace("refresh");
        let path = root.join("main.ts");
        let state = SemanticNavigationState::new();
        state.ensure_workspace_root(&root);
        with_workspace(&state, &root, |_| ()).expect("workspace root");
        if let Ok(mut inner) = state.inner.write() {
            inner
                .workspaces
                .get_mut(&path_key(&root))
                .expect("workspace")
                .complete = true;
        }

        fs::write(&path, "export const before = 1\n").unwrap();
        state.refresh_path_from_disk(&path).unwrap();
        let first = with_workspace(&state, &root, |workspace| {
            (
                workspace.definitions_by_name.contains_key("before"),
                workspace.complete,
            )
        })
        .unwrap();
        assert_eq!(first, (true, true));

        fs::write(&path, "export const after = 1\n").unwrap();
        state.refresh_path_from_disk(&path).unwrap();
        let replaced = with_workspace(&state, &root, |workspace| {
            (
                workspace.definitions_by_name.contains_key("before"),
                workspace.definitions_by_name.contains_key("after"),
                workspace.complete,
            )
        })
        .unwrap();
        assert_eq!(replaced, (false, true, true));

        fs::remove_file(&path).unwrap();
        state.refresh_path_from_disk(&path).unwrap();
        let removed = with_workspace(&state, &root, |workspace| {
            (
                workspace.definitions_by_name.contains_key("after"),
                workspace.complete,
            )
        })
        .unwrap();
        assert_eq!(removed, (false, true));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_symbol_matching_supports_subsequence_queries() {
        assert!(fuzzy_symbol_score("WorkspaceSymbolPicker", "wsp").is_some());
        assert!(fuzzy_symbol_score("WorkspaceSymbolPicker", "symbol").is_some());
        assert!(fuzzy_symbol_score("WorkspaceSymbolPicker", "xyz").is_none());
    }
}
