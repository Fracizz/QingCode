use crate::language_components;
use std::path::Path;
use tree_sitter::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LanguageFamily {
    JavaScript,
    Python,
    Rust,
    Go,
    Java,
}

impl LanguageFamily {
    pub(super) fn supports_precise_binding(self) -> bool {
        matches!(self, Self::JavaScript | Self::Python)
    }
}

pub(super) fn language_for_path(path: &Path) -> Option<(LanguageFamily, Language)> {
    let (grammar, loaded) = language_components::language_for_path(path)?;
    let family = match grammar.as_str() {
        "javascript" | "typescript" | "tsx" => LanguageFamily::JavaScript,
        "python" => LanguageFamily::Python,
        "rust" => LanguageFamily::Rust,
        "go" => LanguageFamily::Go,
        "java" => LanguageFamily::Java,
        _ => return None,
    };
    Some((family, loaded.language))
}
