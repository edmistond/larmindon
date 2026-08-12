import {
  useEffect,
  useLayoutEffect,
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
  type CaptionSegment,
  type TranscriptUpdate,
} from "./transcriptStore";
import "./CaptionOverlay.css";

interface Settings {
  font_family: string;
  font_size_px: number;
}

const OVERLAY_RENDER_INTERVAL_MS = 80;

interface CaptionTurn {
  key: number;
  speaker: string | null;
  segments: CaptionSegment[];
}

function groupCaptionTurns(segments: CaptionSegment[]): CaptionTurn[] {
  const turns: CaptionTurn[] = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;

    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.segments.push(segment);
    } else {
      turns.push({
        key: segment.segment_id,
        speaker: segment.speaker,
        segments: [segment],
      });
    }
  }
  return turns;
}

function CaptionTurns({ turns }: { turns: CaptionTurn[] }) {
  return turns.map((turn) => (
    <div className="caption-turn" key={turn.key}>
      {turn.speaker !== null && (
        <span className="caption-speaker">[S{turn.speaker}] </span>
      )}
      {turn.segments.map((segment, index) => (
        <span
          className={`caption-segment${segment.is_final ? "" : " pending"}`}
          data-final={segment.is_final}
          key={segment.segment_id}
        >
          {index === 0 ? segment.text.trimStart() : segment.text}
        </span>
      ))}
    </div>
  ));
}

function CaptionOverlay() {
  // Caption history is bounded by whole segments in the store. Provisional
  // segments remain in that same ordered stream when they finalize, so text
  // never has to jump between separate live and settled regions.
  const store = useRef(createStore());
  const [version, bumpVersion] = useReducer((n: number) => n + 1, 0);
  const renderTimer = useRef<number | null>(null);
  const lastRenderAt = useRef(0);
  const captionTextRef = useRef<HTMLDivElement>(null);
  const captionViewportRef = useRef<HTMLDivElement>(null);
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

  const captionTurns = useMemo(
    () => groupCaptionTurns(store.current.captions),
    [version],
  );

  const textStyle = useMemo(
    () => ({
      ...(fontSettings.font_family ? { fontFamily: fontSettings.font_family } : {}),
      ...(fontSettings.font_size_px > 0
        ? { fontSize: `${Math.max(fontSettings.font_size_px, 22)}px` }
        : {}),
    }),
    [fontSettings],
  );

  useLayoutEffect(() => {
    const container = captionTextRef.current;
    const viewport = captionViewportRef.current;
    if (!container || !viewport) return;

    const fitWholeLines = () => {
      const style = window.getComputedStyle(container);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const availableHeight =
        container.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

      const visibleLines = Math.max(
        1,
        Math.floor((availableHeight + 0.5) / lineHeight),
      );
      viewport.style.height = `${visibleLines * lineHeight}px`;
    };

    fitWholeLines();
    const observer = new ResizeObserver(fitWholeLines);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fontSettings]);

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

  const hasCaption = captionTurns.length > 0;

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
      <div className="caption-text" ref={captionTextRef} style={textStyle}>
        <div className="caption-viewport" ref={captionViewportRef}>
          <div className="caption-flow">
            {hasCaption ? (
              <CaptionTurns turns={captionTurns} />
            ) : (
              <span className="caption-placeholder">Listening...</span>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default CaptionOverlay;
