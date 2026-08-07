import { useState, useEffect, useRef, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  apply,
  blocks,
  clear,
  createStore,
  renderText,
  type TranscriptUpdate,
} from "./transcriptStore";
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
  asr_provider: string;
}

/**
 * Display name and, more importantly, whether audio leaves this machine.
 *
 * `remote` drives the styling, because the question this affordance exists to
 * answer at a glance is "is what I am about to say going to a third party?" —
 * not "which model is it?".
 */
const PROVIDER_INFO: Record<string, { label: string; remote: boolean }> = {
  nemotron: { label: "Local", remote: false },
  soniox: { label: "Soniox", remote: true },
};

function providerInfo(id: string) {
  // An unknown provider is reported as remote. If a future backend is not
  // wired in here, claiming it is local would be the dangerous way to be wrong.
  return PROVIDER_INFO[id] ?? { label: id || "Unknown", remote: true };
}

interface AudioLevel {
  level: number;
  vad_active: boolean;
}

function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  // The store lives in a ref and renders are coalesced to one per frame, for
  // the same reason the audio meter bypasses React: a revising backend can emit
  // far faster than the display needs.
  const store = useRef(createStore());
  const [, bumpVersion] = useReducer((n: number) => n + 1, 0);
  const renderPending = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const audioMeterRef = useRef<HTMLDivElement>(null);
  const audioMeterFillRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [fontSettings, setFontSettings] = useState<Settings>({
    font_family: "",
    font_size_px: 0,
    theme_mode: "dark",
    asr_provider: "nemotron",
  });
  /**
   * The provider the *running* session actually started with.
   *
   * Not the configured one: engine settings only take effect on the next Start,
   * so a provider changed mid-session would otherwise make this label claim
   * audio is staying local while it is still streaming to a third party. Null
   * when idle, where the configured provider is the honest answer because it is
   * what the next Start will use.
   */
  const [runningProvider, setRunningProvider] = useState<string | null>(null);

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

    const unlistenTranscription = listen<TranscriptUpdate>(
      "transcript-update",
      (event) => {
        if (apply(store.current, event.payload)) {
          scheduleTranscriptRender();
        }
        setError("");
      }
    );

    const unlistenError = listen<{ text: string }>(
      "transcription-error",
      (event) => {
        setError(event.payload.text);
        setIsRunning(false);
        // A fatal ends the session, so the pinned provider has to clear here
        // too, or the label goes on claiming a remote session is live.
        setRunningProvider(null);
        resetAudioMeter();
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
      clear(store.current);
      scheduleTranscriptRender();
    });

    // Reads the ref rather than state: this effect has empty deps, so any
    // state captured here would be permanently stale. Serializing from the
    // store also keeps interim text and speaker labels out of the clipboard.
    const unlistenCopyTranscript = listen("copy-transcript", () => {
      const text = renderText(store.current, {
        finalsOnly: true,
        speakerLabels: true,
      });
      if (text) {
        navigator.clipboard.writeText(text);
      }
    });

    const unlistenOpenPreferences = listen("open-preferences", () => {
      openPreferences();
    });

    // Meter updates bypass React state so 20 Hz audio events do not re-render
    // the transcript or controls. The fill uses a compositor-friendly scale.
    const unlistenAudioLevel = listen<AudioLevel>("audio-level", (event) => {
      const level = Math.max(0, Math.min(1, event.payload.level));
      if (audioMeterFillRef.current) {
        audioMeterFillRef.current.style.transform = `scaleX(${level})`;
      }
      if (audioMeterRef.current) {
        audioMeterRef.current.dataset.vad = String(event.payload.vad_active);
        audioMeterRef.current.setAttribute("aria-valuenow", String(Math.round(level * 100)));
      }
    });

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenDevicesChanged.then((fn) => fn());
      unlistenSourceSwitched.then((fn) => fn());
      unlistenClearTranscript.then((fn) => fn());
      unlistenCopyTranscript.then((fn) => fn());
      unlistenOpenPreferences.then((fn) => fn());
      unlistenAudioLevel.then((fn) => fn());
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
        asr_provider: s.asr_provider,
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
        asr_provider: event.payload.asr_provider,
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

  /**
   * Coalesces any number of updates within one frame into a single render, and
   * does the scroll-to-bottom in the same callback so the layout-forcing
   * `scrollHeight` read happens at most once per frame rather than once per
   * update.
   */
  function scheduleTranscriptRender() {
    if (renderPending.current) return;
    renderPending.current = true;
    requestAnimationFrame(() => {
      renderPending.current = false;
      bumpVersion();
      const el = transcriptRef.current;
      if (el && stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

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
    // Tall enough that Save stays above the fold with the provider section
    // expanded.
    const height = 560;

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
    resetAudioMeter();
    try {
      await invoke("start_transcription", {
        deviceId: selectedDevice || null,
      });
      // Pinned here, after the engine has accepted the session, so the label
      // reports where audio is actually going rather than where it would go if
      // restarted now.
      setRunningProvider(fontSettings.asr_provider);
      setIsRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_transcription");
      setIsRunning(false);
      setRunningProvider(null);
      resetAudioMeter();
    } catch (e) {
      setError(String(e));
    }
  }

  function resetAudioMeter() {
    if (audioMeterFillRef.current) {
      audioMeterFillRef.current.style.transform = "scaleX(0)";
    }
    if (audioMeterRef.current) {
      audioMeterRef.current.dataset.vad = "false";
      audioMeterRef.current.setAttribute("aria-valuenow", "0");
    }
  }

  // Read straight from the store; `bumpVersion` is what re-runs this render.
  const visible = blocks(store.current);
  const hasTranscript = visible.length > 0;
  // While running this is the session's provider, not the configured one.
  const provider = providerInfo(runningProvider ?? fontSettings.asr_provider);

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
        {hasTranscript ? (
          <>
            {/* No literal spaces between these children: the container is
                white-space: pre-wrap, so a same-line gap would render as a
                real space. Newline-separated JSX is stripped and is safe. */}
            {visible.map((block, i) => (
              <span
                key={i}
                className={
                  [
                    block.speaker === null ? "" : "turn",
                    block.pending ? "transient" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                data-speaker={block.speaker ?? undefined}
              >
                {/* A literal newline, not a margin: the container is
                    white-space: pre-wrap and these spans are inline, so this is
                    what actually breaks the line. */}
                {block.breakBefore && "\n"}
                {block.speaker !== null && (
                  <span className="speaker-tag">{`[S${block.speaker}] `}</span>
                )}
                {i === 0 || block.breakBefore || block.speaker !== null
                  ? block.text.trimStart()
                  : block.text}
              </span>
            ))}
          </>
        ) : (
          <span className="placeholder">
            {isRunning
              ? "Listening..."
              : "Select an audio source and press Start"}
          </span>
        )}
      </div>

      <div className="audio-status" data-running={isRunning}>
        <div className="audio-status-label">
          <span className="audio-status-dot" aria-hidden="true" />
          <span className="provider-tag" data-remote={provider.remote}>
            {`(${provider.label})`}
          </span>
          <span>{isRunning ? "Listening" : "Idle"}</span>
        </div>
        <div
          className="audio-meter"
          ref={audioMeterRef}
          data-vad="false"
          role="meter"
          aria-label="Input audio level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <div className="audio-meter-fill" ref={audioMeterFillRef} />
        </div>
      </div>
    </main>
  );
}

export default App;
