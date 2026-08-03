/**
 * The RETIRED `me import git-hook` — a removed-command stub plus the
 * marker-based cleanup helper for hooks installed by older versions.
 *
 * The local post-commit hook imported whatever HEAD was: feature-branch and
 * rebased commits landed in the tree keyed by `(tree, sha)` forever, it ran
 * per-clone with the committing human's credentials, and it failed silently.
 * CI imports replaced it (`me ci install` scaffolds a GitHub workflow that
 * runs the git and docs importers on push to the default branch). Anyone who
 * truly wants local-commit capture can put
 * `me import git >/dev/null 2>&1 &` in their own hook — the primitive stays.
 *
 * What remains here: already-installed hooks keep firing on every commit
 * until their managed block is deleted. The stub directs users to CI setup or
 * manual cleanup.
 */
import { Command } from "commander";

/**
 * The removed-command stub (the `createRemovedCommand` pattern, cf. the
 * retired `me claude init`): accepts any of the old flags without Commander's
 * parse-time rejection so this message is what actually prints.
 */
export function createRemovedGitHookCommand(): Command {
  return new Command("git-hook")
    .description("removed — CI imports replaced the local hook")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(
        "error: 'me import git-hook' has been removed — a local hook imports unmerged and rebased " +
          "commits, and imports now run from CI on push to the default branch instead. Run " +
          "'me ci install' to set that up, or delete the " +
          "'>>> memory-engine' block from .git/hooks/post-commit by hand.",
      );
      process.exit(1);
    });
}
