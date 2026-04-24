import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./Preferences.css";

interface Settings {
  model_path: string;
  chunk_ms: number;
  intra_threads: number;
  inter_threads: number;
  punctuation_reset: boolean;
  empty_reset_threshold: number;
  font_family: string;
  font_size_px: number;
  theme_mode: string;
  vad_threshold_start: number;
  vad_threshold_end: number;
  diagnostics_enabled: boolean;
  diagnostics_db_path: string;
  agc_enabled: boolean;
  agc_target_rms_dbfs: number;
  agc_max_gain_db: number;
  agc_attack_ms: number;
  agc_release_ms: number;
}

const VALID_CHUNK_MS = [80, 160, 560, 1120];
const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

function Preferences() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [fontFilter, setFontFilter] = useState("");
  const [isLoadingFonts, setIsLoadingFonts] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [agcOpen, setAgcOpen] = useState(false);

  useEffect(() => {
    loadSettings();
    loadFonts();

    // Listen for settings changes from other windows
    const unlisten = listen<Settings>("settings-changed", async (event) => {
      setSettings(event.payload);
      localStorage.setItem('larmindon_settings', JSON.stringify(event.payload));
      await applyTheme(event.payload.theme_mode);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function loadFonts() {
    setIsLoadingFonts(true);
    try {
      const fonts = await invoke<string[]>("get_system_fonts");
      setAvailableFonts(fonts);
    } catch (e) {
      console.error("Failed to load fonts:", e);
      // Fallback to a minimal set if the backend fails
      setAvailableFonts(["Arial", "Helvetica", "Times New Roman", "Courier New", "Georgia", "Verdana"]);
    } finally {
      setIsLoadingFonts(false);
    }
  }

  async function applyTheme(themeMode: string) {
    let effectiveTheme = themeMode;
    
    if (themeMode === "system") {
      // Detect system theme via media query (frontend)
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      effectiveTheme = prefersDark ? "dark" : "light";
    }
    
    // Apply theme to document
    document.documentElement.setAttribute("data-theme", effectiveTheme);
  }

  async function loadSettings() {
    try {
      const s = await invoke<Settings>("get_settings");
      setSettings(s);
      // Cache settings for immediate access on next load
      localStorage.setItem('larmindon_settings', JSON.stringify(s));
      await applyTheme(s.theme_mode);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await invoke("save_settings", { newSettings: settings });
      // Also save to localStorage for immediate access on next load
      localStorage.setItem('larmindon_settings', JSON.stringify(settings));
      await applyTheme(settings.theme_mode);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    try {
      const defaults = await invoke<Settings>("get_default_settings");
      setSettings(defaults);
      setError("");
      setSaved(false);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleCancel() {
    getCurrentWebviewWindow().close();
  }

  async function handleBrowseModel() {
    const selected = await open({
      directory: true,
      title: "Select Model Directory",
    });
    if (selected) {
      setSettings((s) => (s ? { ...s, model_path: selected } : s));
      setSaved(false);
    }
  }

  async function handleBrowseDiagDb() {
    const selected = await save({
      title: "Diagnostic Database Path",
      defaultPath: settings?.diagnostics_db_path || undefined,
      filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }],
    });
    if (selected) {
      setSettings((s) => (s ? { ...s, diagnostics_db_path: selected } : s));
      setSaved(false);
    }
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
    setSaved(false);
  }

  // Filter fonts based on search input
  const filteredFonts = fontFilter.trim() === ""
    ? availableFonts
    : availableFonts.filter(font =>
        font.toLowerCase().includes(fontFilter.toLowerCase())
      );

  if (!settings) {
    return <div className="prefs-container">Loading...</div>;
  }

  return (
    <div className="prefs-container">
      <h2>Preferences</h2>

      <div className="prefs-form">
        <label className="prefs-label">
          Theme
          <select
            value={settings.theme_mode}
            onChange={(e) => update("theme_mode", e.target.value)}
            className="prefs-select"
          >
            {THEME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="prefs-label">
          Model Path
          <div className="prefs-row">
            <input
              type="text"
              value={settings.model_path}
              onChange={(e) => update("model_path", e.target.value)}
              className="prefs-input prefs-input-wide"
            />
            <button className="prefs-browse-btn" onClick={handleBrowseModel}>
              Browse...
            </button>
          </div>
        </label>

        <label className="prefs-label">
          Chunk Size (ms)
          <select
            value={settings.chunk_ms}
            onChange={(e) => update("chunk_ms", Number(e.target.value))}
            className="prefs-select"
          >
            {VALID_CHUNK_MS.map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms
              </option>
            ))}
          </select>
        </label>

        <label className="prefs-label">
          Intra-op Threads
          <input
            type="number"
            min={1}
            max={32}
            value={settings.intra_threads}
            onChange={(e) =>
              update("intra_threads", Math.max(1, Number(e.target.value)))
            }
            className="prefs-input prefs-input-narrow"
          />
        </label>

        <label className="prefs-label">
          Inter-op Threads
          <input
            type="number"
            min={1}
            max={32}
            value={settings.inter_threads}
            onChange={(e) =>
              update("inter_threads", Math.max(1, Number(e.target.value)))
            }
            className="prefs-input prefs-input-narrow"
          />
        </label>

        <label className="prefs-label prefs-checkbox-label">
          <input
            type="checkbox"
            checked={settings.punctuation_reset}
            onChange={(e) => update("punctuation_reset", e.target.checked)}
          />
          Punctuation-based decoder reset
        </label>

        <label className="prefs-label">
          Empty chunk reset threshold
          <input
            type="number"
            min={1}
            max={50}
            value={settings.empty_reset_threshold}
            onChange={(e) =>
              update(
                "empty_reset_threshold",
                Math.max(1, Number(e.target.value)),
              )
            }
            className="prefs-input prefs-input-narrow"
          />
        </label>
        <label className="prefs-label">
          Transcript Font
          <div className="font-picker">
            <input
              type="text"
              value={fontFilter}
              onChange={(e) => setFontFilter(e.target.value)}
              placeholder="Search fonts..."
              className="prefs-input font-filter"
              disabled={isLoadingFonts}
            />
            <select
              value={settings.font_family}
              onChange={(e) => update("font_family", e.target.value)}
              className="prefs-select font-select"
              size={Math.min(8, filteredFonts.length + 1)}
              disabled={isLoadingFonts}
            >
              <option value="">Default system font</option>
              {filteredFonts.map((font) => (
                <option 
                  key={font} 
                  value={font}
                  style={{ fontFamily: font }}
                >
                  {font}
                </option>
              ))}
            </select>
            {isLoadingFonts && <span className="font-loading">Loading fonts...</span>}
          </div>
        </label>

        <label className="prefs-label">
          Transcript Font Size (px)
          <input
            type="number"
            min={0}
            max={72}
            value={settings.font_size_px}
            onChange={(e) =>
              update("font_size_px", Math.max(0, Number(e.target.value)))
            }
            placeholder="0 = default"
            className="prefs-input prefs-input-narrow"
          />
        </label>
      </div>

      <div className="prefs-form">
        <label className="prefs-label prefs-checkbox-label">
          <input
            type="checkbox"
            checked={settings.diagnostics_enabled}
            onChange={(e) => update("diagnostics_enabled", e.target.checked)}
          />
          Save diagnostic data
        </label>

        <label className="prefs-label">
          Diagnostic Database Path
          <div className="prefs-row">
            <input
              type="text"
              value={settings.diagnostics_db_path}
              onChange={(e) => update("diagnostics_db_path", e.target.value)}
              disabled={!settings.diagnostics_enabled}
              className="prefs-input prefs-input-wide"
            />
            <button
              className="prefs-browse-btn"
              onClick={handleBrowseDiagDb}
              disabled={!settings.diagnostics_enabled}
            >
              Browse...
            </button>
          </div>
        </label>
      </div>

      <div className="prefs-advanced">
        <button
          type="button"
          className="prefs-advanced-toggle"
          onClick={() => setAgcOpen(!agcOpen)}
        >
          <span className={`prefs-advanced-arrow ${agcOpen ? "open" : ""}`}>▶</span>
          AGC Settings
        </button>
        {agcOpen && (
          <div className="prefs-advanced-content">
            <label className="prefs-label prefs-checkbox-label">
              <input
                type="checkbox"
                checked={settings.agc_enabled}
                onChange={(e) => update("agc_enabled", e.target.checked)}
              />
              Enable Automatic Gain Control
            </label>
            <label className="prefs-label">
              Target RMS (dBFS)
              <input
                type="number"
                min={-60}
                max={0}
                step={1}
                value={settings.agc_target_rms_dbfs}
                onChange={(e) =>
                  update(
                    "agc_target_rms_dbfs",
                    Math.min(0, Math.max(-60, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
            <label className="prefs-label">
              Max gain (dB)
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={settings.agc_max_gain_db}
                onChange={(e) =>
                  update(
                    "agc_max_gain_db",
                    Math.min(60, Math.max(0, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
            <label className="prefs-label">
              Attack (ms)
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={settings.agc_attack_ms}
                onChange={(e) =>
                  update(
                    "agc_attack_ms",
                    Math.min(1000, Math.max(1, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
            <label className="prefs-label">
              Release (ms)
              <input
                type="number"
                min={1}
                max={5000}
                step={10}
                value={settings.agc_release_ms}
                onChange={(e) =>
                  update(
                    "agc_release_ms",
                    Math.min(5000, Math.max(1, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
          </div>
        )}
      </div>

      <div className="prefs-advanced">
        <button
          type="button"
          className="prefs-advanced-toggle"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <span className={`prefs-advanced-arrow ${advancedOpen ? "open" : ""}`}>▶</span>
          VAD Settings
        </button>
        {advancedOpen && (
          <div className="prefs-advanced-content">
            <label className="prefs-label">
              VAD speech start threshold
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.vad_threshold_start}
                onChange={(e) =>
                  update(
                    "vad_threshold_start",
                    Math.min(1, Math.max(0, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
            <label className="prefs-label">
              VAD speech end threshold
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.vad_threshold_end}
                onChange={(e) =>
                  update(
                    "vad_threshold_end",
                    Math.min(1, Math.max(0, Number(e.target.value))),
                  )
                }
                className="prefs-input prefs-input-narrow"
              />
            </label>
          </div>
        )}
      </div>

      <p className="prefs-note">
        Engine settings take effect on next Start. Font changes apply on save.
      </p>

      {error && <p className="prefs-error">{error}</p>}
      {saved && <p className="prefs-saved">Settings saved.</p>}

      <div className="prefs-actions">
        <button className="prefs-btn prefs-btn-reset" onClick={handleReset}>
          Reset to Defaults
        </button>
        <div className="prefs-actions-right">
          <button className="prefs-btn prefs-btn-cancel" onClick={handleCancel}>
            Cancel
          </button>
          <button
            className="prefs-btn prefs-btn-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Preferences;
