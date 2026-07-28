import { describe, expect, test } from "bun:test";
import { parseMemberKindFilter } from "./space.ts";

describe("parseMemberKindFilter", () => {
  test("accepts short codes", () => {
    expect(parseMemberKindFilter("u")).toBe("u");
    expect(parseMemberKindFilter("s")).toBe("s");
    expect(parseMemberKindFilter("all")).toBe("all");
  });

  test("accepts full words", () => {
    expect(parseMemberKindFilter("user")).toBe("u");
    expect(parseMemberKindFilter("service")).toBe("s");
    expect(parseMemberKindFilter("service-account")).toBe("s");
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(parseMemberKindFilter("USER")).toBe("u");
    expect(parseMemberKindFilter("ALL")).toBe("all");
  });

  test("returns undefined for unrecognized values", () => {
    expect(parseMemberKindFilter("g")).toBeUndefined();
    expect(parseMemberKindFilter("group")).toBeUndefined();
    expect(parseMemberKindFilter("agent")).toBeUndefined();
    expect(parseMemberKindFilter("")).toBeUndefined();
    expect(parseMemberKindFilter("everyone")).toBeUndefined();
  });
});
