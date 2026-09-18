import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "..", "images", "branding", "ledger-l", "web");
const target = join(root, "..", "apps", "web", "public", "assets", "lara");
const manifest = {};

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

async function walk(dir) {
  for (const entry of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else {
      const bytes = await readFile(path);
      manifest[relative(source, path).replaceAll("\\", "/")] = createHash("sha256").update(bytes).digest("hex");
    }
  }
}

await walk(source);
await writeFile(join(target, "asset-manifest.json"), JSON.stringify({ source: "images/branding/ledger-l/web", files: manifest }, null, 2) + "\n");
console.log(`Packaged ${Object.keys(manifest).length} approved Ledger-L assets.`);
