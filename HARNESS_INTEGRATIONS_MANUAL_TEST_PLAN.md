# Harness Integrations Manual Test Plan

Use this plan to validate the harness-integration rework in disposable Apple
Container Linux VMs. It is intentionally selective: prioritize the product
contract and UX over exhaustive provider coverage. Budget no more than four
hours.

## Goal

Validate that the candidate build has the intended behavior:

1. Installing is dormant and non-destructive.
2. Machine-local policy activates MCP, capture, and harness-shell CLI routing
   independently.
3. A configured harness can use MCP and carries the shell contract.
4. A human shell is not retargeted by a project profile.
5. Uninstall and CI generation are safe and understandable.

Use an existing dedicated test space and a unique tree such as
`/share/manual-harness/<date>`. Do not use production memories or
credentials.

## Before Starting

Allocate 15-20 minutes.

- Confirm the candidate `me` binary runs in the ARM64 Linux container.
- Record the candidate commit, `me --version`, and the Claude Code, OpenCode,
  and Codex versions.
- Give each container an isolated home:

  ```sh
  export XDG_CONFIG_HOME="$HOME/.config"
  export ME_NO_KEYCHAIN=1
  mkdir -p ~/projects/project-x
  ```

- Use device login for the primary run:

  ```sh
  export ME_SERVER=https://api.memory.build
  export ME_SPACE=<test-space-slug>
  me login --device "$ME_SPACE"
  me whoami --json
  ```

  Approve the device code from another machine. The device session is stored
  in the container's disposable config directory.

- A mounted `ME_API_KEY` is suitable for quick repeat runs, but do not combine
  it with device-login validation: an API key takes precedence over a session.

## Container A: Mechanical Lifecycle

Allocate 45 minutes. Start with all three harness CLIs on `PATH` and no
`~/.config/me/`.

1. Run:

   ```sh
   me install
   ```

2. Check:

   - No Memory Engine login, space, tree, capture, or MCP configuration prompt.
   - `~/.config/me/installations.yaml` lists each installed harness.
   - No enabled policy is created in `config.yaml`.
   - No repository file is created or changed.

3. Inspect provider artifacts:

   - Claude: a user-scope Memory Engine plugin and MCP registration.
   - OpenCode: `~/.config/opencode/opencode.json` contains `mcp.me` invoking
     `me mcp --harness opencode`; the generated plugin exists.
   - Codex: user MCP registration and `~/.codex/hooks.json` entries exist.

4. Re-run `me install`. Expect no duplicate artifacts or prompts.

5. Add an unrelated provider config entry, then run:

   ```sh
   me uninstall
   ```

6. Check:

   - Memory Engine-owned artifacts and inventory are removed.
   - The unrelated provider entry remains.
   - A second uninstall is a successful no-op.

Stop and record a blocker if installation, repeatability, or cleanup is
confusing. These are release-critical paths.

## Container B: Policy And UX

Allocate 60 minutes. Use an existing login and a fresh `/workspace/project`.

1. Verify an empty profile is inert:

   ```sh
   me init /workspace/project
   me doctor /workspace/project --harness claude --json
   ```

   The profile should contain explicit disabled surfaces and no repository file
   should exist.

2. Write a full directory policy for one harness, preferably OpenCode first:

   ```sh
   me init /workspace/project \
     --mcp-server "$ME_SERVER" \
     --mcp-space "$ME_SPACE" \
     --mcp-harness opencode \
     --capture-server "$ME_SERVER" \
     --capture-space "$ME_SPACE" \
     --capture-tree /share/manual-harness/<date> \
     --capture-harness opencode \
     --cli-server "$ME_SERVER" \
     --cli-space "$ME_SPACE" \
     --cli-harness opencode
   ```

3. Inspect the policy:

   ```sh
   me doctor /workspace/project --harness opencode --json
   AI_AGENT=opencode ME_PROJECT_DIR=/workspace/project me doctor --json
   ```

4. Confirm MCP, capture, and CLI are independently configured; the directory
   key is canonical; and doctor reports the expected MCP anchor.

