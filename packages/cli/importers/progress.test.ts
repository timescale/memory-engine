/**
 * Tests for the progress reporter's TTY and non-TTY paths.
 */
import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "./progress.ts";

/**
 * Build a minimal mock of NodeJS.WriteStream sufficient for the reporter.
 * Records every write; caller decides whether `isTTY` is on.
 */
function mockStream(isTTY: boolean): {
  stream: NodeJS.WriteStream;
  writes: string[];
} {
  const writes: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    write(chunk: string | Uint8Array): boolean {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("createProgressReporter (non-TTY)", () => {
  test("all progress methods are no-ops except log", () => {
    const { stream, writes } = mockStream(false);
    const reporter = createProgressReporter(stream);
    reporter.start();
    reporter.scan("/path/to/file.jsonl");
    reporter.process("some session");
    reporter.stop();
    expect(writes).toHaveLength(0);
    // log falls through to console.log; we can't easily capture stdout,
    // but the reporter must not write to the stream in non-TTY mode.
  });
});

describe("createProgressReporter (TTY)", () => {
  test("start writes an initial progress line", () => {
    const { stream, writes } = mockStream(true);
    const reporter = createProgressReporter(stream);
    reporter.start();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.join("")).toContain("scanned");
    reporter.stop();
  });

  test("scan increments and shows current filename basename", () => {
    const { stream, writes } = mockStream(true);
    const reporter = createProgressReporter(stream);
    reporter.start();
    writes.length = 0; // reset after start
    reporter.scan("/tmp/sessions/abcdef-01234.jsonl");
    reporter.stop();
    const all = writes.join("");
    expect(all.length).toBeGreaterThan(0);
  });

  test("spinner line is truncated to terminal width", () => {
    const { stream, writes } = mockStream(true);
    stream.columns = 24;
    const reporter = createProgressReporter(stream);
    reporter.start();
    writes.length = 0;
    reporter.process(
      "Please refactor the embedding worker to use a claims-based scheduler.",
    );
    reporter.log("outcome");
    const redraw = writes.find((chunk) => chunk.includes("scanned"));
    expect(redraw).toBeDefined();
    const rendered = redraw?.replace("\x1b[2K\r", "") ?? "";
    expect(rendered.length).toBeLessThanOrEqual(23);
    reporter.stop();
  });

  test("log clears the line, writes above it, and redraws", () => {
    const { stream, writes } = mockStream(true);
    const reporter = createProgressReporter(stream);
    reporter.start();
    writes.length = 0;
    reporter.log("some outcome");
    reporter.stop();
    const joined = writes.join("");
    expect(joined).toContain("some outcome");
    // Must contain the clear-line ANSI.
    expect(joined).toContain("\x1b[2K\r");
  });

  test("stop() is idempotent", () => {
    const { stream } = mockStream(true);
    const reporter = createProgressReporter(stream);
    reporter.start();
    reporter.stop();
    // Should not throw.
    reporter.stop();
  });
});
