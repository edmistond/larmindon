use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const VALID_CHUNK_MS: &[usize] = &[80, 160, 560, 1120];
const VALID_THEMES: &[&str] = &["light", "dark", "system"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub model_path: String,
    pub chunk_ms: usize,
    pub intra_threads: usize,
    pub inter_threads: usize,
    pub punctuation_reset: bool,
    pub empty_reset_threshold: u32,
    /// Font family for transcript display. Empty string = use default.
    pub font_family: String,
    /// Font size in px for transcript display. 0 = use default.
    pub font_size_px: u32,
    /// Theme mode: "light", "dark", or "system"
    pub theme_mode: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_path: "~/projects/prs-nemotron/".to_string(),
            chunk_ms: 560,
            intra_threads: 2,
            inter_threads: 1,
            punctuation_reset: true,
            empty_reset_threshold: 6,
            font_family: String::new(),
            font_size_px: 0,
            theme_mode: "dark".to_string(),
        }
    }
}

impl Settings {
    /// Returns the config directory: ~/.config/larmindon/
    pub fn config_dir() -> PathBuf {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("larmindon")
        } else {
            // Fallback for non-Unix or missing HOME
            PathBuf::from(".config").join("larmindon")
        }
    }

    fn settings_path() -> PathBuf {
        Self::config_dir().join("settings.json")
    }

    /// Load settings from disk, falling back to defaults on any error.
    pub fn load() -> Self {
        let path = Self::settings_path();
        match std::fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Settings>(&contents) {
                Ok(settings) => {
                    println!("Loaded settings from {}", path.display());
                    settings
                }
                Err(e) => {
                    eprintln!(
                        "Failed to parse settings from {}: {}. Using defaults.",
                        path.display(),
                        e
                    );
                    Self::default()
                }
            },
            Err(_) => {
                println!("No settings file at {}, using defaults.", path.display());
                Self::default()
            }
        }
    }

    /// Save settings to disk, creating the config directory if needed.
    pub fn save(&self) -> Result<(), String> {
        if let Err(e) = self.validate() {
            return Err(e);
        }

        let dir = Self::config_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir {}: {}", dir.display(), e))?;

        let path = Self::settings_path();
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write settings to {}: {}", path.display(), e))?;

        println!("Settings saved to {}", path.display());
        Ok(())
    }

    /// Apply environment variable overrides on top of the current settings.
    /// Priority: env var > saved setting > default.
    pub fn with_env_overrides(mut self) -> Self {
        if let Ok(val) = std::env::var("CHUNK_MS") {
            if let Ok(ms) = val.parse::<usize>() {
                if VALID_CHUNK_MS.contains(&ms) {
                    println!("Using CHUNK_MS={ms}ms from environment");
                    self.chunk_ms = ms;
                } else {
                    eprintln!(
                        "Invalid CHUNK_MS={ms}; must be one of {:?}. Keeping saved value {}ms.",
                        VALID_CHUNK_MS, self.chunk_ms
                    );
                }
            } else {
                eprintln!("Could not parse CHUNK_MS={val:?}. Keeping saved value.");
            }
        }

        if let Ok(val) = std::env::var("INTRA_THREADS") {
            match val.parse::<usize>() {
                Ok(n) if n >= 1 => {
                    println!("Using INTRA_THREADS={n} from environment");
                    self.intra_threads = n;
                }
                _ => eprintln!("Invalid INTRA_THREADS={val:?}, keeping saved value."),
            }
        }

        if let Ok(val) = std::env::var("INTER_THREADS") {
            match val.parse::<usize>() {
                Ok(n) if n >= 1 => {
                    println!("Using INTER_THREADS={n} from environment");
                    self.inter_threads = n;
                }
                _ => eprintln!("Invalid INTER_THREADS={val:?}, keeping saved value."),
            }
        }

        if let Ok(val) = std::env::var("PUNCTUATION_RESET") {
            match val.to_lowercase().as_str() {
                "0" | "false" | "no" => {
                    println!(
                        "Punctuation-based decoder reset DISABLED via PUNCTUATION_RESET={val}"
                    );
                    self.punctuation_reset = false;
                }
                "1" | "true" | "yes" => {
                    println!("Punctuation-based decoder reset ENABLED via PUNCTUATION_RESET={val}");
                    self.punctuation_reset = true;
                }
                _ => eprintln!("Unknown PUNCTUATION_RESET={val:?}, keeping saved value."),
            }
        }

        self
    }

    /// Validate that settings values are within acceptable ranges.
    pub fn validate(&self) -> Result<(), String> {
        if !VALID_CHUNK_MS.contains(&self.chunk_ms) {
            return Err(format!(
                "Invalid chunk_ms {}; must be one of {:?}",
                self.chunk_ms, VALID_CHUNK_MS
            ));
        }
        if self.intra_threads < 1 {
            return Err("intra_threads must be at least 1".to_string());
        }
        if self.inter_threads < 1 {
            return Err("inter_threads must be at least 1".to_string());
        }
        if self.empty_reset_threshold < 1 {
            return Err("empty_reset_threshold must be at least 1".to_string());
        }
        if self.model_path.trim().is_empty() {
            return Err("model_path cannot be empty".to_string());
        }
        if !VALID_THEMES.contains(&self.theme_mode.as_str()) {
            return Err(format!(
                "Invalid theme_mode '{}'; must be one of {:?}",
                self.theme_mode, VALID_THEMES
            ));
        }

        // Warn (but don't error) if model path doesn't exist
        let expanded = expand_tilde(&self.model_path);
        if !expanded.exists() {
            eprintln!("Warning: model path {} does not exist", expanded.display());
        }

        Ok(())
    }
}

/// Expand tilde (~) to home directory in a path
pub fn expand_tilde(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(&path[2..]);
        }
    }
    PathBuf::from(path)
}

/// Convert a chunk duration in milliseconds to samples at 16kHz.
pub fn chunk_ms_to_samples(ms: usize) -> usize {
    16000 * ms / 1000
}
