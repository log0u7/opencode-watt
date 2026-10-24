// Static import-graph audit plus a plain-Node load smoke test for dist/.
//
// Static audit: the package must load under OpenCode 1.x AND 2.x hosts. V1
// hosts resolve `@opencode-ai/plugin`, V2 hosts resolve `@opencode/plugin`; a
// bare import the host cannot resolve fails the WHOLE plugin at load time. So
// the module graph reachable statically from the package entrypoints must
// never import `@opencode-ai/plugin`: the v1 implementation (dist/plugin.js)
// is only legal behind a dynamic `import()` issued by the dual entrypoint's
// `server()`. Every other bare import must be `@opencode/plugin` or a declared
// runtime dependency.
//
// Runtime smoke test: loads the built package under plain Node ESM, outside
// vitest, exactly as a consumer loads it.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");

let exitCode = 0;

function fail(message) {
  process.stderr.write(`smoke-dist: FAIL ${message}\n`);
  exitCode = 1;
}

// ---------------------------------------------------------------------------
// Static import-graph audit
// ---------------------------------------------------------------------------

// tsc emits ESM with double quotes; `import("x")` is dynamic, `from "x"` and
// `import "x"` are static.
const STATIC_SPEC = /(?:\bfrom\s*|\bimport\s*)(["'])((?:[^"'\\])+)\1/g;
const DYNAMIC_SPEC = /\bimport\s*\(\s*(["'])((?:[^"'\\])+)\1\s*\)/g;

// Hosts provide their own plugin API module; it must never be shipped or
// installed as a runtime dependency of this package.
const HOST_PROVIDED = new Set(["@opencode/plugin"]);

// Node builtins resolve everywhere; anything else bare must be declared.
function isNodeBuiltin(spec) {
  return spec.startsWith("node:");
}

function staticAndDynamicSpecs(file) {
  const text = readFileSync(file, "utf8");
  const statics = [];
  const dynamics = [];
  for (const match of text.matchAll(STATIC_SPEC)) statics.push(match[2]);
  for (const match of text.matchAll(DYNAMIC_SPEC)) dynamics.push(match[2]);
  return { statics, dynamics };
}

const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

// Static roots: `main` plus every `exports` default target pointing at dist/.
const entryFiles = new Set();
function addEntry(spec) {
  if (typeof spec !== "string" || !spec.endsWith(".js")) return;
  entryFiles.add(resolve(packageRoot, spec));
}
addEntry(pkg.main);
for (const value of Object.values(pkg.exports ?? {})) {
  if (typeof value === "string") addEntry(value);
  else if (value && typeof value === "object") addEntry(value.default);
}

const staticFiles = new Set();
const bareStatic = new Set();
const dynamicSpecs = new Set();
const queue = [...entryFiles];
while (queue.length > 0) {
  const file = queue.pop();
  if (staticFiles.has(file)) continue;
  staticFiles.add(file);
  const { statics, dynamics } = staticAndDynamicSpecs(file);
  for (const spec of statics) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = resolve(dirname(file), spec);
      if (target.endsWith(".js")) queue.push(target);
    } else {
      bareStatic.add(spec);
    }
  }
  for (const spec of dynamics) dynamicSpecs.add(spec);
}

if (bareStatic.has("@opencode-ai/plugin")) {
  fail(
    "static import graph imports @opencode-ai/plugin (v1-only package); v2 hosts reject the whole plugin at load time",
  );
}
const v1File = join(distDir, "plugin.js");
if (staticFiles.has(v1File)) {
  fail("dist/plugin.js (v1 implementation) is reachable from the static import graph");
}
if (!dynamicSpecs.has("./plugin.js")) {
  fail("entrypoint never dynamically imports ./plugin.js; v1 hosts would lose the server() entry");
}
const declaredDeps = new Set(Object.keys(pkg.dependencies ?? {}));
for (const spec of bareStatic) {
  if (isNodeBuiltin(spec)) continue;
  if (!HOST_PROVIDED.has(spec) && !declaredDeps.has(spec)) {
    fail(`static import of "${spec}": not @opencode/plugin and not in package.json dependencies`);
  }
}

// ---------------------------------------------------------------------------
// Runtime smoke test
// ---------------------------------------------------------------------------

try {
  const distUrl = new URL("../dist/index.js", import.meta.url);
  const module = await import(distUrl.href);

  if (typeof module.default !== "object" || module.default === null) {
    fail("default export is not an object");
  }
  if (typeof module.default.server !== "function") {
    fail("default export has no server() plugin factory (v1 entry)");
  }
  // The v2 entry: a host that loads the package for setup() must find it.
  if (typeof module.default.setup !== "function") {
    fail("default export has no setup() plugin factory (v2 entry)");
  }
  if (typeof module.default.id !== "string" || module.default.id.length === 0) {
    fail("default export has no plugin id (v2 entry)");
  }
} catch (error) {
  fail(error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error));
}

if (exitCode === 0) {
  process.stdout.write("smoke-dist: OK\n");
}
process.exit(exitCode);
