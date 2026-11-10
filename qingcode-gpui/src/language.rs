//! 文件扩展名 → gpui-component 高亮语言名映射。
//!
//! 返回值必须是 gpui-component `Language::name()` 认识的名字（例如 `tsx`、`markdown`），
//! 未知类型统一返回 `text`，编辑器会按纯文本处理。

use std::path::Path;

/// 根据路径推断编辑器语言名。
pub fn language_for_path(path: &Path) -> &'static str {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    // 无扩展名或特殊文件名优先匹配
    match file_name.as_str() {
        "makefile" | "gnumakefile" => return "make",
        "cmakelists.txt" => return "cmake",
        "dockerfile" => return "bash",
        ".bashrc" | ".zshrc" | ".profile" => return "bash",
        _ => {}
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match ext.as_str() {
        "rs" => "rust",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "json" | "jsonc" | "json5" => "json",
        "md" | "mdx" | "markdown" => "markdown",
        "py" | "pyi" => "python",
        "go" => "go",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        "css" | "scss" | "less" => "css",
        // vue/svelte 暂无专用语法，用 html 近似
        "html" | "htm" | "vue" => "html",
        "sh" | "bash" | "zsh" => "bash",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn lang(p: &str) -> &'static str {
        language_for_path(&PathBuf::from(p))
    }

    #[test]
    fn maps_common_extensions_case_insensitively() {
        assert_eq!(lang("src/main.rs"), "rust");
        assert_eq!(lang("App.TSX"), "tsx");
        assert_eq!(lang("a/b/c.ts"), "typescript");
        assert_eq!(lang("package.json"), "json");
        assert_eq!(lang("README.MD"), "markdown");
        assert_eq!(lang("x.vue"), "html");
    }

    #[test]
    fn special_file_names_win_over_extension() {
        assert_eq!(lang("Makefile"), "make");
        assert_eq!(lang("CMakeLists.txt"), "cmake");
    }

    #[test]
    fn unknown_or_missing_extension_is_plain_text() {
        assert_eq!(lang("LICENSE"), "text");
        assert_eq!(lang("image.bin"), "text");
    }
}
