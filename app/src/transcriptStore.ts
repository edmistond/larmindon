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

export interface Store {
  /** Finalized text, folded by consecutive speaker. */
  turns: Turn[];
  /** Segments still being revised, keyed by id, in arrival order. */
  open: Map<number, { speaker: string | null; text: string }>;
  /** Ids already folded, so a repeated final can never double-append. */
  folded: Set<number>;
  /** Ids below this are dropped; raised by clear() to defeat in-flight updates. */
  minAcceptedId: number;
  lastSeenId: number;
}

export function createStore(): Store {
  return {
    turns: [],
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
  s.open.clear();
  s.folded.clear();
  s.minAcceptedId = s.lastSeenId + 1;
}

/** The still-revising tail, as one string. */
export function openText(s: Store): string {
  let out = "";
  for (const seg of s.open.values()) out += seg.text;
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
    const tail = openText(s).trim();
    if (tail) parts.push(tail);
  }
  return parts.join("\n\n");
}
