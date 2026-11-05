/**
 * Tests for `me login` options and callback verification output.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as clack from "@clack/prompts";
import * as client from "../client.ts";
import * as loopback from "../oauth-loopback.ts";
import type { OutputFormat } from "../output.ts";
import { authenticateLogin, validateLoginOptions } from "./login.ts";

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

describe("loopback callback verification output", () => {
  const redirectUri = "http://127.0.0.1:54321/callback";
  const authorizeUrl = "https://as.example/authorize";

  for (const browser of [true, false]) {
    for (const format of ["text", "json", "yaml"] satisfies OutputFormat[]) {
      test(`${format} output with browser=${browser}`, async () => {
        const stop = new Error("Stop before token exchange");
        const version = spyOn(client, "checkServerVersion").mockResolvedValue({
          serverVersion: "1.0.0",
          minClientVersion: "0.0.0",
        });
        const note = spyOn(clack, "note").mockImplementation(() => {});
        const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
        const run = spyOn(loopback, "runLoopbackAuth").mockImplementation(
          async (opts) => {
            opts.onAuthorizeUrl?.(authorizeUrl, redirectUri);
            throw stop;
          },
        );
        try {
          await expect(
            authenticateLogin({
              server: "https://as.example",
              device: false,
              browser,
              format,
            }),
          ).rejects.toThrow(stop.message);

          if (format === "text") {
            expect(note).toHaveBeenCalledTimes(2);
            expect(note.mock.calls[0]?.[0]).toContain(redirectUri);
            expect(note.mock.calls[0]?.[0]).toContain("including the port");
            expect(note.mock.calls[0]?.[0]).toContain("browser approval page");
            expect(note.mock.calls[0]?.[0]).toContain("you started this login");
            expect(note.mock.calls[1]?.[0]).toBe(authorizeUrl);
            expect(note.mock.calls[1]?.[1]).toContain(
              browser ? "Opening your browser" : "Open this URL in a browser",
            );
          } else {
            expect(note).not.toHaveBeenCalled();
            expect(stdout).not.toHaveBeenCalled();
          }
        } finally {
          run.mockRestore();
          stdout.mockRestore();
          note.mockRestore();
          version.mockRestore();
        }
      });
    }
  }
});
