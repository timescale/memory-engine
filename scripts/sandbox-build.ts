// Builds the Docker sandbox image.
//
// Usage:
//   bun scripts/sandbox-build.ts [type]
//
// Type defaults to "claude". The base image is selected from docker/sandbox-templates.

import { $ } from "bun";

const type = process.argv[2] ?? "claude";
const baseImg = type === "claude" ? "claude-code" : type;

await $`docker build -f docker/sandbox.Dockerfile --build-arg BASE_IMG="${baseImg}" -t "me-sandbox:${type}" .`;

console.log(`\nImage built: me-sandbox:${type}`);
console.log(`Create sandbox with:\n  bun run sandbox:create <path>`);
