import { describe, expect, it } from "vitest";
import {
  apply,
  blocks,
  clear,
  createStore,
  openText,
  renderText,
  type TranscriptUpdate,
} from "./transcriptStore";

function final(
  id: number,
  text: string,
  speaker: string | null = null,
): TranscriptUpdate {
  return { segment_id: id, is_final: true, text, speaker };
}

function interim(
  id: number,
  text: string,
  speaker: string | null = null,
): TranscriptUpdate {
  return { segment_id: id, is_final: false, text, speaker };
}

describe("append-only compatibility", () => {
  // The guarantee that the on-device backend looks exactly as it did before
  // segments existed: every update final, every speaker null.
  it("folds an all-final unattributed stream into exactly one turn", () => {
    const s = createStore();
    const chunks = [" The", " quick brown", " fox jumps over", " the laz", "y dog"];
    chunks.forEach((text, i) => apply(s, final(i + 1, text)));

    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].speaker).toBeNull();
    expect(s.turns[0].text).toBe(chunks.join(""));
  });

  it("copies as the same text the old string concatenation produced", () => {
    const s = createStore();
    [" Hello", " there", " friend"].forEach((t, i) => apply(s, final(i + 1, t)));

    expect(renderText(s, { finalsOnly: true, speakerLabels: true })).toBe(
      "Hello there friend",
    );
  });
});

describe("revision", () => {
  it("replaces an open segment rather than appending to it", () => {
    const s = createStore();
    apply(s, interim(1, "How"));
    apply(s, interim(1, "How are"));
    apply(s, interim(1, "How are you"));

    expect(openText(s)).toBe("How are you");
    expect(s.turns).toHaveLength(0);
  });

  it("moves a segment from open to folded when it finalizes", () => {
    const s = createStore();
    apply(s, interim(1, "How are yo"));
    apply(s, final(1, "How are you?"));

    expect(openText(s)).toBe("");
    expect(s.turns).toEqual([{ speaker: null, text: "How are you?" }]);
  });

  it("ignores a repeated final for an already folded segment", () => {
    const s = createStore();
    apply(s, final(1, "once"));
    const changed = apply(s, final(1, "once"));

    expect(changed).toBe(false);
    expect(s.turns[0].text).toBe("once");
  });

  it("retracts a provisional segment that finalizes empty", () => {
    const s = createStore();
    apply(s, interim(1, "false start"));
    apply(s, final(1, ""));

    expect(openText(s)).toBe("");
    expect(s.turns).toHaveLength(0);
  });

  it("keeps finalized text while a later segment is still revising", () => {
    const s = createStore();
    apply(s, final(1, "Settled."));
    apply(s, interim(2, " still moving"));

    expect(s.turns[0].text).toBe("Settled.");
    expect(openText(s)).toBe(" still moving");
  });
});

describe("speaker turns", () => {
  it("starts a new turn only when the speaker changes", () => {
    const s = createStore();
    apply(s, final(1, "Hi", "1"));
    apply(s, final(2, " there", "1"));
    apply(s, final(3, " Hello", "2"));
    apply(s, final(4, " back", "2"));

    expect(s.turns).toEqual([
      { speaker: "1", text: "Hi there" },
      { speaker: "2", text: " Hello back" },
    ]);
  });

  it("treats a null speaker as its own turn rather than merging it", () => {
    const s = createStore();
    apply(s, final(1, "attributed", "1"));
    apply(s, final(2, " unattributed", null));

    expect(s.turns.map((t) => t.speaker)).toEqual(["1", null]);
  });

  it("labels attributed turns on export and leaves unattributed ones bare", () => {
    const s = createStore();
    apply(s, final(1, "Hi there", "1"));
    apply(s, final(2, "Hello back", "2"));

    expect(renderText(s, { finalsOnly: true, speakerLabels: true })).toBe(
      "[Speaker 1] Hi there\n\n[Speaker 2] Hello back",
    );
    expect(renderText(s, { finalsOnly: true, speakerLabels: false })).toBe(
      "Hi there\n\nHello back",
    );
  });
});

