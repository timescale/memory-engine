/**
 * Tests for the shared agent-install helpers — the `--server`/`--space` pin
 * rules for `me <harness> install` (HARNESS_INTEGRATION_DESIGN.md §5).
 */
import { describe, expect, test } from "bun:test";
import { resolveInstallPins } from "./agent-install.ts";

const CREDS = { server: "https://api.memory.build", loggedIn: true };

describe("resolveInstallPins", () => {
  test("no flags → pin nothing (runtime resolution)", () => {
    expect(resolveInstallPins({}, CREDS)).toEqual({});
    expect(resolveInstallPins({}, { ...CREDS, loggedIn: false })).toEqual({});
  });

  test("--space implies --server: pins the pair with the resolved server", () => {
    expect(resolveInstallPins({ space: "abc123def456" }, CREDS)).toEqual({
      server: "https://api.memory.build",
      space: "abc123def456",
    });
  });

  test("an explicit --server wins over the resolved default", () => {
    expect(
      resolveInstallPins(
        { server: "https://dev.example.com", space: "abc123def456" },
        CREDS,
      ),
    ).toEqual({
      server: "https://dev.example.com",
      space: "abc123def456",
    });
  });

  test("--server alone pins only the server", () => {
    expect(
      resolveInstallPins({ server: "https://dev.example.com" }, CREDS),
    ).toEqual({ server: "https://dev.example.com" });
  });

  test("pinning requires a login session for the pinned server", () => {
    const result = resolveInstallPins(
      { space: "abc123def456" },
      { ...CREDS, loggedIn: false },
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/me login/);
  });
});
