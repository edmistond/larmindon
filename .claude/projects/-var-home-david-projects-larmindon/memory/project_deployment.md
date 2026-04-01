---
name: Deployment and platform context
description: Target platform is Bluefin Linux (Silverblue derivative) with Wayland, dev container is Arch Linux, shipping as Flatpak
type: project
---

Target platform is Bluefin Linux (Fedora Silverblue derivative) running Wayland/GNOME.
Development happens inside a containerized Arch Linux dev container.
Goal is to ship as a Flatpak.

**Why:** Bluefin encourages containerized development; Flatpak is the standard app distribution for immutable Fedora desktops.
**How to apply:** Consider Wayland and Flatpak sandbox implications for window management, audio (PipeWire), and filesystem access. Native OS features like always-on-top may behave differently under Wayland vs X11, and Flatpak sandboxing adds portal/permission constraints.
