import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import "./App.css";

interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
  // "Application" | "Input" | "Monitor" (from larmindon-core DeviceType)
  device_type?: string;
  application_name?: string;
}

interface Settings {
  font_family: string;
  font_size_px: number;
  theme_mode: string;
}

function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [fontSettings, setFontSettings] = useState<Settings>({
    font_family: "",
    font_size_px: 0,
    theme_mode: "dark",
  });

  async function refreshDevices() {
    const devs = await invoke<AudioDevice[]>("list_devices");
    setDevices(devs);
    setSelectedDevice((prev) => {
      if (prev && devs.some((d) => d.id === prev)) {
        return prev;
      }
      const defaultDev = devs.find((d) => d.is_default);
      return defaultDev?.id ?? (devs.length > 0 ? devs[0].id : "");
    });
  }

  useEffect(() => {
    async function init() {
      const devs = await invoke<AudioDevice[]>("list_devices");
      setDevices(devs);

      // Pre-select the default device but don't start transcription automatically
      const defaultDev = devs.find((d) => d.is_default) ?? devs[0];
      if (defaultDev) {
        setSelectedDevice(defaultDev.id);
      }
    }

    init();

    const unlistenTranscription = listen<{ text: string }>(
      "transcription",
      (event) => {
        setTranscript((prev) => prev + event.payload.text);
        setError("");
      }
    );

    const unlistenError = listen<{ text: string }>(
      "transcription-error",
      (event) => {
        setError(event.payload.text);
        setIsRunning(false);
      }
    );

    const unlistenDevicesChanged = listen<AudioDevice[]>(
      "devices-changed",
      (event) => {
        setDevices(event.payload);
      }
    );

    // Backend switched source (e.g., active stream disappeared, fell back to default)
    const unlistenSourceSwitched = listen<string>(
      "source-switched",
      (event) => {
        setSelectedDevice(event.payload);
      }
    );

    const unlistenClearTranscript = listen("clear-transcript", () => {
      setTranscript("");
    });

    const unlistenCopyTranscript = listen("copy-transcript", () => {
      // transcript state isn't accessible here due to closure, so read from DOM
      const el = document.querySelector(".transcript");
      if (el?.textContent) {
        navigator.clipboard.writeText(el.textContent);
      }
    });

    const unlistenOpenPreferences = listen("open-preferences", () => {
      openPreferences();
    });

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenDevicesChanged.then((fn) => fn());
      unlistenSourceSwitched.then((fn) => fn());
      unlistenClearTranscript.then((fn) => fn());
      unlistenCopyTranscript.then((fn) => fn());
      unlistenOpenPreferences.then((fn) => fn());
    };
  }, []);

  async function applyTheme(themeMode: string) {
    let effectiveTheme = themeMode;
    
    if (themeMode === "system") {
      // Detect system theme
      const systemTheme = await invoke<string>("get_system_theme");
      effectiveTheme = systemTheme;
    }
    
    // Apply theme to document
    document.documentElement.setAttribute("data-theme", effectiveTheme);
  }

  useEffect(() => {
    async function initTheme() {
      const s = await invoke<Settings>("get_settings");
      setFontSettings({
        font_family: s.font_family,
        font_size_px: s.font_size_px,
        theme_mode: s.theme_mode,
      });
      // Cache settings for immediate access
      localStorage.setItem('larmindon_settings', JSON.stringify(s));
      await applyTheme(s.theme_mode);
    }

    initTheme();

    const unlistenSettings = listen<Settings>("settings-changed", async (event) => {
      setFontSettings({
        font_family: event.payload.font_family,
        font_size_px: event.payload.font_size_px,
        theme_mode: event.payload.theme_mode,
      });
      // Cache settings for immediate access
      localStorage.setItem('larmindon_settings', JSON.stringify(event.payload));
      await applyTheme(event.payload.theme_mode);
    });

    return () => {
      unlistenSettings.then((fn) => fn());
    };
  }, []);

  // Listen for system theme changes when in "system" mode
  useEffect(() => {
    if (fontSettings.theme_mode !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    
    function handleChange() {
      const newTheme = mediaQuery.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", newTheme);
    }

    // Apply initial system theme
    handleChange();

    // Listen for changes
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [fontSettings.theme_mode]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

  function handleTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 20;
  }

  async function openPreferences() {
    const existing = await WebviewWindow.getByLabel("preferences");
    if (existing) {
      await existing.setFocus();
      return;
    }

    const width = 500;
    const height = 480;

    const main = getCurrentWebviewWindow();
    const scale = await main.scaleFactor();
    const mainPos = (await main.outerPosition()).toLogical(scale);
    const mainSize = (await main.outerSize()).toLogical(scale);
    const x = Math.round(mainPos.x + (mainSize.width - width) / 2);
    const y = Math.round(mainPos.y + (mainSize.height - height) / 2);

    const prefs = new WebviewWindow("preferences", {
      url: "preferences.html",
      title: "Preferences",
      width,
      height,
      minWidth: 420,
      minHeight: 400,
      resizable: true,
    });
    prefs.once("tauri://created", () => {
      prefs.setPosition(new LogicalPosition(x, y));
    });
  }

  async function openCaptionOverlay() {
    try {
      await invoke("open_caption_overlay");
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openPreferences();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function handleStart() {
    setError("");
    try {
      await invoke("start_transcription", {
        deviceId: selectedDevice || null,
      });
      setIsRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_transcription");
      setIsRunning(false);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="container">
      <div className="controls">
        <button
          className="prefs-btn"
          onClick={openPreferences}
          title="Preferences (Ctrl+,)"
        >
          &#x2699;
        </button>

        <button
          className="overlay-btn"
          onClick={openCaptionOverlay}
          title="Open caption overlay"
        >
          Overlay
        </button>

        <select
          value={selectedDevice}
          onChange={async (e) => {
            const newId = e.target.value;
            setSelectedDevice(newId);
            if (isRunning) {
              try {
                await invoke("switch_source", { deviceId: newId });
              } catch (err) {
                setError(String(err));
              }
            }
          }}
        >
          {devices.length === 0 && <option value="">No devices found</option>}
          {[
            { label: "Applications", type: "Application" },
            { label: "Inputs", type: "Input" },
            { label: "System Audio", type: "Monitor" },
          ].map((group) => {
            const groupDevices = devices.filter(
              (d) => (d.device_type ?? "Input") === group.type
            );
            if (groupDevices.length === 0) return null;
            return (
              <optgroup key={group.type} label={group.label}>
                {groupDevices.map((dev) => (
                  <option key={dev.id} value={dev.id}>
                    {dev.application_name ?? dev.name}
                    {dev.is_default ? " (default)" : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        <button
          className="refresh-btn"
          onClick={refreshDevices}
          disabled={isRunning}
          title="Refresh device list"
        >
          &#x21bb;
        </button>

        {isRunning ? (
          <button className="stop-btn" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            className="start-btn"
            onClick={handleStart}
            disabled={devices.length === 0}
          >
            Start
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div
        className="transcript"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        style={{
          ...(fontSettings.font_family ? { fontFamily: fontSettings.font_family } : {}),
          ...(fontSettings.font_size_px > 0 ? { fontSize: `${fontSettings.font_size_px}px` } : {}),
        }}
      >
        {transcript || (
          <span className="placeholder">
            {isRunning
              ? "Listening..."
              : "Select an audio source and press Start"}
          </span>
        )}
      </div>
    </main>
  );
}

export default App;
