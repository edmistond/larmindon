/**
 * Transcript state, kept outside React so high-rate updates do not re-render.
 *
 * Backends emit segments, not text: a segment may be revised repeatedly while
 * `is_final` is false, then finalized once. Finalized segments are folded into
 * speaker *turns* at ingest rather than kept as a list, because an append-only
 * backend emits one final segment per audio chunk — thousands over a long
 * session. Folding keeps that at one turn and one text node, matching what the
 * append-only string rendering used to produce.
 */

export interface TranscriptUpdate {
  segment_id: number;
  is_final: boolean;
  text: string;
  speaker: string | null;
}

export interface Turn {
  speaker: string | null;
  text: string;
}

export interface RecentFinal {
  segment_id: number;
  speaker: string | null;
  text: string;
}

export interface Store {
  /** Finalized text, folded by consecutive speaker. */
  turns: Turn[];
  /** Bounded segment history for low-cost caption rendering. */
  recentFinals: RecentFinal[];
  /** Segments still being revised, keyed by id, in arrival order. */
  open: Map<number, { speaker: string | null; text: string }>;
  /** Ids already folded, so a repeated final can never double-append. */
  folded: Set<number>;
  /** Ids below this are dropped; raised by clear() to defeat in-flight updates. */
  minAcceptedId: number;
  lastSeenId: number;
}

const MAX_RECENT_FINALS = 64;

export function createStore(): Store {
  return {
    turns: [],
    recentFinals: [],
    open: new Map(),
    folded: new Set(),
    minAcceptedId: 0,
    lastSeenId: 0,
  };
}

/**
 * Applies one update. Returns whether anything changed, so callers can skip
 * scheduling a render.
 */
export function apply(s: Store, u: TranscriptUpdate): boolean {
  if (u.segment_id < s.minAcceptedId) return false;
  if (u.segment_id > s.lastSeenId) s.lastSeenId = u.segment_id;

  if (!u.is_final) {
    const current = s.open.get(u.segment_id);
    if (current && current.speaker === u.speaker && current.text === u.text) {
      return false;
    }
    s.open.set(u.segment_id, { speaker: u.speaker, text: u.text });
    return true;
  }

  const wasOpen = s.open.delete(u.segment_id);
  // A segment finalizes at most once; this guards against a backend that
  // re-sends one anyway.
  if (s.folded.has(u.segment_id)) return false;
  s.folded.add(u.segment_id);

  // Finalizing with empty text retracts a segment that was shown provisionally
  // but produced nothing. Folding it would leave a blank turn behind.
  if (u.text === "") return wasOpen;

  s.recentFinals.push({
    segment_id: u.segment_id,
    speaker: u.speaker,
    text: u.text,
  });
  if (s.recentFinals.length > MAX_RECENT_FINALS) {
    s.recentFinals.splice(0, s.recentFinals.length - MAX_RECENT_FINALS);
  }

  const last = s.turns[s.turns.length - 1];
  if (last && last.speaker === u.speaker) {
    last.text += u.text;
  } else {
    s.turns.push({ speaker: u.speaker, text: u.text });
  }
  return true;
}

/**
 * Clears the transcript. Updates already in flight for the segment that was
 * open carry an id at or below `lastSeenId`, so raising the watermark past it
 * drops them instead of letting them repopulate a just-cleared view.
 */
export function clear(s: Store): void {
  s.turns = [];
  s.recentFinals = [];
  s.open.clear();
  s.folded.clear();
  s.minAcceptedId = s.lastSeenId + 1;
}

export interface CaptionSegment {
  segment_id: number;
  speaker: string | null;
  text: string;
  truncated: boolean;
}

/**
 * Returns only the newest caption fragments that fit the requested budget.
 *
 * This deliberately works backwards over bounded segment history instead of
 * serializing the complete transcript. Overlay rendering therefore stays
 * constant-cost even after a long transcription session.
 */
