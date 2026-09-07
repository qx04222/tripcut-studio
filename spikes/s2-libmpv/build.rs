fn main() {
    // Homebrew libmpv lives outside the default linker search path on Apple
    // Silicon; point the linker + runtime loader at it explicitly so we don't
    // depend on a global LIBRARY_PATH being set.
    println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/opt/homebrew/lib");
}
