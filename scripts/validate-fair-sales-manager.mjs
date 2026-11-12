import fs from "node:fs";
import path from "node:path";

const root = path.resolve("Fair-sales-manager");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html");
const app = read("app.js");
const css = read("styles.css");
const sw = read("sw.js");
const config = read("config.js");
const manifest = JSON.parse(read("manifest.webmanifest"));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(/<!doctype html>/i.test(html), "HTML5 doctype is missing.");
check(/<html[^>]+lang=/i.test(html), "HTML language attribute is missing.");
check(/name="viewport"/i.test(html), "Viewport meta tag is missing.");
check(/<title>[^<]+<\/title>/i.test(html), "Page title is missing.");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
check(duplicateIds.length === 0, `Duplicate HTML IDs: ${duplicateIds.join(", ")}`);

for (const id of ["auth", "authform", "app", "fairSelect", "employee", "saleform", "owner", "ownerNavigation", "sync", "entryStatus"]) {
  check(ids.includes(id), `Required element #${id} is missing.`);
}

for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|webmanifest|svg)(?:\?[^"]*)?)"/g)) {
  if (/^https?:\/\//i.test(reference)) continue;
  const localPath = reference.split("?")[0];
  check(fs.existsSync(path.join(root, localPath)), `Referenced asset is missing: ${localPath}`);
}

check(manifest.display === "standalone", "PWA display mode should be standalone.");
check(manifest.start_url && manifest.scope, "PWA start_url/scope are missing.");
for (const icon of manifest.icons || []) {
  check(fs.existsSync(path.join(root, icon.src)), `PWA icon is missing: ${icon.src}`);
}
for (const file of ["./index.html", "./styles.css", "./config.js", "./app.js", "./manifest.webmanifest", "./icon.svg"]) {
  check(sw.includes(`"${file}"`), `Service worker precache list is missing ${file}.`);
}
check(/sb_publishable_[A-Za-z0-9_-]+/.test(config), "Supabase publishable key is missing.");
check(!/service_role|sb_secret_/i.test(config), "A server-only Supabase key must never be shipped in config.js.");
check(css.includes("#employee"), "Employee workspace styles are missing.");
check(app.includes("savePendingSale") && app.includes("syncPendingSales"), "Offline sales queue/sync code is missing.");
check(app.includes("assignedFairIds.has(item.fair_id)"), "Pending sales sync must be limited to currently assigned fairs.");

if (failures.length) {
  console.error("Fair Sales Manager validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Fair Sales Manager static validation passed (${ids.length} unique HTML IDs, PWA assets and core safety checks).`);
}
