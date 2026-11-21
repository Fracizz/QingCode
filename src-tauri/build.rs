fn main() {
    // Headless integration tests can still link Tauri/rfd's TaskDialogIndirect.
    // Link targets need Common Controls v6; without the manifest Windows loads
    // v5 and fails before the unit-test harness. Cargo's link-arg-tests excludes
    // lib unit tests, so use link-arg for MSVC link targets, including tests.
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // Vite always rewrites dist/index.html. Watching only the ../dist directory
    // entry is unreliable on Windows (mtime often unchanged when files inside change),
    // which left package-exe shipping a cached binary with a stale frontend.
    println!("cargo:rerun-if-changed=../dist/index.html");
    emit_app_version(std::path::Path::new("tauri.conf.json"));
    tauri_build::build();
    if windows_msvc {
        // tauri-build already embeds this binary's manifest in resource.lib.
        // Only lib/unit-test link targets need the linker-generated manifest.
        println!("cargo:rustc-link-arg-bin=qingcode=/MANIFEST:NO");
        println!("cargo:rustc-link-arg-bin=qingcode-cli=/MANIFEST:NO");
    }
}

/// 从 tauri.conf.json 读取应用版本（唯一来源），写入 `OUT_DIR/qingcode_version.txt`（代码经 include_str! 读取）。
/// Cargo.toml 的 version 固定为 0.0.0，避免版本 bump 让增量编译缓存失效。
fn emit_app_version(conf: &std::path::Path) {
    println!("cargo:rerun-if-changed={}", conf.display());
    let read_version = |path: &std::path::Path| -> String {
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()));
        let json: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("解析 {} 失败：{e}", path.display()));
        json.get("version")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{} 缺少 version 字段", path.display()))
            .to_string()
    };
    let mut version = read_version(conf);
    // Tauri 允许 version 写成指向 package.json 的相对路径。
    if version.ends_with(".json") {
        let pkg = conf.parent().unwrap().join(&version);
        println!("cargo:rerun-if-changed={}", pkg.display());
        version = read_version(&pkg);
    }
    // 写入 OUT_DIR 文件并由 include_str! 引用，而不是 cargo:rustc-env：
    // 实测 rustc-env 变化会让该 crate 的增量缓存近乎整体失效（~110s），
    // 文件内容变化则只重编引用它的少数函数。内容不变时不重写，保持 mtime。
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("qingcode_version.txt");
    if std::fs::read_to_string(&out).ok().as_deref() != Some(version.as_str()) {
        std::fs::write(&out, &version).expect("写入 qingcode_version.txt 失败");
    }
}
