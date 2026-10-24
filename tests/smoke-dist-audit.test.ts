// Negative-path tests for the static import-graph audit in
// scripts/smoke-dist.mjs. The guard must FAIL when a v1-only package becomes
// statically reachable again, when the dynamic import() disappears, or when an
// undeclared bare dependency appears, and PASS on a pristine dual-entrypoint
// package. Each case builds a synthetic package in a temp dir, copies the real
// auditor next to its own dist (the script resolves the package root from its
// own location), and runs it under plain Node.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const auditor = fileURLToPath(new URL("../scripts/smoke-dist.mjs", import.meta.url));

const dirs: string[] = [];

function buildFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-watt-audit-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  cpSync(auditor, join(root, "scripts", "smoke-dist.mjs"));
  return root;
}

function runAuditor(root: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "scripts", "smoke-dist.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const PRISTINE_INDEX = `const load = () => import("./plugin.js");
export default {
  id: "fixture",
  setup: async () => () => {},
  async server(...args) {
    const { plugin } = await load();
    return plugin(...args);
  },
};
`;

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  version: "0.0.0",
  type: "module",
  main: "./dist/index.js",
});

function baseFixture(indexJs: string): Record<string, string> {
  return {
    "package.json": PACKAGE_JSON,
    "dist/index.js": indexJs,
    "dist/plugin.js": "export const plugin = async () => ({});\n",
  };
}

describe("smoke-dist static import-graph audit", () => {
  it("passes on a pristine dual-entrypoint package", () => {
    const root = buildFixture(baseFixture(PRISTINE_INDEX));
    const result = runAuditor(root);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("smoke-dist: OK");
    expect(result.status).toBe(0);
  });

  it("fails when @opencode-ai/plugin is statically imported", () => {
    const root = buildFixture(
      baseFixture(`import { tool } from "@opencode-ai/plugin";\n${PRISTINE_INDEX}`),
    );
    const result = runAuditor(root);
    expect(result.stderr).toContain("static import graph imports @opencode-ai/plugin");
    expect(result.status).toBe(1);
  });

  it("fails when dist/plugin.js is statically reachable", () => {
    const root = buildFixture(
      baseFixture(`import { plugin } from "./plugin.js";\n${PRISTINE_INDEX}`),
    );
    const result = runAuditor(root);
    expect(result.stderr).toContain(
      "dist/plugin.js (v1 implementation) is reachable from the static import graph",
    );
    expect(result.status).toBe(1);
  });

  it("fails when the entrypoint has no dynamic import of ./plugin.js", () => {
    const root = buildFixture(
      baseFixture(
        'export default {\n  id: "fixture",\n  setup: async () => () => {},\n  server: async () => ({}),\n};\n',
      ),
    );
    const result = runAuditor(root);
    expect(result.stderr).toContain("entrypoint never dynamically imports ./plugin.js");
    expect(result.status).toBe(1);
  });

  it("fails on a bare import that is neither @opencode/plugin nor declared", () => {
    const root = buildFixture(baseFixture(`import { z } from "zod";\n${PRISTINE_INDEX}`));
    const result = runAuditor(root);
    expect(result.stderr).toContain('static import of "zod"');
    expect(result.status).toBe(1);
  });
});
