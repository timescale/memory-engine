#!/usr/bin/env bun
/**
 * Generate a random 32-byte (256-bit) master key for ACCOUNTS_MASTER_KEY.
 *
 * Usage:
 *   bun scripts/generate-master-key.ts
 */
import { randomBytes } from "node:crypto";

const key = randomBytes(32).toString("hex");
console.log(key);
