/**
 * Tests for `me login` option validation.
 */
import { describe, expect, test } from "bun:test";
import { validateLoginOptions } from "./login.ts";

describe("validateLoginOptions", () => {
  test("rejects --device --switch", () => {
    const err = validateLoginOptions({ device: true, switch: true });
    expect(err).toContain("--switch isn't supported with --device");
  });

  test("allows --device alone", () => {
    expect(validateLoginOptions({ device: true })).toBeNull();
  });

  test("allows --switch alone (browser flow)", () => {
    expect(validateLoginOptions({ switch: true })).toBeNull();
  });

  test("allows neither", () => {
    expect(validateLoginOptions({})).toBeNull();
  });

  test("allows --device with --no-browser (browser:false)", () => {
    expect(validateLoginOptions({ device: true, browser: false })).toBeNull();
  });
});
