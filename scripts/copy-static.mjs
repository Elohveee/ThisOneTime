/**
 * copy-static.mjs: copies non-TypeScript extension files into `dist/`.
 *
 * Purpose: Make `dist/` a complete folder for Chrome's "Load unpacked".
 * Usage:   Runs automatically as the last step of `pnpm build`.
 */
import { copyFile, mkdir } from "node:fs/promises";

const files = [
  ["manifest.json", "manifest.json"],
  ["src/app.html", "app.html"],
  ["src/app.css", "app.css"],
  // Toolbar and extension-page icons, plus the larger logo shown in the page header.
  ...[16, 32, 48, 128, 256].map((size) => [`icons/icon-${size}.png`, `icons/icon-${size}.png`]),
];

await mkdir(new URL("../dist/icons/", import.meta.url), { recursive: true });

for (const [source, target] of files) {
  await copyFile(new URL(`../${source}`, import.meta.url), new URL(`../dist/${target}`, import.meta.url));
}
