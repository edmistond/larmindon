---
name: Flatpak packaging reference
description: How to package Larmindon as a Flatpak — two approaches, key gotchas, and relevant links
type: reference
---

Tauri v2 has no built-in Flatpak bundler (tauri-apps/tauri#3619, open since 2022).

## Quick path: repackage the .deb
Build as .deb via `npm run tauri build`, write a flatpak-builder manifest that extracts into `/app`. Documented in Tauri's own docs. Fine for personal use; Flathub prefers source builds.

## Proper path: build from source
- Runtime: `org.gnome.Sdk//46` (includes WebKitGTK; older runtimes cause blank screens)
- Rust: `org.freedesktop.Sdk.Extension.rust-stable`
- Node: `org.freedesktop.Sdk.Extension.node20`
- Must pre-vendor all Cargo crates and npm packages for offline builds using `flatpak-builder-tools`

## Larmindon-specific gotchas
- **PipeWire**: Need `--filesystem=xdg-run/pipewire-0` permission
- **Path resolution**: Tauri expects assets under `/usr`, Flatpak installs to `/app` — may need patching
- **Model path**: Now configurable via preferences (no longer hardcoded)

## Key references
- Tauri v2 Flatpak docs: https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/distribute/flatpak.mdx
- Vincent Jousse walkthrough: https://vincent.jousse.org/blog/en/packaging-tauri-v2-flatpak-snapcraft-elm/
- Flathub discussion: https://discourse.flathub.org/t/help-tauri-implement-flatpak-support/5993
