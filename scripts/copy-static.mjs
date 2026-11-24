/**
 * copy-static.mjs: copies non-TypeScript extension files into `dist/`.
 *
 * Purpose: Make `dist/` a complete folder for Chrome's "Load unpacked".
 * Usage:   Runs automatically as the last step of `pnpm build`.
 */
import { copyFile } from "node:fs/promises";

const files = [
  ["manifest.json", "manifest.json"],
  ["src/app.html", "app.html"],
  ["src/app.css", "app.css"],
];

for (const [source, target] of files) {
  await copyFile(new URL(`../${source}`, import.meta.url), new URL(`../dist/${target}`, import.meta.url));
}