function tailCaptionSegments(
  segments: Array<{
    segment_id: number;
    speaker: string | null;
    text: string;
  }>,
  maxChars: number,
): CaptionSegment[] {
  if (maxChars <= 0) return [];

  const out: CaptionSegment[] = [];
  let remaining = maxChars;

  for (let i = segments.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const segment = segments[i];
    // Slice before normalizing so a pathological long segment cannot make the
    // overlay scan or allocate the complete segment on every update.
    const bounded =
      segment.text.length > remaining * 3
        ? segment.text.slice(-(remaining * 3))
        : segment.text;
    const normalized = bounded.replace(/\s+/g, " ");
    if (!normalized.trim()) continue;

    let text = normalized;
    let truncated = bounded.length < segment.text.length;
    if (text.length > remaining) {
      text = text.slice(-remaining);
      truncated = true;

      // Avoid beginning the visible window in the middle of a word when a
      // nearby boundary is available.
      const firstSpace = text.indexOf(" ");
      if (firstSpace > 0 && firstSpace < text.length - 1) {
        text = text.slice(firstSpace + 1);
      }
    }

    out.unshift({
      segment_id: segment.segment_id,
      speaker: segment.speaker,
      text,
      truncated,
    });
    remaining -= text.length;
    if (truncated) break;
  }

  return out;
}

export function settledCaptionSegments(
  s: Store,
  maxChars: number,
): CaptionSegment[] {
  return tailCaptionSegments(s.recentFinals, maxChars);
}

export function liveCaptionSegments(
  s: Store,
  maxChars: number,
): CaptionSegment[] {
  const open = Array.from(s.open, ([segment_id, segment]) => ({
    segment_id,
    ...segment,
  }));
  return tailCaptionSegments(open, maxChars);
}

/** The still-revising tail, as one string. */
export function openText(s: Store): string {
  let out = "";
  for (const seg of s.open.values()) out += seg.text;
  return out;
}

/**
 * Everything to draw, finalized turns then still-revising segments, as one
 * list. `breakBefore` marks where the speaker changes from the previous block,
 * which is where the rendering puts a line break.
 *
 * Turns are already folded by consecutive speaker, so adjacent turns always
 * differ and every turn boundary breaks. An unattributed stream — every speaker
 * `null`, which is what a backend without diarization produces — never breaks,
 * so it renders exactly as it always did.
 */
export interface Block {
  speaker: string | null;
  text: string;
  pending: boolean;
  breakBefore: boolean;
}

export function blocks(s: Store): Block[] {
  const out: Block[] = [];
  const push = (speaker: string | null, text: string, pending: boolean) => {
    out.push({
      speaker,
      text,
      pending,
      breakBefore: out.length > 0 && out[out.length - 1].speaker !== speaker,
    });
  };
  for (const turn of s.turns) push(turn.speaker, turn.text, false);
  for (const seg of s.open.values()) push(seg.speaker, seg.text, true);
  return out;
}

export interface RenderOptions {
  /** Exclude segments that are still being revised. */
  finalsOnly: boolean;
  /** Prefix each attributed turn with `[Speaker N]`. */
  speakerLabels: boolean;
}

/**
 * Serializes the transcript for copy/export.
 *
 * With one unattributed turn and no labels this reproduces exactly the string
 * the append-only implementation built, including the leading whitespace each
 * backend fragment carries.
 */
export function renderText(s: Store, opts: RenderOptions): string {
  const parts: string[] = [];
  for (const turn of s.turns) {
    const body = turn.text.trim();
    if (!body) continue;
    parts.push(
      opts.speakerLabels && turn.speaker !== null
        ? `[Speaker ${turn.speaker}] ${body}`
        : body,
    );
  }
  if (!opts.finalsOnly) {
    // Each open segment separately, so a tail spanning a turn boundary copies
    // with both speakers attributed rather than merged under one label.
    for (const seg of s.open.values()) {
      const body = seg.text.trim();
      if (!body) continue;
      parts.push(
        opts.speakerLabels && seg.speaker !== null
          ? `[Speaker ${seg.speaker}] ${body}`
          : body,
      );
    }
  }
  return parts.join("\n\n");
}
