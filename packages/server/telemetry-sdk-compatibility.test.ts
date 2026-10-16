import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { satisfies } from "semver";

test("installed Logfire OTel peers satisfy upstream ranges and share one SDK across runtime workspaces", async () => {
  async function installedPackage(name: string, base: string) {
    let directory = dirname(Bun.resolveSync(name, base));
    while (directory !== dirname(directory)) {
      const file = Bun.file(resolve(directory, "package.json"));
      if (await file.exists()) {
        const manifest = (await file.json()) as {
          name: string;
          version: string;
          peerDependencies?: Record<string, string>;
        };
        if (manifest.name === name) return { directory, manifest };
      }
      directory = dirname(directory);
    }
    throw new Error(`No installed manifest for ${name}`);
  }
  for (const workspace of [
    "database",
    "embedding",
    "engine",
    "server",
    "worker",
  ]) {
    const logfire = await installedPackage(
      "@pydantic/logfire-node",
      resolve(import.meta.dir, "..", workspace),
    );
    const api = await installedPackage("logfire", logfire.directory);
    for (const owner of [logfire, api]) {
      for (const [name, range] of Object.entries(
        owner.manifest.peerDependencies ?? {},
      )) {
        if (!name.startsWith("@opentelemetry/")) continue;
        const peer = await installedPackage(name, owner.directory);
        expect(satisfies(peer.manifest.version, range)).toBe(true);
        // The installed entrypoint, not just its version, must be shared with
        // our instruments: duplicate SDK copies can silently split providers.
        expect(Bun.resolveSync(name, owner.directory)).toBe(
          Bun.resolveSync(name, import.meta.dir),
        );
      }
    }
  }
});
