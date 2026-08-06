import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  apply,
  clear,
  createStore,
  renderText,
  type TranscriptUpdate,
} from "./transcriptStore";
import "./CaptionOverlay.css";

interface Settings {
  font_family: string;
  font_size_px: number;
}

const MAX_CAPTION_CHARS = 170;

function CaptionOverlay() {
  // Truncation is applied at render time only. The store keeps the full
  // transcript, so a segment can still be revised after its text has scrolled
  // out of the visible window.
  const store = useRef(createStore());
  const [version, bumpVersion] = useReducer((n: number) => n + 1, 0);
  const renderPending = useRef(false);
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

    const unlistenTranscription = listen<TranscriptUpdate>(
      "transcript-update",
      (event) => {
        if (apply(store.current, event.payload)) {
          scheduleRender();
        }
      },
    );

    const unlistenClearTranscript = listen("clear-transcript", () => {
      clear(store.current);
      scheduleRender();
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

  function scheduleRender() {
    if (renderPending.current) return;
    renderPending.current = true;
    requestAnimationFrame(() => {
      renderPending.current = false;
      bumpVersion();
    });
  }

  // Compact `[S1]` markers rather than the main window's block labels: the
  // overlay is a separate visual system with its own hardcoded light-on-scrim
  // styling and very little room.
  const caption = useMemo(() => {
    const full = renderText(store.current, {
      finalsOnly: false,
      speakerLabels: true,
    })
      .replace(/\[Speaker (\S+)\]/g, "[S$1]")
      .replace(/\s+/g, " ")
      .trimStart();
    return full.slice(Math.max(0, full.length - MAX_CAPTION_CHARS));
    // `version` is the only honest dep: text is appended in place to the last
    // turn, so neither the turn count nor the open-segment count changes on a
    // same-speaker append.
  }, [version]);

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
