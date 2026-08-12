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

export interface CaptionSegment {
  segment_id: number;
  is_final: boolean;
  speaker: string | null;
  text: string;
}

export interface Store {
  /** Finalized text, folded by consecutive speaker. */
  turns: Turn[];
  /** Bounded ordered stream used by the live caption overlay. */
  captions: CaptionSegment[];
  /** Segments still being revised, keyed by id, in arrival order. */
  open: Map<number, { speaker: string | null; text: string }>;
  /** Ids already folded, so a repeated final can never double-append. */
  folded: Set<number>;
  /** Ids below this are dropped; raised by clear() to defeat in-flight updates. */
  minAcceptedId: number;
  lastSeenId: number;
}

const MAX_CAPTION_SEGMENTS = 48;
const MAX_CAPTION_CHARS = 1500;

export function createStore(): Store {
  return {
    turns: [],
    captions: [],
    open: new Map(),
    folded: new Set(),
    minAcceptedId: 0,
    lastSeenId: 0,
  };
}

function upsertCaption(s: Store, update: TranscriptUpdate): void {
  const index = s.captions.findIndex(
    (segment) => segment.segment_id === update.segment_id,
  );
  const caption = {
    segment_id: update.segment_id,
    is_final: update.is_final,
    speaker: update.speaker,
    text: update.text,
  };

  if (index >= 0) {
    s.captions[index] = caption;
  } else {
    s.captions.push(caption);
  }

  let totalChars = s.captions.reduce(
    (sum, segment) => sum + segment.text.length,
    0,
  );
  while (
    s.captions.length > 1 &&
    (s.captions.length > MAX_CAPTION_SEGMENTS ||
      totalChars > MAX_CAPTION_CHARS)
  ) {
    // Never discard provisional speech just to satisfy the history budget.
    // The oldest finalized segment is the safest whole unit to retire.
    const removable = s.captions.findIndex((segment) => segment.is_final);
    if (removable < 0) break;
    totalChars -= s.captions[removable].text.length;
    s.captions.splice(removable, 1);
  }
}

function removeCaption(s: Store, segmentId: number): boolean {
  const index = s.captions.findIndex(
    (segment) => segment.segment_id === segmentId,
  );
  if (index < 0) return false;
  s.captions.splice(index, 1);
  return true;
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
    upsertCaption(s, u);
    return true;
  }

  const wasOpen = s.open.delete(u.segment_id);
  // A segment finalizes at most once; this guards against a backend that
  // re-sends one anyway.
  if (s.folded.has(u.segment_id)) return false;
  s.folded.add(u.segment_id);

  // Finalizing with empty text retracts a segment that was shown provisionally
  // but produced nothing. Folding it would leave a blank turn behind.
  if (u.text === "") return removeCaption(s, u.segment_id) || wasOpen;

  // Finalization updates the same caption entry that was already visible as a
  // provisional segment. Keeping its id and position is what prevents text
  // from jumping between separate live and settled regions.
  upsertCaption(s, u);

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
  s.captions = [];
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
