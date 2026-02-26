import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

vi.mock("../src/utils/git.js", () => ({
  diffNameOnly: vi.fn(),
  lsFiles: vi.fn(),
}));

import { computeIncrementalFileSet } from "../src/incremental_set.js";
import { diffNameOnly, lsFiles } from "../src/utils/git.js";

const FIXTURE_ROOT = resolve(process.cwd(), "test/fixtures/incremental");

async function seedFixtures() {
  await mkdir(dirname(resolve(FIXTURE_ROOT, "entry.ts")), { recursive: true });
  await writeFile(
    resolve(FIXTURE_ROOT, "entry.ts"),
    [
      "import './second';",
      "const value = require('./data.json');",
      "console.log(value);",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    resolve(FIXTURE_ROOT, "second.ts"),
    [
      "import './nested/third';",
      "export const answer = 42;",
    ].join("\n"),
    "utf8",
  );
  await mkdir(resolve(FIXTURE_ROOT, "nested"), { recursive: true });
  await writeFile(
    resolve(FIXTURE_ROOT, "nested/third.ts"),
    "export const third = 'ok';\n",
    "utf8",
  );
  await writeFile(resolve(FIXTURE_ROOT, "data.json"), JSON.stringify({ ok: true }), "utf8");

  // Python setup
  await mkdir(resolve(FIXTURE_ROOT, "pkg"), { recursive: true });
  await writeFile(resolve(FIXTURE_ROOT, "pkg/__init__.py"), "", "utf8");
  await writeFile(
    resolve(FIXTURE_ROOT, "pkg/main.py"),
    "from .sub import val\n",
    "utf8"
  );
  await writeFile(
    resolve(FIXTURE_ROOT, "pkg/sub.py"),
    "val = 1\n",
    "utf8"
  );
}

describe("computeIncrementalFileSet", () => {
  beforeAll(async () => {
    await seedFixtures();
  });

  afterAll(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns changed files, neighbor graph up to two hops, and critical paths", async () => {
  const relativeEntry = `test/fixtures/incremental/entry.ts`;
    const diffNameOnlyMock = vi.mocked(diffNameOnly);
    const lsFilesMock = vi.mocked(lsFiles);
    diffNameOnlyMock.mockResolvedValue([relativeEntry]);
    lsFilesMock.mockResolvedValue(["README.md"]);

    const result = await computeIncrementalFileSet("base", "head");

    expect(result.changed).toEqual([relativeEntry]);
    expect(new Set(result.neighbors)).toEqual(
      new Set([
        relativeEntry,
        "test/fixtures/incremental/second.ts",
        "test/fixtures/incremental/data.json",
      ]),
    );
    expect(result.critical).toEqual(["README.md"]);
    expect(result.combined).toEqual(
      expect.arrayContaining([
        relativeEntry,
        "test/fixtures/incremental/second.ts",
        "test/fixtures/incremental/data.json",
        "README.md",
      ]),
    );
  });

  it("resolves python relative imports", async () => {
    vi.mocked(diffNameOnly).mockResolvedValue(["test/fixtures/incremental/pkg/main.py"]);
    vi.mocked(lsFiles).mockResolvedValue([]);

    const result = await computeIncrementalFileSet("base", "head");
    // Should find sub.py via "from .sub import val"
    expect(result.neighbors).toContain("test/fixtures/incremental/pkg/sub.py");
  }, 10000);
});
