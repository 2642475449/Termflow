fn main() {
    // Vite recreates the entire dist directory before Tauri invokes Cargo. Cargo's
    // directory watcher may miss that replacement, so track the entry point itself.
    // When it changes, tauri-build regenerates and embeds the complete asset set.
    println!("cargo:rerun-if-changed=../dist/index.html");

    tauri_build::build();
}
