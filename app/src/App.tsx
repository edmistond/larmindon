import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu, MenuItem, PredefinedMenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import "./App.css";

interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

interface FontSettings {
  font_family: string;
  font_size_px: number;
}

function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [fontSettings, setFontSettings] = useState<FontSettings>({
    font_family: "",
    font_size_px: 0,
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

      // Pick the default device (system default monitor, or first device)
      const defaultDev = devs.find((d) => d.is_default) ?? devs[0];
      if (defaultDev) {
        setSelectedDevice(defaultDev.id);
        try {
          await invoke("start_transcription", { deviceId: defaultDev.id });
          setIsRunning(true);
        } catch (e) {
          setError(String(e));
        }
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

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenDevicesChanged.then((fn) => fn());
      unlistenSourceSwitched.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    invoke<FontSettings>("get_settings").then((s) =>
      setFontSettings({ font_family: s.font_family, font_size_px: s.font_size_px }),
    );

    const unlistenSettings = listen<FontSettings>("settings-changed", (event) => {
      setFontSettings({
        font_family: event.payload.font_family,
        font_size_px: event.payload.font_size_px,
      });
    });

    return () => {
      unlistenSettings.then((fn) => fn());
    };
  }, []);

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
      resizable: false,
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

  async function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      setAlwaysOnTop(next);
    } catch (e) {
      setError(`Always on top: ${String(e)}`);
    }
  }

  async function showHamburgerMenu(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = [];

    // Audio source section
    for (const dev of devices) {
      const label = dev.name + (dev.is_default ? " (default)" : "");
      items.push(
        await CheckMenuItem.new({
          text: label,
          checked: dev.id === selectedDevice,
          action: async () => {
            setSelectedDevice(dev.id);
            if (isRunning) {
              try {
                await invoke("switch_source", { deviceId: dev.id });
              } catch (err) {
                setError(String(err));
              }
            }
          },
        })
      );
    }

    if (devices.length === 0) {
      items.push(
        await MenuItem.new({ text: "No devices found", enabled: false })
      );
    }

    items.push(await PredefinedMenuItem.new({ item: "Separator" }));

    items.push(
      await MenuItem.new({
        text: "Refresh Devices",
        enabled: !isRunning,
        action: () => refreshDevices(),
      })
    );

    items.push(await PredefinedMenuItem.new({ item: "Separator" }));

    items.push(
      await CheckMenuItem.new({
        text: "Always on Top",
        checked: alwaysOnTop,
        action: () => toggleAlwaysOnTop(),
      })
    );

    items.push(
      await MenuItem.new({
        text: "Preferences...",
        action: () => openPreferences(),
      })
    );

    const menu = await Menu.new({ items });
    await menu.popup(new LogicalPosition(rect.left, rect.bottom));
  }

  return (
    <main className="container">
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left" data-tauri-drag-region>
          <button
            className="titlebar-btn hamburger-btn"
            onClick={showHamburgerMenu}
            title="Menu"
          >
            &#x2630;
          </button>
          <span className="titlebar-title" data-tauri-drag-region>Larmindon</span>
        </div>
        <div className="titlebar-right">
          <button
            className={`titlebar-btn pin-btn${alwaysOnTop ? " pinned" : ""}`}
            onClick={toggleAlwaysOnTop}
            title={alwaysOnTop ? "Unpin from top" : "Pin on top"}
          >
            &#x1F4CC;
          </button>
          {isRunning ? (
            <button className="titlebar-btn stop-indicator" onClick={handleStop} title="Stop transcription">
              &#x25CF;
            </button>
          ) : (
            <button
              className="titlebar-btn start-indicator"
              onClick={handleStart}
              disabled={devices.length === 0}
              title="Start transcription"
            >
              &#x25CF;
            </button>
          )}
          <button
            className="titlebar-btn titlebar-close"
            onClick={() => getCurrentWindow().close()}
            title="Close"
          >
            &#x2715;
          </button>
        </div>
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
