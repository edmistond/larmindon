fn main() {
    #[cfg(all(target_os = "macos", feature = "webgpu"))]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    }

    #[cfg(feature = "engine-april")]
    prepare_april_runtime();

    tauri_build::build()
}

/// libaprilasr is built by aprilasr-sys into its OUT_DIR, linked via @rpath,
/// and references the package-manager libonnxruntime by absolute path. Two
/// problems with that on macOS:
///
/// - nothing adds an rpath to the final binary, so libaprilasr isn't found;
/// - Gatekeeper blocks the package manager's foreign-ad-hoc-signed
///   libonnxruntime ("Apple could not verify...").
///
/// Fix both without touching any shared system file: keep a byte-copy of
/// libonnxruntime under ~/.config/larmindon/runtime/, re-signed with a LOCAL
/// ad-hoc signature (locally created signatures are trusted), and rewrite our
/// own built libaprilasr to load that copy. ort's load-dynamic path is pointed
/// at the same file at runtime (see larmindon_engine_april::ensure_ort_dylib),
/// so exactly one ONNX Runtime lives in the process.
#[cfg(feature = "engine-april")]
fn prepare_april_runtime() {
    use std::path::{Path, PathBuf};

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let Some(build_dir) = out_dir.parent().and_then(|p| p.parent()) else {
        return;
    };

    #[cfg(target_os = "macos")]
    let managed = make_managed_onnxruntime();

    if let Ok(entries) = std::fs::read_dir(build_dir) {
        for entry in entries.flatten() {
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with("aprilasr-sys-")
            {
                continue;
            }
            let lib_dir = entry.path().join("out").join("lib");
            if !lib_dir.is_dir() {
                continue;
            }
            // Dev binaries resolve @rpath/libaprilasr.*.dylib here.
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
            println!("cargo:rerun-if-changed={}", lib_dir.display());

            #[cfg(target_os = "macos")]
            if let Some(managed) = managed.as_ref() {
                patch_libaprilasr(&lib_dir, managed);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = build_dir;

    fn _unused(_: &Path) {}
}

/// Refresh (if stale) the locally signed copy of the system libonnxruntime.
/// Returns None when no system copy exists or signing fails; the build still
/// succeeds and the runtime falls back to the system file.
#[cfg(all(feature = "engine-april", target_os = "macos"))]
fn make_managed_onnxruntime() -> Option<std::path::PathBuf> {
    use std::path::Path;

    let system = [
        "/opt/homebrew/lib/libonnxruntime.dylib",
        "/usr/local/lib/libonnxruntime.dylib",
    ]
    .iter()
    .map(Path::new)
    .find(|p| p.exists())?;
    let system = std::fs::canonicalize(system).ok()?;
    println!("cargo:rerun-if-changed={}", system.display());

    let home = std::env::var("HOME").ok()?;
    let runtime_dir = Path::new(&home).join(".config/larmindon/runtime");
    std::fs::create_dir_all(&runtime_dir).ok()?;
    let managed = runtime_dir.join("libonnxruntime.dylib");

    let system_meta = std::fs::metadata(&system).ok()?;
    let fresh = std::fs::metadata(&managed).is_ok_and(|m| {
        m.len() == system_meta.len()
            && matches!(
                (m.modified(), system_meta.modified()),
                (Ok(ours), Ok(theirs)) if ours >= theirs
            )
    });
    if fresh {
        return Some(managed);
    }

    // Byte copy (fs::copy could carry extended attributes along), sign with a
    // fresh local ad-hoc identity, swap in atomically so a running app's
    // mapped copy is never rewritten in place.
    let tmp = runtime_dir.join(".libonnxruntime.dylib.tmp");
    let bytes = std::fs::read(&system).ok()?;
    std::fs::write(&tmp, bytes).ok()?;
    let signed = std::process::Command::new("codesign")
        .args(["-f", "-s", "-"])
        .arg(&tmp)
        .status()
        .is_ok_and(|s| s.success());
    if !signed {
        println!("cargo:warning=engine-april: failed to re-sign libonnxruntime copy");
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    std::fs::rename(&tmp, &managed).ok()?;
    println!(
        "cargo:warning=engine-april: refreshed locally-signed ONNX Runtime at {}",
        managed.display()
    );
    Some(managed)
}

/// Rewrite our built libaprilasr dylibs to load the managed libonnxruntime
/// instead of the absolute package-manager path, then re-sign them locally.
/// These are build artifacts of this project, not shared system files.
#[cfg(all(feature = "engine-april", target_os = "macos"))]
fn patch_libaprilasr(lib_dir: &std::path::Path, managed: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(lib_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_real_dylib = path.extension().is_some_and(|e| e == "dylib")
            && entry.file_type().is_ok_and(|t| !t.is_symlink());
        if !is_real_dylib {
            continue;
        }

        let Ok(output) = std::process::Command::new("otool")
            .arg("-L")
            .arg(&path)
            .output()
        else {
            continue;
        };
        let deps = String::from_utf8_lossy(&output.stdout);
        let foreign_refs: Vec<String> = deps
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .filter(|dep| {
                dep.contains("libonnxruntime") && !dep.starts_with(&*managed.to_string_lossy())
            })
            .map(str::to_string)
            .collect();
        if foreign_refs.is_empty() {
            continue;
        }

        let mut cmd = std::process::Command::new("install_name_tool");
        for dep in &foreign_refs {
            cmd.arg("-change").arg(dep).arg(managed);
        }
        if !cmd.arg(&path).status().is_ok_and(|s| s.success()) {
            println!(
                "cargo:warning=engine-april: failed to retarget {} to managed libonnxruntime",
                path.display()
            );
            continue;
        }
        let _ = std::process::Command::new("codesign")
            .args(["-f", "-s", "-"])
            .arg(&path)
            .status();
        println!(
            "cargo:warning=engine-april: {} now loads {}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            managed.display()
        );
    }
}
