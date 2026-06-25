import { describe, expect, test } from "bun:test";
import { renderTree } from "./memory-tree.ts";

describe("renderTree", () => {
  // The server emits canonical slash display paths (`/share/work`, `~/notes`,
  // bare `~`), not dotted ltree paths — these tests feed that real input.
  test("sums top-level subtrees for filtered roots", () => {
    const rendered = renderTree(
      [
        { path: "/share/work/alpha", count: 2 },
        { path: "/share/work/alpha/agent_sessions", count: 2 },
        { path: "/share/work/beta", count: 3 },
        { path: "/share/work/beta/agent_sessions", count: 3 },
      ],
      "share/work",
    );

    expect(rendered).toContain("share/work (5)");
    expect(rendered).toContain("├── alpha (2)");
    expect(rendered).toContain("└── beta (3)");
    expect(rendered).toContain("agent_sessions (2)");
    expect(rendered).toContain("5 memories total");
  });

  test("nests multiple absolute root branches when unfiltered", () => {
    const rendered = renderTree([
      { path: "/personal", count: 3 },
      { path: "/work/projects", count: 2 },
      { path: "/work", count: 2 },
      { path: "/personal/notes", count: 3 },
    ]);

    expect(rendered).toContain(". (5)");
    expect(rendered).toContain("├── personal (3)");
    expect(rendered).toContain("│   └── notes (3)");
    expect(rendered).toContain("└── work (2)");
    expect(rendered).toContain("    └── projects (2)");
    expect(rendered).toContain("5 memories total");
  });

  test("nests under the bare `~` home root", () => {
    const rendered = renderTree([
      { path: "~/notes", count: 3 },
      { path: "~/notes/todo", count: 1 },
    ]);

    expect(rendered).toContain("└── notes (3)");
    expect(rendered).toContain("    └── todo (1)");
    expect(rendered).toContain("3 memories total");
  });
});
