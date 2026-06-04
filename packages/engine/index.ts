// The engine package is the runtime layer over the new-model schemas:
//   - core:  control plane (core schema) — spaces, principals, membership,
//            groups, tree-access grants, api keys.
//   - space: data plane (per-space me_<slug> schema) — memory CRUD, tree, search.
// Namespaced so callers pick a plane explicitly: `core.coreStore`, `space.spaceStore`.
// Subpath imports (`@memory.build/engine/core`, `/space`) are equivalent.
export * as core from "./core";
export * as space from "./space";
