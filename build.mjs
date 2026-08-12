// Bundles the TypeScript UI and inlines it into a single self-contained
// dist/index.html — no external files, no network, just open it.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const template = join(root, "src", "template.html");
const outFile = join(root, "dist", "index.html");

const result = await build({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  write: false,
});

const js = result.outputFiles[0].text.trim();
const html = (await readFile(template, "utf8")).replace("/*__BUNDLE__*/", () => js);

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, html);
console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(1)} kB)`);
