/**
 * Tests for the Granola meeting renderer: HTML→Markdown and
 * ProseMirror→Markdown conversion, notes extraction precedence, transcript
 * speaker-turn grouping, and the assembled memory payload/metadata.
 */
import { describe, expect, test } from "bun:test";
import type {
  GranolaDocument,
  GranolaPanel,
  GranolaTranscriptSegment,
} from "./client.ts";
import {
  displayName,
  extractNotes,
  type GranolaMeeting,
  htmlToMarkdown,
  meetingStart,
  meetingTitle,
  proseMirrorToMarkdown,
  renderMeeting,
} from "./render.ts";

function meeting(over: Partial<GranolaMeeting> = {}): GranolaMeeting {
  return {
    document: { id: "doc-1", title: "Weekly Sync" },
    panels: [],
    transcript: [],
    ...over,
  };
}

describe("htmlToMarkdown", () => {
  test("converts headings, lists, bold, and links", () => {
    const html =
      "<h3>Topic</h3><ul><li>First point</li><li>Second <strong>bold</strong></li></ul>" +
      '<p>See <a href="https://x.test">docs</a></p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("### Topic");
    expect(md).toContain("- First point");
    expect(md).toContain("- Second **bold**");
    expect(md).toContain("[docs](https://x.test)");
  });

  test("decodes entities and strips unknown tags", () => {
    expect(htmlToMarkdown("<p>Tom &amp; Jerry &lt;3</p><span>x</span>")).toBe(
      "Tom & Jerry <3\n\nx",
    );
  });
});

describe("proseMirrorToMarkdown", () => {
  test("renders headings, bullets, and marked text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Decisions" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Ship " },
                    {
                      type: "text",
                      text: "now",
                      marks: [{ type: "bold" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = proseMirrorToMarkdown(doc);
    expect(md).toContain("## Decisions");
    expect(md).toContain("- Ship **now**");
  });

  test("renders links from marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "site",
              marks: [{ type: "link", attrs: { href: "https://y.test" } }],
            },
          ],
        },
      ],
    };
    expect(proseMirrorToMarkdown(doc)).toBe("[site](https://y.test)");
  });

  test("returns empty for nullish or non-object input", () => {
    expect(proseMirrorToMarkdown(null)).toBe("");
    expect(proseMirrorToMarkdown("nope")).toBe("");
  });
});

describe("extractNotes precedence", () => {
  test("prefers document notes_markdown", () => {
    const m = meeting({
      document: { id: "d", notes_markdown: "# from doc" },
      panels: [{ id: "p", original_content: "<p>from panel</p>" }],
    });
    expect(extractNotes(m)).toBe("# from doc");
  });

  test("prefers panel prosemirror over its HTML, falls back to HTML", () => {
    // ProseMirror models nested lists, so it wins when both are present.
    const bothPanel: GranolaPanel = {
      id: "p1",
      original_content: "<p>from html</p>",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "prose body" }],
          },
        ],
      },
    };
    expect(extractNotes(meeting({ panels: [bothPanel] }))).toBe("prose body");

    // HTML is used when the panel has no structured content.
    const htmlOnly: GranolaPanel = {
      id: "p2",
      original_content: "<h3>Summary</h3>",
    };
    expect(extractNotes(meeting({ panels: [htmlOnly] }))).toContain(
      "### Summary",
    );
  });

  test("returns empty string when no notes anywhere", () => {
    expect(extractNotes(meeting())).toBe("");
  });
});

describe("displayName", () => {
  test("suffixes the meeting date when known", () => {
    expect(displayName("Weekly Sync", "2026-06-23T18:30:00.000Z")).toBe(
      "Weekly Sync — 2026-06-23",
    );
  });

  test("returns the bare title without a start time", () => {
    expect(displayName("Ad-hoc note")).toBe("Ad-hoc note");
    expect(displayName("Bad date", "not-a-date")).toBe("Bad date");
  });
});

describe("meetingStart / meetingTitle", () => {
  test("meetingStart prefers calendar start over created_at", () => {
    const doc: GranolaDocument = {
      id: "d",
      created_at: "2026-01-01T00:00:00.000Z",
      google_calendar_event: {
        start: { dateTime: "2026-02-02T10:00:00-05:00" },
      },
    };
    expect(meetingStart(doc)).toBe("2026-02-02T15:00:00.000Z");
  });

  test("meetingStart falls back to created_at", () => {
    expect(
      meetingStart({ id: "d", created_at: "2026-03-03T08:00:00.000Z" }),
    ).toBe("2026-03-03T08:00:00.000Z");
  });

  test("meetingTitle falls back to calendar summary then default", () => {
    expect(
      meetingTitle({
        id: "d",
        google_calendar_event: { summary: "Cal Title" },
      }),
    ).toBe("Cal Title");
    expect(meetingTitle({ id: "d" })).toBe("Untitled meeting");
  });
});

describe("renderMeeting", () => {
  const transcript: GranolaTranscriptSegment[] = [
    { text: "Hello there.", source: "microphone" },
    { text: "How are you?", source: "microphone" },
    { text: "Doing well.", source: "system" },
    { text: "Great.", source: "microphone" },
  ];

  test("groups transcript into speaker turns when included", () => {
    const m = meeting({
      document: {
        id: "d",
        title: "Standup",
        notes_markdown: "notes here",
        google_calendar_event: {
          start: { dateTime: "2026-01-01T10:00:00Z" },
          end: { dateTime: "2026-01-01T10:30:00Z" },
          attendees: [{ email: "A@Example.com" }, { email: "b@example.com" }],
        },
      },
      transcript,
    });
    const r = renderMeeting(m, { includeTranscript: true });
    expect(r.title).toBe("Standup");
    expect(r.content).toContain("# Standup");
    expect(r.content).toContain("**Attendees:** a@example.com, b@example.com");
    expect(r.content).toContain("## Notes");
    expect(r.content).toContain("## Transcript");
    // Two microphone turns separated by one system turn.
    expect(r.content).toContain("**Me:** Hello there. How are you?");
    expect(r.content).toContain("**Them:** Doing well.");
    expect(r.content).toContain("**Me:** Great.");
    expect(r.meta.has_transcript).toBe(true);
    expect(r.meta.transcript_segment_count).toBe(4);
    expect(r.meta.display_name).toBe("Standup — 2026-01-01");
    expect(r.meta.attendees).toEqual(["a@example.com", "b@example.com"]);
    expect(r.startedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(r.endedAt).toBe("2026-01-01T10:30:00.000Z");
  });

  test("omits transcript section when not requested", () => {
    // The importer leaves transcript empty when --no-transcript, so render sees
    // an empty array and reports has_transcript=false.
    const r = renderMeeting(
      meeting({
        document: { id: "d", title: "T", notes_markdown: "n" },
        transcript: [],
      }),
      { includeTranscript: false },
    );
    expect(r.content).not.toContain("## Transcript");
    expect(r.meta.content_mode).toBe("notes_only");
    expect(r.meta.has_transcript).toBe(false);
  });
});
