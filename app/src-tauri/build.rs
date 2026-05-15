fn main() {
    #[cfg(all(target_os = "macos", feature = "webgpu"))]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    }

    tauri_build::build()
}
