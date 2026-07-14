/**
 * Unit tests for `me project ci`'s pure pieces: GitHub remote parsing, the
 * workflow scaffold (repo-agnostic, runtime default-branch gate, key-name
 * substitution, ME_SERVER baking), key-name recovery from a managed file,
 * the write-grant ancestor check, and option validation.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVER, DEV_SERVER } from "../credentials.ts";
import {
  buildProjectCiOptions,
  DEFAULT_KEY_NAME,
  hasWriteAtTree,
  MANAGED_MARKER,
  parseGitHubRepo,
  recoverKeyNameFromWorkflow,
  renderWorkflow,
  workflowServerEnv,
  workflowStateForScaffold,
} from "./project-ci.ts";

describe("parseGitHubRepo", () => {
  test("parses ssh, ssh-url, and https forms", () => {
    expect(parseGitHubRepo("git@github.com:acme/checkout-api.git")).toBe(
      "acme/checkout-api",
    );
    expect(parseGitHubRepo("git@github.com:acme/checkout-api")).toBe(
      "acme/checkout-api",
    );
    expect(parseGitHubRepo("ssh://git@github.com/acme/checkout-api.git")).toBe(
      "acme/checkout-api",
    );
    expect(parseGitHubRepo("https://github.com/acme/checkout-api")).toBe(
      "acme/checkout-api",
    );
    expect(parseGitHubRepo("https://github.com/acme/checkout-api.git")).toBe(
      "acme/checkout-api",
    );
    expect(parseGitHubRepo("https://github.com/acme/checkout-api/")).toBe(
      "acme/checkout-api",
    );
  });

  test("rejects non-GitHub remotes", () => {
    expect(parseGitHubRepo("git@gitlab.com:acme/x.git")).toBeUndefined();
    expect(parseGitHubRepo("https://bitbucket.org/acme/x")).toBeUndefined();
    expect(parseGitHubRepo("/local/bare/repo.git")).toBeUndefined();
  });
});

describe("renderWorkflow", () => {
  test("is repo-agnostic: runtime default-branch gate, no scaffold-time names", () => {
    const wf = renderWorkflow({ keyName: DEFAULT_KEY_NAME });
    expect(wf.startsWith(MANAGED_MARKER)).toBe(true);
    // The runtime gate — never a hardcoded branch filter.
    expect(wf).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(wf).not.toContain("branches:");
    expect(wf).toContain("group: me-import-${{ github.ref }}");
    // Full history is a correctness requirement (git walk + docs temporals).
    expect(wf).toContain("fetch-depth: 0");
    // The env var `me` reads never varies; only the secret feeding it does.
    expect(wf).toContain("ME_API_KEY: ${{ secrets.ME_API_KEY }}");
    expect(wf).toContain("me import ci");
    expect(wf).not.toContain("ME_SERVER");
  });

  test("substitutes the secret name, keeping the env var fixed", () => {
    const wf = renderWorkflow({ keyName: "ME_API_KEY_SPACE2" });
    expect(wf).toContain("ME_API_KEY: ${{ secrets.ME_API_KEY_SPACE2 }}");
  });

  test("bakes ME_SERVER only when given", () => {
    const wf = renderWorkflow({
      keyName: DEFAULT_KEY_NAME,
      serverEnv: "https://me.acme.internal",
    });
    expect(wf).toContain("ME_SERVER: https://me.acme.internal");
  });
});

describe("recoverKeyNameFromWorkflow", () => {
  test("round-trips the key name through the scaffold", () => {
    for (const keyName of [DEFAULT_KEY_NAME, "ME_API_KEY_SPACE2"]) {
      expect(recoverKeyNameFromWorkflow(renderWorkflow({ keyName }))).toBe(
        keyName,
      );
    }
  });

  test("undefined when no secrets reference exists", () => {
    expect(recoverKeyNameFromWorkflow("name: nope\n")).toBeUndefined();
  });
});

describe("workflowStateForScaffold", () => {
  const desired = renderWorkflow({ keyName: DEFAULT_KEY_NAME });

  test("reports create/update states accurately under dry-run", () => {
    expect(workflowStateForScaffold(undefined, false, desired, false)).toBe(
      "created",
    );
    expect(workflowStateForScaffold(undefined, false, desired, true)).toBe(
      "would-create",
    );
    expect(
      workflowStateForScaffold(`${desired}\n# old\n`, true, desired, false),
    ).toBe("updated");
    expect(
      workflowStateForScaffold(`${desired}\n# old\n`, true, desired, true),
    ).toBe("would-update");
  });

  test("reports unchanged and foreign workflows without dry-run variants", () => {
    expect(workflowStateForScaffold(desired, true, desired, true)).toBe(
      "unchanged",
    );
    expect(
      workflowStateForScaffold("name: custom\n", false, desired, true),
    ).toBe("foreign");
  });
});

describe("workflowServerEnv", () => {
  test("omitted when the resolved server is what CI would resolve anyway", () => {
    // No .me server pin, resolved default → CI resolves the default too.
    expect(workflowServerEnv(DEFAULT_SERVER, undefined)).toBeUndefined();
    // A trusted .me pin: CI honors it directly.
    expect(
      workflowServerEnv(DEV_SERVER, { server: DEV_SERVER }),
    ).toBeUndefined();
  });

  test("baked for a non-default server CI could not resolve on its own", () => {
    // Resolved dev WITHOUT a .me pin (e.g. from the user's global config,
    // which CI doesn't have) → must be baked.
    expect(workflowServerEnv(DEV_SERVER, undefined)).toBe(DEV_SERVER);
    // A self-hosted pin isn't in the built-in trusted list, so a bare CI
    // checkout would refuse it — bake the env (ungated, user's own choice).
    const selfHosted = "https://me.acme.internal";
    expect(workflowServerEnv(selfHosted, { server: selfHosted })).toBe(
      selfHosted,
    );
  });
});

describe("hasWriteAtTree", () => {
  const tree = "/share/projects/checkout_api";
  test("write or owner at the path or an ancestor counts", () => {
    expect(
      hasWriteAtTree(
        [{ treePath: "/share/projects/checkout_api", access: 2 }],
        tree,
      ),
    ).toBe(true);
    expect(
      hasWriteAtTree([{ treePath: "/share/projects", access: 2 }], tree),
    ).toBe(true);
    expect(hasWriteAtTree([{ treePath: "/share", access: 3 }], tree)).toBe(
      true,
    );
    // Dotted (ltree) grant form matches the display-form target.
    expect(
      hasWriteAtTree([{ treePath: "share.projects", access: 2 }], tree),
    ).toBe(true);
  });

  test("read-only, sibling, and descendant grants do not count", () => {
    expect(
      hasWriteAtTree([{ treePath: "/share/projects", access: 1 }], tree),
    ).toBe(false);
    expect(
      hasWriteAtTree([{ treePath: "/share/projects/other", access: 3 }], tree),
    ).toBe(false);
    expect(
      hasWriteAtTree(
        [{ treePath: "/share/projects/checkout_api/docs", access: 3 }],
        tree,
      ),
    ).toBe(false);
    expect(hasWriteAtTree([], tree)).toBe(false);
  });
});

describe("buildProjectCiOptions", () => {
  test("applies defaults and maps flags", () => {
    expect(buildProjectCiOptions({})).toEqual({
      createServiceAccount: false,
      serviceAccount: undefined,
      keyName: undefined,
      workflowOnly: false,
      rotateKey: false,
      dryRun: false,
    });
    expect(
      buildProjectCiOptions({
        createServiceAccount: true,
        serviceAccount: "github-import",
        keyName: "ME_API_KEY_2",
        rotateKey: true,
        dryRun: true,
      }),
    ).toEqual({
      createServiceAccount: true,
      serviceAccount: "github-import",
      keyName: "ME_API_KEY_2",
      workflowOnly: false,
      rotateKey: true,
      dryRun: true,
    });
  });

  test("rejects invalid names", () => {
    expect(() => buildProjectCiOptions({ serviceAccount: "-bad" })).toThrow(
      /service-account/,
    );
    expect(() => buildProjectCiOptions({ keyName: "2BAD" })).toThrow(
      /key-name/,
    );
    expect(() => buildProjectCiOptions({ keyName: "BAD-DASH" })).toThrow(
      /key-name/,
    );
  });

  test("--workflow-only excludes the credential flags (never silently ignored)", () => {
    expect(
      buildProjectCiOptions({ workflowOnly: true, keyName: "ME_API_KEY_2" })
        .workflowOnly,
    ).toBe(true); // --key-name composes: it's baked into the file
    for (const bad of [
      { workflowOnly: true, createServiceAccount: true },
      { workflowOnly: true, rotateKey: true },
      { workflowOnly: true, serviceAccount: "github-import" },
    ]) {
      expect(() => buildProjectCiOptions(bad)).toThrow(/workflow-only/);
    }
  });
});