describe("clear watermark", () => {
  it("drops updates for segments that predate the clear", () => {
    const s = createStore();
    apply(s, final(1, "old"));
    apply(s, interim(2, "in flight"));

    clear(s);

    // The revision that was already in flight when clear ran.
    const accepted = apply(s, final(2, "in flight, finished"));
    expect(accepted).toBe(false);
    expect(s.turns).toHaveLength(0);
    expect(openText(s)).toBe("");
  });

  it("accepts segments allocated after the clear", () => {
    const s = createStore();
    apply(s, final(1, "old"));
    clear(s);
    apply(s, final(2, "fresh"));

    expect(s.turns).toEqual([{ speaker: null, text: "fresh" }]);
  });
});

describe("export", () => {
  it("excludes still-revising text when finalsOnly is set", () => {
    const s = createStore();
    apply(s, final(1, "done"));
    apply(s, interim(2, " pending"));

    expect(renderText(s, { finalsOnly: true, speakerLabels: false })).toBe("done");
    expect(renderText(s, { finalsOnly: false, speakerLabels: false })).toBe(
      "done\n\npending",
    );
  });

  it("returns empty for an empty store, so copy never emits placeholder text", () => {
    expect(
      renderText(createStore(), { finalsOnly: true, speakerLabels: true }),
    ).toBe("");
  });
});

describe("line breaking", () => {
  it("never breaks an unattributed stream, so the on-device backend is unchanged", () => {
    const s = createStore();
    apply(s, final(1, "The quick brown"));
    apply(s, final(2, " fox jumps"));
    apply(s, interim(3, " over the"));

    const b = blocks(s);
    expect(b.every((x) => !x.breakBefore)).toBe(true);
  });

  it("breaks at every finalized turn boundary", () => {
    const s = createStore();
    apply(s, final(1, "Good morning.", "1"));
    apply(s, final(2, " Of course.", "2"));
    apply(s, final(3, " Right.", "1"));

    expect(blocks(s).map((x) => x.breakBefore)).toEqual([false, true, true]);
  });

  it("breaks between a turn and a still-revising segment by a different speaker", () => {
    const s = createStore();
    apply(s, final(1, "Good morning.", "1"));
    apply(s, interim(2, " Of course", "2"));

    const b = blocks(s);
    expect(b).toHaveLength(2);
    expect(b[1]).toMatchObject({ speaker: "2", pending: true, breakBefore: true });
  });

  it("does not break when a revising segment continues the same speaker", () => {
    const s = createStore();
    apply(s, final(1, "It is weaker.", "2"));
    apply(s, interim(2, " But not alarmingly", "2"));

    expect(blocks(s).map((x) => x.breakBefore)).toEqual([false, false]);
  });

  it("breaks between two revising segments when the tail spans a turn", () => {
    // The accumulator splits a provisional tail per speaker, so both arrive as
    // separate open segments.
    const s = createStore();
    apply(s, interim(1, "Sounds good", "1"));
    apply(s, interim(2, " Thanks for that", "2"));

    const b = blocks(s);
    expect(b).toHaveLength(2);
    expect(b.every((x) => x.pending)).toBe(true);
    expect(b.map((x) => x.breakBefore)).toEqual([false, true]);
  });

  it("carries the provisional speaker so a live tail is attributed", () => {
    const s = createStore();
    apply(s, interim(1, "How", "2"));

    expect(blocks(s)[0]).toMatchObject({ speaker: "2", pending: true });
  });
});

describe("export with a split tail", () => {
  it("labels each revising segment separately rather than merging them", () => {
    const s = createStore();
    apply(s, interim(1, "Sounds good", "1"));
    apply(s, interim(2, " Thanks for that", "2"));

    expect(renderText(s, { finalsOnly: false, speakerLabels: true })).toBe(
      "[Speaker 1] Sounds good\n\n[Speaker 2] Thanks for that",
    );
  });
});
