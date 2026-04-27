import { describe, expect, test } from "bun:test";
import {
  formatDatetimeLocalInputValue,
  formatLocalOffsetTimestamp,
  localOffsetTimestampFromDatetimeLocalValue,
} from "./datetime.ts";

describe("datetime formatting", () => {
  test("formats timestamps with local offset and preserves the instant", () => {
    const original = "2026-02-17T20:23:11.570Z";
    const formatted = formatLocalOffsetTimestamp(original);

    expect(formatted).toMatch(/\.570[+-]\d{2}:\d{2}$/);
    expect(new Date(formatted).toISOString()).toBe(original);
  });

  test("datetime-local picker values can round-trip back to offset timestamps", () => {
    const original = "2026-02-17T20:23:11.570Z";
    const pickerValue = formatDatetimeLocalInputValue(original);
    const timestamp = localOffsetTimestampFromDatetimeLocalValue(pickerValue);

    expect(new Date(timestamp).toISOString()).toBe(original);
  });
});
