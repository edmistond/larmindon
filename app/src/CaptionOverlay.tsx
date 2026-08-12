import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  apply,
  clear,
  createStore,
  liveCaptionSegments,
  settledCaptionSegments,
  type CaptionSegment,
  type TranscriptUpdate,
} from "./transcriptStore";
import "./CaptionOverlay.css";

interface Settings {
  font_family: string;
  font_size_px: number;
}

const MAX_SETTLED_CAPTION_CHARS = 110;
const MAX_LIVE_CAPTION_CHARS = 80;
const OVERLAY_RENDER_INTERVAL_MS = 80;

function CaptionSegments({ segments }: { segments: CaptionSegment[] }) {
  let previousSpeaker: string | null | undefined;

  return segments.map((segment, index) => {
    const showSpeaker =
      segment.speaker !== null &&
      (index === 0 || segment.speaker !== previousSpeaker);
    previousSpeaker = segment.speaker;

    return (
      <span className="caption-segment" key={segment.segment_id}>
        {showSpeaker && (
          <span className="caption-speaker">[S{segment.speaker}] </span>
        )}
        {segment.truncated && <span aria-hidden="true">&hellip;</span>}
        {segment.text}
      </span>
    );
  });
}

function CaptionOverlay() {
  // Truncation is applied at render time only. The store keeps the full
  // transcript, so a segment can still be revised after its text has scrolled
  // out of the visible window.
  const store = useRef(createStore());
  const [version, bumpVersion] = useReducer((n: number) => n + 1, 0);
  const renderTimer = useRef<number | null>(null);
  const lastRenderAt = useRef(0);
  const [interactive, setInteractive] = useState(true);
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

    const unlistenInteraction = listen<boolean>(
      "overlay-interaction-changed",
      (event) => setInteractive(event.payload),
    );

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenClearTranscript.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      unlistenInteraction.then((fn) => fn());
      if (renderTimer.current !== null) {
        window.clearTimeout(renderTimer.current);
      }
    };
  }, []);

  function scheduleRender() {
    if (renderTimer.current !== null) return;

    const elapsed = performance.now() - lastRenderAt.current;
    const delay = Math.max(0, OVERLAY_RENDER_INTERVAL_MS - elapsed);
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      lastRenderAt.current = performance.now();
      bumpVersion();
    }, delay);
  }

  const captions = useMemo(() => {
    return {
      settled: settledCaptionSegments(
        store.current,
        MAX_SETTLED_CAPTION_CHARS,
      ),
      live: liveCaptionSegments(store.current, MAX_LIVE_CAPTION_CHARS),
    };
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
    event.preventDefault();
    event.stopPropagation();
    await getCurrentWindow().startDragging();
  }

  async function lockOverlay() {
    try {
      await invoke("set_caption_overlay_interactive", { interactive: false });
      setInteractive(false);
    } catch (error) {
      console.error("Failed to lock caption overlay", error);
      setInteractive(true);
    }
  }

  const hasCaption = captions.settled.length > 0 || captions.live.length > 0;
  const hasLiveCaption = captions.live.length > 0;

  return (
    <main className="overlay-shell" data-interactive={interactive}>
      {interactive && (
        <div className="overlay-toolbar" aria-label="Overlay placement controls">
          <button
            className="overlay-drag-handle"
            type="button"
            onMouseDown={startDragging}
            title="Drag to position the overlay"
          >
            Move
          </button>
          <button
            className="overlay-lock-button"
            type="button"
            onClick={lockOverlay}
            title="Lock the overlay and pass clicks through to the game"
          >
            Lock
          </button>
        </div>
      )}
      <div className="caption-text" style={textStyle}>
        <div
          className={`caption-stack${hasLiveCaption ? " has-live" : ""}`}
        >
          <div className="caption-row caption-settled">
            <div className="caption-row-inner">
              {hasCaption ? (
                <CaptionSegments segments={captions.settled} />
              ) : (
                <span className="caption-placeholder">Listening...</span>
              )}
            </div>
          </div>
          {hasLiveCaption && (
            <div className="caption-row caption-live">
              <div className="caption-row-inner">
                <CaptionSegments segments={captions.live} />
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default CaptionOverlay;