5. Confirm a human shell is not harness-routed:

   ```sh
   env -u AI_AGENT -u ME_PROJECT_DIR me status --json
   ```

## No-Inheritance Check

Allocate 20 minutes. This validates a core safety invariant.

1. Configure defaults with MCP enabled for a harness.
2. Configure `/workspace/project` with only capture or CLI enabled.
3. Run:

   ```sh
   me doctor /workspace/project --harness opencode --json
   ```

4. Expect MCP to be inactive in the project. It must not inherit the defaults
   MCP block.
5. If practical, start OpenCode in the project and confirm its Memory Engine
   MCP tool list is empty.

## Live Harness Smoke

Allocate 70-80 minutes. These are the only checks that establish runtime
integration rather than static configuration, and they spend provider tokens.

For each of Claude Code, OpenCode, and Codex:

1. Start in `/workspace/project` after installing its integration.
2. Before activating its MCP profile, inspect the harness MCP/tool UI. Memory
   Engine may be connected but must expose no tools.
3. Enable only that harness under MCP with `me init`.
4. Start a new harness session and ask it to create a uniquely named Memory
   Engine memory under `/share/manual-harness/<date>`.
5. Verify the result:

   ```sh
   me memory get /share/manual-harness/<date>/<name>
   ```

6. Ask the harness to execute:

   ```sh
   printf '%s %s\n' "$AI_AGENT" "$ME_PROJECT_DIR"
   ```

   Expect its harness name and `/workspace/project`.

Provider notes:

- Claude validates plugin MCP activation and `$CLAUDE_ENV_FILE` shell
  propagation.
- OpenCode validates MCP and the generated plugin's `shell.env` propagation.
- Codex requires approving the installed hook through `/hooks` before its
  shell-environment test.

Do not test Codex Desktop or VS Code in this pass. They intentionally use the
defaults profile without a provider-native per-server cwd.

## Capture

Allocate 25 minutes. Test capture end-to-end for one harness, preferably
OpenCode. Repeat for Claude only if time remains.

1. Count the destination before the session:

   ```sh
   me memory count /share/manual-harness/<date>
   ```

2. Run and finish a short session containing a unique phrase.
3. Wait briefly for hook processing, then verify a new memory appears:

   ```sh
   me memory tree /share/manual-harness/<date>
   ```

4. Replace the directory profile with capture disabled and run another short
   session. The count must not increase, and the harness must not be blocked.

For Codex, verify that hooks do not block a session while capture is disabled.
Treat live capture as out of scope unless it is already known stable.

## CI Generator

Allocate 15 minutes. Use a disposable git repository with a GitHub `origin`.

```sh
me ci install \
  --server "$ME_SERVER" \
  --space "$ME_SPACE" \
  --tree /share/manual-harness/<date>/repo \
  --workflow-only
```

Check:

- `.github/workflows/me-import.yml` is created.
- It invokes `me import git` and `me import docs`, never `me import ci`.
- Re-running without `--force` refuses.
- Re-running with `--force` replaces the workflow entirely.

Do not spend time testing GitHub secret placement or service-account creation
in this pass.

## Uninstall And Purge

Allocate 15 minutes in Container B:

```sh
me uninstall opencode
me doctor /workspace/project --harness opencode --json
me uninstall opencode --purge
```

Confirm plain uninstall preserves local policy selections, while `--purge`
removes OpenCode selections without removing other harness selections.

## Exit Criteria

Call the run successful if all of the following hold:

- Install, reinstall, and uninstall are prompt-free, understandable, and
  non-destructive.
- A newly installed harness exposes no Memory Engine tools before activation.
- A configured harness exposes MCP tools, carries `AI_AGENT` and
  `ME_PROJECT_DIR`, and can write a test memory.
- One capture path writes only to its configured tree; disabled capture writes
  nothing.
- A project profile never inherits omitted surfaces from defaults.
- A human shell remains unaffected by the project profile.
- CI generation is explicit and refuses accidental overwrite.

Record each failure with the container image/version, `me` commit, harness
version, command, expected behavior, actual behavior, and relevant
`me doctor --json` output.
