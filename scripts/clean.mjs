/**
 * clean.mjs: removes the previous build.
 *
 * Purpose: Prevent deleted source files from lingering in `dist/`.
 * Usage:   pnpm clean
 */
import { rm } from "node:fs/promises";

await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
