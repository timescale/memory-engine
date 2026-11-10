import { describe, expect, test } from "bun:test";
import { shutdownBannerMessage } from "./shutdown-banner.ts";

describe("shutdownBannerMessage", () => {
  test("returns null for @tigerdata.com emails (case-insensitive)", () => {
    expect(shutdownBannerMessage("alice@tigerdata.com")).toBeNull();
    expect(shutdownBannerMessage("Alice@TigerData.com")).toBeNull();
    expect(shutdownBannerMessage("  bob@tigerdata.com  ")).toBeNull();
  });

  test("returns null for empty or non-email display names", () => {
    expect(shutdownBannerMessage(null)).toBeNull();
    expect(shutdownBannerMessage(undefined)).toBeNull();
    expect(shutdownBannerMessage("")).toBeNull();
    expect(shutdownBannerMessage("ci-bot")).toBeNull();
  });

  test("returns the shutdown notice for external email domains", () => {
    expect(shutdownBannerMessage("external@example.com")).toBe(
      "Memory Engine is shutting down public hosting. Access for external@example.com will end on November 30, 2026. Export any personal memories you want to keep before then.",
    );
    expect(shutdownBannerMessage("user@sub.tigerdata.com")).toBe(
      "Memory Engine is shutting down public hosting. Access for user@sub.tigerdata.com will end on November 30, 2026. Export any personal memories you want to keep before then.",
    );
  });
});
