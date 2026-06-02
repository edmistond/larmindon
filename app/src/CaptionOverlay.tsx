import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./CaptionOverlay.css";

interface Settings {
  font_family: string;
  font_size_px: number;
}

const MAX_CAPTION_CHARS = 170;

function CaptionOverlay() {
  const [caption, setCaption] = useState("");
  const [fontSettings, setFontSettings] = useState<Settings>({
    font_family: "",
    font_size_px: 0,
  });

  useEffect(() => {
    const cached = localStorage.getItem("larmindon_settings");
    if (cached) {
      try {
        const settings = JSON.parse(cached) as Settings;
        setFontSettings({
          font_family: settings.font_family,
          font_size_px: settings.font_size_px,
        });
      } catch {
        // Keep defaults if cached settings are stale or malformed.
      }
    }

    const unlistenTranscription = listen<{ text: string }>(
      "transcription",
      (event) => {
        setCaption((prev) => {
          const next = `${prev}${event.payload.text}`.replace(/\s+/g, " ").trimStart();
          return next.slice(Math.max(0, next.length - MAX_CAPTION_CHARS));
        });
      },
    );

    const unlistenClearTranscript = listen("clear-transcript", () => {
      setCaption("");
    });

    const unlistenSettings = listen<Settings>("settings-changed", (event) => {
      setFontSettings({
        font_family: event.payload.font_family,
        font_size_px: event.payload.font_size_px,
      });
    });

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenClearTranscript.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
    };
  }, []);

  const textStyle = useMemo(
    () => ({
      ...(fontSettings.font_family ? { fontFamily: fontSettings.font_family } : {}),
      ...(fontSettings.font_size_px > 0
        ? { fontSize: `${Math.max(fontSettings.font_size_px, 22)}px` }
        : {}),
    }),
    [fontSettings],
  );

  async function startDragging(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    await getCurrentWindow().startDragging();
  }

  return (
    <main className="overlay-shell" onMouseDown={startDragging}>
      <div className="caption-text" style={textStyle}>
        <div className="caption-text-inner">
          {caption || <span className="caption-placeholder">Listening...</span>}
        </div>
      </div>
    </main>
  );
}

export default CaptionOverlay;
