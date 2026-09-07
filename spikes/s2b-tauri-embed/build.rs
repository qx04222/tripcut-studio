fn main() {
    // Same rationale as spikes/s2-libmpv/build.rs: Homebrew libmpv lives
    // outside the default linker search path on Apple Silicon.
    println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/opt/homebrew/lib");
    tauri_build::build();
}
