import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";

interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
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
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  async function openPreferences() {
    const existing = await WebviewWindow.getByLabel("preferences");
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow("preferences", {
      url: "preferences.html",
      title: "Preferences",
      width: 500,
      height: 480,
      minWidth: 420,
      minHeight: 400,
      resizable: true,
      center: true,
    });
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
          {devices.map((dev) => (
            <option key={dev.id} value={dev.id}>
              {dev.name}{dev.is_default ? " (default)" : ""}
            </option>
          ))}
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
