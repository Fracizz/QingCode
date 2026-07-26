use super::{
    definition_candidate, path_key, SemanticCandidate, SemanticDefinition, SemanticFile,
    WorkspaceSemanticIndex,
};
use std::path::Path;

pub(super) struct ResolvedQuery {
    pub(super) symbol_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) kind: Option<String>,
    pub(super) definitions: Vec<SemanticCandidate>,
}

fn candidate_score(
    definition: &SemanticDefinition,
    source_path: &Path,
    selected_kind: Option<&str>,
) -> i32 {
    let mut score = 0;
    if path_key(Path::new(&definition.path)) == path_key(source_path) {
        score += 1000;
    } else if Path::new(&definition.path).parent() == source_path.parent() {
        score += 220;
    }
    if let Some(kind) = selected_kind {
        if kind.contains("call")
            && matches!(
                definition.kind.as_str(),
                "function" | "method" | "constructor"
            )
        {
            score += 260;
        }
        if kind == "type"
            && matches!(
                definition.kind.as_str(),
                "class" | "interface" | "enum" | "type"
            )
        {
            score += 320;
        }
    }
    if definition.relative.contains("/test") || definition.relative.contains("/__tests__/") {
        score -= 90;
    }
    score
}

pub(super) fn resolve_query(
    workspace: &WorkspaceSemanticIndex,
    file: &SemanticFile,
    source_path: &Path,
    position: usize,
    max_results: usize,
) -> ResolvedQuery {
    let definition = file
        .definitions
        .iter()
        .filter(|definition| definition.start <= position && position <= definition.end)
        .min_by_key(|definition| definition.end.saturating_sub(definition.start));
    if let Some(definition) = definition {
        let canonical = workspace.canonical_symbol_id(&definition.symbol_id);
        let target = workspace
            .symbols_by_id
            .get(&canonical)
            .unwrap_or(definition);
        return ResolvedQuery {
            symbol_id: Some(canonical),
            name: Some(target.name.clone()),
            kind: Some(target.kind.clone()),
            definitions: vec![definition_candidate(target, "bound", false)],
        };
    }

    let reference = file
        .references
        .iter()
        .filter(|reference| reference.start <= position && position <= reference.end)
        .min_by_key(|reference| reference.end.saturating_sub(reference.start));
    let Some(reference) = reference else {
        return ResolvedQuery {
            symbol_id: None,
            name: None,
            kind: None,
            definitions: Vec::new(),
        };
    };

    if let Some(symbol_id) = workspace.resolved_reference_symbol(reference) {
        if let Some(target) = workspace.symbols_by_id.get(&symbol_id) {
            return ResolvedQuery {
                symbol_id: Some(symbol_id),
                name: Some(target.name.clone()),
                kind: Some(target.kind.clone()),
                definitions: vec![definition_candidate(target, "bound", false)],
            };
        }
    }

    let mut definitions = workspace
        .definitions_by_name
        .get(&reference.name.to_lowercase())
        .cloned()
        .unwrap_or_default();
    definitions.sort_by(|left, right| {
        candidate_score(right, source_path, Some(&reference.kind))
            .cmp(&candidate_score(left, source_path, Some(&reference.kind)))
            .then(left.relative.cmp(&right.relative))
            .then(left.line.cmp(&right.line))
    });
    definitions.truncate(max_results);
    let candidates = definitions
        .iter()
        .map(|definition| definition_candidate(definition, "approximate", true))
        .collect::<Vec<_>>();
    let selected = (definitions.len() == 1).then(|| definitions[0].clone());
    ResolvedQuery {
        symbol_id: selected
            .as_ref()
            .map(|definition| definition.symbol_id.clone()),
        name: Some(reference.name.clone()),
        kind: selected
            .as_ref()
            .map(|definition| definition.kind.clone())
            .or_else(|| Some(reference.kind.clone())),
        definitions: candidates,
    }
}
