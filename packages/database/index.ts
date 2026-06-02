// Control plane (`core` schema) and data plane (per-space `me_<slug>` schemas)
// live in one package; they are co-located in a single database/deployment.
// Kept as separate `core/` and `space/` modules so the boundary stays clean
// (space must not import core) and the split is easy to undo if spaces are ever
// distributed across databases again. The `auth` schema (better-auth-shaped
// users/sessions/accounts) is its own module for the same reason.
export * from "./auth";
export * from "./core";
export * from "./space";
