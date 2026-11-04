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
    tauri_build::build();
    if windows_msvc {
        // tauri-build already embeds this binary's manifest in resource.lib.
        // Only lib/unit-test link targets need the linker-generated manifest.
        println!("cargo:rustc-link-arg-bin=qingcode=/MANIFEST:NO");
    }
}
