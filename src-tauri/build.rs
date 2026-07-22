fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // Vite always rewrites dist/index.html. Watching only the ../dist directory
    // entry is unreliable on Windows (mtime often unchanged when files inside change),
    // which left package-exe shipping a cached binary with a stale frontend.
    println!("cargo:rerun-if-changed=../dist/index.html");
    tauri_build::build()
}
