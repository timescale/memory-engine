import { describe, expect, test } from "bun:test";
import {
  detectReleaseArch,
  detectReleasePlatform,
  isVersionGreater,
  normalizeVersion,
  releaseAssetName,
} from "./upgrade.ts";

describe("upgrade helpers", () => {
  test("normalizeVersion removes a leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
  });

  test("isVersionGreater uses Bun semver ordering", () => {
    expect(isVersionGreater("v1.2.4", "1.2.3")).toBe(true);
    expect(isVersionGreater("v1.2.3", "1.2.3")).toBe(false);
    expect(isVersionGreater("v1.2.2", "1.2.3")).toBe(false);
  });

  test("detectReleasePlatform maps node platforms to release platform names", () => {
    expect(detectReleasePlatform("darwin")).toBe("darwin");
    expect(detectReleasePlatform("linux")).toBe("linux");
    expect(detectReleasePlatform("win32")).toBe("windows");
    expect(() => detectReleasePlatform("freebsd")).toThrow("Unsupported OS");
  });

  test("detectReleaseArch maps node arches to release arch names", () => {
    expect(detectReleaseArch("arm64")).toBe("arm64");
    expect(detectReleaseArch("x64")).toBe("x64");
    expect(() => detectReleaseArch("ia32")).toThrow("Unsupported architecture");
  });

  test("releaseAssetName matches install.sh asset names", () => {
    expect(releaseAssetName("darwin", "arm64")).toBe("me-darwin-arm64");
    expect(releaseAssetName("linux", "x64")).toBe("me-linux-x64");
    expect(releaseAssetName("windows", "x64")).toBe("me-windows-x64.exe");
    expect(() => releaseAssetName("darwin", "x64")).toThrow("macOS Intel");
  });
});
