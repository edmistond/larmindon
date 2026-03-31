import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
}

const VALID_CHUNK_MS = [80, 160, 560, 1120];

function Preferences() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const s = await invoke<Settings>("get_settings");
      setSettings(s);
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

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
    setSaved(false);
  }

  if (!settings) {
    return <div className="prefs-container">Loading...</div>;
  }

  return (
    <div className="prefs-container">
      <h2>Preferences</h2>

      <div className="prefs-form">
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
          <input
            type="text"
            value={settings.font_family}
            onChange={(e) => update("font_family", e.target.value)}
            placeholder="Default system font"
            className="prefs-input"
          />
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
