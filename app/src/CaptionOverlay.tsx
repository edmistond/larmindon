import { useEffect, useMemo, useState, useRef, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./CaptionOverlay.css";

interface Settings {
  font_family: string;
  font_size_px: number;
}

interface TranscriptionUpdate {
  segment_id: number;
  text: string;
  is_final: boolean;
}

interface Segment {
  id: number;
  text: string;
  final: boolean;
}

const MAX_CAPTION_CHARS = 170;

/** Upsert the segment, then drop finalized segments from the front while the
 * remainder still covers the caption window. Non-final segments are never
 * dropped — they can still change. */
function applyUpdate(segments: Segment[], update: TranscriptionUpdate): Segment[] {
  let next: Segment[] | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].id === update.segment_id) {
      next = segments.slice();
      next[i] = { id: update.segment_id, text: update.text, final: update.is_final };
      break;
    }
  }
  if (!next) {
    next = [
      ...segments,
      { id: update.segment_id, text: update.text, final: update.is_final },
    ];
  }

  let total = next.reduce((n, s) => n + s.text.length, 0);
  let start = 0;
  while (
    start < next.length - 1 &&
    next[start].final &&
    total - next[start].text.length >= MAX_CAPTION_CHARS
  ) {
    total -= next[start].text.length;
    start++;
  }
  return start > 0 ? next.slice(start) : next;
}

function renderCaption(segments: Segment[]): string {
  const text = segments
    .map((s) => s.text)
    .join("")
    .replace(/\s+/g, " ")
    .trimStart();
  return text.slice(Math.max(0, text.length - MAX_CAPTION_CHARS));
}

function CaptionOverlay() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const minAcceptedIdRef = useRef(0);
  const lastSeenIdRef = useRef(-1);
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

    const unlistenTranscription = listen<TranscriptionUpdate>(
      "transcription-update",
      (event) => {
        if (event.payload.segment_id < minAcceptedIdRef.current) {
          return;
        }
        lastSeenIdRef.current = Math.max(
          lastSeenIdRef.current,
          event.payload.segment_id,
        );
        setSegments((prev) => applyUpdate(prev, event.payload));
      },
    );

    const unlistenClearTranscript = listen("clear-transcript", () => {
      minAcceptedIdRef.current = lastSeenIdRef.current + 1;
      setSegments([]);
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

  const caption = useMemo(() => renderCaption(segments), [segments]);

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
