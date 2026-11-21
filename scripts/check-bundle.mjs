// Enforces specs/12-ios-platform.feature against the built bundle.
import { readFileSync } from "node:fs";

const bundle = readFileSync("main.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const problems = [];

const nodeModules = ["fs", "path", "os", "crypto", "child_process", "electron", "http", "https", "net"];
for (const name of nodeModules) {
  const pattern = new RegExp(`require\\(["'](node:)?${name}["']\\)`);
  if (pattern.test(bundle)) problems.push(`bundle requires Node/Electron module "${name}"`);
}
if (/\bfetch\s*\(/.test(bundle)) problems.push("bundle calls fetch(); use requestUrl");
if (/XMLHttpRequest/.test(bundle)) problems.push("bundle uses XMLHttpRequest; use requestUrl");
if (/\(\?<[=!]/.test(bundle)) problems.push("bundle contains a regex lookbehind (breaks iOS < 16.4)");
if (/process\.platform/.test(bundle)) problems.push("bundle reads process.platform; use Platform");
if (/FileSystemAdapter/.test(bundle)) problems.push("bundle references FileSystemAdapter");
if (manifest.isDesktopOnly !== false) problems.push("manifest isDesktopOnly must be false");
if (manifest.id !== "brandon-gitsidian") problems.push("manifest id must be brandon-gitsidian");

if (problems.length) {
  console.error("iOS bundle check failed:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log(`iOS bundle check passed (${(bundle.length / 1024).toFixed(1)} KB)`);
