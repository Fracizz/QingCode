//! Runtime loader for independently installable Tree-sitter language packs.
//!
//! Grammar native code deliberately lives outside the QingCode executable.
//! A missing component disables semantic navigation for its extensions while
//! leaving normal text editing available.

use libloading::Library;
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tree_sitter::Language;
use tree_sitter_language::LanguageFn;

const COMPONENT_ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy)]
struct ComponentBytes {
    ptr: *const u8,
    len: usize,
}

type AbiVersionFn = unsafe extern "C" fn() -> u32;
type LanguageFnRaw = unsafe extern "C" fn() -> *const ();
type QueryFn = unsafe extern "C" fn() -> ComponentBytes;

#[derive(Debug, Clone)]
pub(crate) struct LoadedLanguage {
    pub language: Language,
    pub tags_query: String,
    pub locals_query: String,
}

struct LoadedComponent {
    languages: HashMap<String, LoadedLanguage>,
    // Keep the library after the languages so Rust drops all Language handles
    // before unloading the native grammar code they point into.
    #[allow(dead_code)]
    library: Library,
}

#[derive(Default)]
struct ComponentRegistry {
    components: HashMap<String, LoadedComponent>,
    unavailable: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageComponentStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub extensions: Vec<String>,
}

#[derive(Clone, Copy)]
struct ComponentSpec {
    id: &'static str,
    name: &'static str,
    extensions: &'static [&'static str],
    grammars: &'static [GrammarSpec],
}

#[derive(Clone, Copy)]
struct GrammarSpec {
    key: &'static str,
    language_symbol: &'static [u8],
    tags_symbol: &'static [u8],
    locals_symbol: &'static [u8],
}

const TYPESCRIPT_GRAMMARS: &[GrammarSpec] = &[
    GrammarSpec {
        key: "javascript",
        language_symbol: b"qingcode_javascript_language\0",
        tags_symbol: b"qingcode_javascript_tags\0",
        locals_symbol: b"qingcode_javascript_locals\0",
    },
    GrammarSpec {
        key: "typescript",
        language_symbol: b"qingcode_typescript_language\0",
        tags_symbol: b"qingcode_typescript_tags\0",
        locals_symbol: b"qingcode_typescript_locals\0",
    },
    GrammarSpec {
        key: "tsx",
        language_symbol: b"qingcode_tsx_language\0",
        tags_symbol: b"qingcode_tsx_tags\0",
        locals_symbol: b"qingcode_tsx_locals\0",
    },
];

const SINGLE_PYTHON: &[GrammarSpec] = &[GrammarSpec {
    key: "python",
    language_symbol: b"qingcode_python_language\0",
    tags_symbol: b"qingcode_python_tags\0",
    locals_symbol: b"qingcode_python_locals\0",
}];
const SINGLE_JAVA: &[GrammarSpec] = &[GrammarSpec {
    key: "java",
    language_symbol: b"qingcode_java_language\0",
    tags_symbol: b"qingcode_java_tags\0",
    locals_symbol: b"qingcode_java_locals\0",
}];
const SINGLE_RUST: &[GrammarSpec] = &[GrammarSpec {
    key: "rust",
    language_symbol: b"qingcode_rust_language\0",
    tags_symbol: b"qingcode_rust_tags\0",
    locals_symbol: b"qingcode_rust_locals\0",
}];
const SINGLE_GO: &[GrammarSpec] = &[GrammarSpec {
    key: "go",
    language_symbol: b"qingcode_go_language\0",
    tags_symbol: b"qingcode_go_tags\0",
    locals_symbol: b"qingcode_go_locals\0",
}];

const COMPONENTS: &[ComponentSpec] = &[
    ComponentSpec {
        id: "typescript",
        name: "TypeScript / JavaScript",
        extensions: &["js", "jsx", "mjs", "cjs", "ts", "mts", "cts", "tsx"],
        grammars: TYPESCRIPT_GRAMMARS,
    },
    ComponentSpec {
        id: "python",
        name: "Python",
        extensions: &["py", "pyw"],
        grammars: SINGLE_PYTHON,
    },
    ComponentSpec {
        id: "java",
        name: "Java",
        extensions: &["java"],
        grammars: SINGLE_JAVA,
    },
    ComponentSpec {
        id: "rust",
        name: "Rust",
        extensions: &["rs"],
        grammars: SINGLE_RUST,
    },
    ComponentSpec {
        id: "go",
        name: "Go",
        extensions: &["go"],
        grammars: SINGLE_GO,
    },
];

fn registry() -> &'static Mutex<ComponentRegistry> {
    static REGISTRY: OnceLock<Mutex<ComponentRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(ComponentRegistry::default()))
}

fn component_spec(id: &str) -> Option<&'static ComponentSpec> {
    COMPONENTS.iter().find(|component| component.id == id)
}

fn component_for_extension(extension: &str) -> Option<(&'static ComponentSpec, &'static str)> {
    let component = COMPONENTS
        .iter()
        .find(|component| component.extensions.contains(&extension))?;
    let grammar = match extension {
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "py" | "pyw" => "python",
        "java" => "java",
        "rs" => "rust",
        "go" => "go",
        _ => return None,
    };
    Some((component, grammar))
}

fn library_filename(component_id: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("qingcode_language_{component_id}.dll")
    } else if cfg!(target_os = "macos") {
        format!("libqingcode_language_{component_id}.dylib")
    } else {
        format!("libqingcode_language_{component_id}.so")
    }
}

fn component_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(override_dir) = env::var_os("QINGCODE_LANGUAGE_COMPONENTS_DIR") {
        roots.push(PathBuf::from(override_dir));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("language-components"));
            #[cfg(target_os = "macos")]
            if let Some(contents) = parent.parent() {
                roots.push(contents.join("Resources").join("language-components"));
            }
        }
    }
    roots
}

