import { describe, expect, test } from "bun:test";
import {
  isPublicHostedHostname,
  shutdownBannerMessage,
} from "./shutdown-banner.ts";

const PUBLIC_HOSTED = { hosted: true, hostname: "api.memory.build" };

describe("isPublicHostedHostname", () => {
  test("matches memory.build and dev timescale.com hostnames", () => {
    expect(isPublicHostedHostname("memory.build")).toBe(true);
    expect(isPublicHostedHostname("api.memory.build")).toBe(true);
    expect(
      isPublicHostedHostname("me.dev-us-east-1.ops.dev.timescale.com"),
    ).toBe(true);
  });

  test("rejects self-hosted and local hostnames", () => {
    expect(isPublicHostedHostname("127.0.0.1")).toBe(false);
    expect(isPublicHostedHostname("localhost")).toBe(false);
    expect(isPublicHostedHostname("memory.example.com")).toBe(false);
    expect(isPublicHostedHostname("notmemory.build")).toBe(false);
  });
});

describe("shutdownBannerMessage", () => {
  test("returns null for @tigerdata.com emails (case-insensitive)", () => {
    expect(
      shutdownBannerMessage("alice@tigerdata.com", PUBLIC_HOSTED),
    ).toBeNull();
    expect(
      shutdownBannerMessage("Alice@TigerData.com", PUBLIC_HOSTED),
    ).toBeNull();
    expect(
      shutdownBannerMessage("  bob@tigerdata.com  ", PUBLIC_HOSTED),
    ).toBeNull();
  });

  test("returns null for empty or non-email display names", () => {
    expect(shutdownBannerMessage(null, PUBLIC_HOSTED)).toBeNull();
    expect(shutdownBannerMessage(undefined, PUBLIC_HOSTED)).toBeNull();
    expect(shutdownBannerMessage("", PUBLIC_HOSTED)).toBeNull();
    expect(shutdownBannerMessage("ci-bot", PUBLIC_HOSTED)).toBeNull();
  });

  test("returns null on local mode or self-hosted domains", () => {
    expect(
      shutdownBannerMessage("external@example.com", {
        hosted: false,
        hostname: "127.0.0.1",
      }),
    ).toBeNull();
    expect(
      shutdownBannerMessage("external@example.com", {
        hosted: true,
        hostname: "memory.example.com",
      }),
    ).toBeNull();
  });

  test("returns the shutdown notice for external email domains on public hosted deployment", () => {
    expect(shutdownBannerMessage("external@example.com", PUBLIC_HOSTED)).toBe(
      "Memory Engine is shutting down public hosting. Access for external@example.com will end on November 30, 2026. Export any personal memories you want to keep before then.",
    );
    expect(shutdownBannerMessage("user@sub.tigerdata.com", PUBLIC_HOSTED)).toBe(
      "Memory Engine is shutting down public hosting. Access for user@sub.tigerdata.com will end on November 30, 2026. Export any personal memories you want to keep before then.",
    );
  });
});
