import { describe, expect, test } from "bun:test";
import { renderTree } from "./memory-tree.ts";

describe("renderTree", () => {
  test("sums top-level subtrees for filtered roots", () => {
    const rendered = renderTree(
      [
        { path: "projects.alpha", count: 2 },
        { path: "projects.alpha.agent_sessions", count: 2 },
        { path: "projects.beta", count: 3 },
        { path: "projects.beta.agent_sessions", count: 3 },
      ],
      "projects",
    );

    expect(rendered).toContain("projects (5)");
    expect(rendered).toContain("├── alpha (2)");
    expect(rendered).toContain("└── beta (3)");
    expect(rendered).toContain("5 memories total");
  });

  test("sums multiple root branches when unfiltered", () => {
    const rendered = renderTree([
      { path: "personal", count: 3 },
      { path: "work.projects", count: 2 },
      { path: "work", count: 2 },
      { path: "personal.notes", count: 3 },
    ]);

    expect(rendered).toContain(". (5)");
    expect(rendered).toContain("├── personal (3)");
    expect(rendered).toContain("└── work (2)");
    expect(rendered).toContain("5 memories total");
  });
});
