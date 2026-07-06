/**
 * Tests for the shared per-project capture-enable init step: the availability
 * probe, the `capture: true` write, and the explicit `capture: false` on an
 * interactive deselect (`applyCaptureDeselection`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectConfig,
  resetProjectConfigCache,
} from "../project-config.ts";
import { applyCaptureDeselection, captureEnableStep } from "./capture-step.ts";
import type { InitStep, RunInitStepsResult } from "./init.ts";

let root: string;

const step = captureEnableStep({ group: "G", toolLabel: "Claude Code" });
const ctx = () => ({ globalOpts: {}, projectRoot: root });

/** A RunInitStepsResult where the capture row had the given disposition. */
function result(
  disposition: "ran" | "done" | "deselected" | "hidden",
): RunInitStepsResult {
  const asStep = { id: "capture-enable" } as InitStep;
  return {
    ran: disposition === "ran" ? [asStep] : [],
    done: disposition === "done" ? [asStep] : [],
    offered: disposition === "hidden" ? [] : ["capture-enable"],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "me-capstep-"));
  resetProjectConfigCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetProjectConfigCache();
});

describe("captureEnableStep", () => {
  test("run writes capture: true to the committed .me/config.yaml", async () => {
    await step.run(ctx());
    expect(discoverProjectConfig(root)?.capture).toBe(true);
  });

  test("available: done when the project already pins capture: true", async () => {
    expect(await step.available?.(ctx())).toBe("available");
    mkdirSync(join(root, ".me"), { recursive: true });
    writeFileSync(join(root, ".me", "config.yaml"), "capture: true\n");
    resetProjectConfigCache();
    expect(await step.available?.(ctx())).toBe("done");
    // An explicit capture: false is still offered (re-enabling is the point).
    writeFileSync(join(root, ".me", "config.yaml"), "capture: false\n");
    resetProjectConfigCache();
    expect(await step.available?.(ctx())).toBe("available");
  });
});

describe("applyCaptureDeselection", () => {
  test("an interactive deselect writes the explicit capture: false", () => {
    applyCaptureDeselection(result("deselected"), {
      interactive: true,
      projectRoot: root,
    });
    expect(discoverProjectConfig(root)?.capture).toBe(false);
  });

  test("no write when the row ran, was already done, or was hidden", () => {
    for (const d of ["ran", "done", "hidden"] as const) {
      applyCaptureDeselection(result(d), {
        interactive: true,
        projectRoot: root,
      });
      expect(discoverProjectConfig(root)).toBeUndefined();
    }
  });

  test("no write non-interactively (--skip means don't touch)", () => {
    applyCaptureDeselection(result("deselected"), {
      interactive: false,
      projectRoot: root,
    });
    expect(discoverProjectConfig(root)).toBeUndefined();
  });
});
