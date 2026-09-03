fn main() {
    // libmpv 的链接路径。
    //
    // 分发版必须链到自编的 LGPL libmpv:Homebrew 的 libmpv 链接 GPL 版
    // libavcodec,会把 libx264/libx265 拖进 .app,导致 GPLv3 传染。
    // 通过 LGPL_MPV_LIB 指向 scripts/build-lgpl-mpv.sh 的产物即可切换;
    // 开发时不设该变量则回落到 Homebrew(方便本机迭代)。
    let mpv_lib_dir = std::env::var("LGPL_MPV_LIB")
        .ok()
        .filter(|path| std::path::Path::new(path).join("libmpv.2.dylib").is_file())
        .unwrap_or_else(|| "/opt/homebrew/lib".to_owned());
    println!("cargo:rerun-if-env-changed=LGPL_MPV_LIB");
    println!("cargo:rustc-link-search=native={mpv_lib_dir}");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{mpv_lib_dir}");
    tauri_build::build()
}