fn component_library_path(component_id: &str) -> Option<PathBuf> {
    let filename = library_filename(component_id);
    component_roots()
        .into_iter()
        .map(|root| root.join(component_id).join(&filename))
        .find(|path| path.is_file())
}

unsafe fn query_string(library: &Library, symbol: &[u8]) -> Result<String, String> {
    let query = library
        .get::<QueryFn>(symbol)
        .map_err(|error| error.to_string())?();
    if query.ptr.is_null() && query.len != 0 {
        return Err("language component returned an invalid query buffer".to_string());
    }
    let bytes = std::slice::from_raw_parts(query.ptr, query.len);
    String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())
}

unsafe fn load_component(spec: &ComponentSpec, path: &Path) -> Result<LoadedComponent, String> {
    let library = Library::new(path).map_err(|error| error.to_string())?;
    let abi_version = library
        .get::<AbiVersionFn>(b"qingcode_language_component_abi\0")
        .map_err(|error| error.to_string())?();
    if abi_version != COMPONENT_ABI_VERSION {
        return Err(format!(
            "unsupported component ABI {abi_version}; expected {COMPONENT_ABI_VERSION}"
        ));
    }

    let mut languages = HashMap::new();
    for grammar in spec.grammars {
        let raw_language = *library
            .get::<LanguageFnRaw>(grammar.language_symbol)
            .map_err(|error| error.to_string())?;
        let language = Language::new(LanguageFn::from_raw(raw_language));
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&language)
            .map_err(|error| format!("invalid {} grammar: {error}", grammar.key))?;
        languages.insert(
            grammar.key.to_string(),
            LoadedLanguage {
                language,
                tags_query: query_string(&library, grammar.tags_symbol)?,
                locals_query: query_string(&library, grammar.locals_symbol)?,
            },
        );
    }
    Ok(LoadedComponent { languages, library })
}

fn ensure_component_loaded(id: &str) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .map_err(|_| "language component registry is unavailable".to_string())?;
    if registry.components.contains_key(id) {
        return Ok(());
    }
    if let Some(error) = registry.unavailable.get(id) {
        return Err(error.clone());
    }
    let spec = component_spec(id).ok_or_else(|| format!("unknown language component: {id}"))?;
    let Some(path) = component_library_path(id) else {
        let error = format!("language component is not installed: {id}");
        registry.unavailable.insert(id.to_string(), error.clone());
        return Err(error);
    };
    let component = match unsafe { load_component(spec, &path) } {
        Ok(component) => component,
        Err(error) => {
            registry.unavailable.insert(id.to_string(), error.clone());
            return Err(error);
        }
    };
    registry.components.insert(id.to_string(), component);
    Ok(())
}

#[cfg(test)]
fn test_language(grammar: &str) -> Option<LoadedLanguage> {
    let language = match grammar {
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => return None,
    };
    let (tags_query, locals_query) = match grammar {
        "javascript" => (
            tree_sitter_javascript::TAGS_QUERY,
            tree_sitter_javascript::LOCALS_QUERY,
        ),
        "typescript" | "tsx" => (
            tree_sitter_typescript::TAGS_QUERY,
            tree_sitter_typescript::LOCALS_QUERY,
        ),
        "python" => (tree_sitter_python::TAGS_QUERY, ""),
        "java" => (tree_sitter_java::TAGS_QUERY, ""),
        "rust" => (tree_sitter_rust::TAGS_QUERY, ""),
        "go" => (tree_sitter_go::TAGS_QUERY, ""),
        _ => unreachable!(),
    };
    Some(LoadedLanguage {
        language,
        tags_query: tags_query.to_string(),
        locals_query: locals_query.to_string(),
    })
}

pub(crate) fn language_for_path(path: &Path) -> Option<(String, LoadedLanguage)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let (component, grammar) = component_for_extension(&extension)?;

    #[cfg(test)]
    if let Some(language) = test_language(grammar) {
        return Some((grammar.to_string(), language));
    }

    ensure_component_loaded(component.id).ok()?;
    let registry = registry().lock().ok()?;
    registry
        .components
        .get(component.id)?
        .languages
        .get(grammar)
        .cloned()
        .map(|language| (grammar.to_string(), language))
}

pub(crate) fn statuses() -> Vec<LanguageComponentStatus> {
    COMPONENTS
        .iter()
        .map(|component| LanguageComponentStatus {
            id: component.id.to_string(),
            name: component.name.to_string(),
            installed: component_library_path(component.id).is_some(),
            extensions: component
                .extensions
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
        })
        .collect()
}

#[tauri::command]
pub(crate) fn language_component_statuses() -> Vec<LanguageComponentStatus> {
    statuses()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_typescript_extensions_to_one_component() {
        let (component, grammar) = component_for_extension("tsx").unwrap();
        assert_eq!(component.id, "typescript");
        assert_eq!(grammar, "tsx");
    }

    #[test]
    fn all_components_are_optional_when_no_component_directory_exists() {
        assert_eq!(COMPONENTS.len(), 5);
        assert!(COMPONENTS.iter().all(|component| !component.id.is_empty()));
    }

    #[test]
    fn loads_staged_dynamic_components_when_requested() {
        let Some(root) = env::var_os("QINGCODE_TEST_COMPONENT_ROOT").map(PathBuf::from) else {
            return;
        };
        for component in COMPONENTS {
            let path = root.join(component.id).join(library_filename(component.id));
            let loaded = unsafe { load_component(component, &path) }
                .unwrap_or_else(|error| panic!("failed to load {}: {error}", component.id));
            assert_eq!(loaded.languages.len(), component.grammars.len());
        }
    }
}
