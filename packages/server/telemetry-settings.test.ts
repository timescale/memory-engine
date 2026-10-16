import { describe, expect, test } from "bun:test";
import { resolveTelemetrySettings } from "./telemetry-settings";

describe("telemetry profile settings", () => {
  test("defaults to a lean, minute-resolution profile", () => {
    expect(resolveTelemetrySettings({})).toEqual({
      profile: "lean",
      metricsEnabled: false,
      snapshotIntervalMs: 60_000,
    });
  });

  test("requires explicit diagnostic opt-in", () => {
    expect(
      resolveTelemetrySettings({ LOGFIRE_TELEMETRY_PROFILE: "diagnostic" }),
    ).toEqual({
      profile: "diagnostic",
      metricsEnabled: true,
      snapshotIntervalMs: 10_000,
    });
    for (const profile of ["", "lean", "true", "DIAGNOSTIC", "typo"]) {
      expect(
        resolveTelemetrySettings({ LOGFIRE_TELEMETRY_PROFILE: profile })
          .metricsEnabled,
      ).toBe(false);
    }
  });

  test("allows a bounded snapshot override without changing metric opt-in", () => {
    for (const profile of ["lean", "diagnostic"]) {
      for (const [raw, expected] of [
        ["1000", 10_000],
        ["10000", 10_000],
        ["120000", 120_000],
        [String(2 ** 31 - 1), 2 ** 31 - 1],
      ] as const) {
        const settings = resolveTelemetrySettings({
          LOGFIRE_TELEMETRY_PROFILE: profile,
          LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS: raw,
        });
        expect(settings.snapshotIntervalMs).toBe(expected);
        expect(settings.metricsEnabled).toBe(profile === "diagnostic");
      }
    }
  });

  test("invalid intervals fall back to the profile default", () => {
    for (const profile of ["lean", "diagnostic"]) {
      for (const raw of [
        "",
        " ",
        "nope",
        "0",
        "-1",
        "1.5",
        "Infinity",
        "NaN",
        String(2 ** 31),
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        expect(
          resolveTelemetrySettings({
            LOGFIRE_TELEMETRY_PROFILE: profile,
            LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS: raw,
          }).snapshotIntervalMs,
        ).toBe(profile === "diagnostic" ? 10_000 : 60_000);
      }
    }
  });
});
