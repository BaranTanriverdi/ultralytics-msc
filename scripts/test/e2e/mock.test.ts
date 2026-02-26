import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import fs from "fs-extra";
import { load } from "js-yaml";

const execAsync = promisify(exec);

const ROOT_DIR = join(__dirname, "../../..");
const SCRIPTS_DIR = join(ROOT_DIR, "scripts");
const TEST_WORKSPACE = join(ROOT_DIR, "test-workspace-e2e");
const LOCAL_SOURCE_REPO = join(SCRIPTS_DIR, "test/fixtures/basic-project");
const TARGET_DIR = join(TEST_WORKSPACE, "basic-project-test");

// Increase timeout for network operations and build
const TIMEOUT = 300000;

describe("End-to-End Integration Test (Mock Mode)", () => {
  beforeAll(async () => {
    // Clean up previous run
    await fs.remove(TEST_WORKSPACE);
    await fs.ensureDir(TEST_WORKSPACE);

    // Copy local test workspace instead of cloning
    // This allows offline testing and ensures we test against what's on disk
    if (!await fs.pathExists(LOCAL_SOURCE_REPO)) {
       throw new Error(`Local source repo not found at ${LOCAL_SOURCE_REPO}. Please ensure test-workspace is populated.`);
    }

    console.log(`Copying ${LOCAL_SOURCE_REPO} to ${TARGET_DIR}...`);
    await fs.copy(LOCAL_SOURCE_REPO, TARGET_DIR);

    // Initialize git in the target dir if it's not a git repo (copying might skip .git)
    // or just re-init to be safe and deterministic
    if (!await fs.pathExists(join(TARGET_DIR, ".git"))) {
        await execAsync("git init", { cwd: TARGET_DIR });
        await execAsync("git config user.email 'test@example.com'", { cwd: TARGET_DIR });
        await execAsync("git config user.name 'Test User'", { cwd: TARGET_DIR });
        await execAsync("git add .", { cwd: TARGET_DIR });
        await execAsync("git commit -m 'Initial commit'", { cwd: TARGET_DIR });
    }

    // Install assets
    console.log("Installing assets...");
    await fs.ensureDir(join(TARGET_DIR, "lib"));
    await fs.copy(join(ROOT_DIR, "lib/ml_system_card.schema.json"), join(TARGET_DIR, "lib/ml_system_card.schema.json"));
    await fs.copy(join(ROOT_DIR, "lib/proposal.schema.json"), join(TARGET_DIR, "lib/proposal.schema.json"));
    await fs.copy(join(ROOT_DIR, "lib/decisions.schema.json"), join(TARGET_DIR, "lib/decisions.schema.json"));

    // DEBUG
    console.log("Checking lib assets in:", join(TARGET_DIR, "lib"));
    console.log(await fs.readdir(join(TARGET_DIR, "lib")));

    const stakeDir = join(TARGET_DIR, "docs");
    await fs.ensureDir(stakeDir);
    await fs.copy(join(ROOT_DIR, "docs/stakeholders.yaml"), join(stakeDir, "stakeholders.yaml"));
  }, TIMEOUT);

  afterAll(async () => {
     // await fs.remove(TEST_WORKSPACE);
  });

  it("should generate and apply a ML system card proposal using Mock LLM", async () => {
    // 1. Run Generator
    console.log("Running Generator...");
    const generatorScript = join(SCRIPTS_DIR, "dist/scripts/src/actions/generator.js");

    // Get HEAD sha
    const { stdout: shaStdout } = await execAsync("git rev-parse HEAD", { cwd: TARGET_DIR });
    const headSha = shaStdout.trim();

    const env = {
      ...process.env,
      LLM_ENABLED: "true",
      LLM_DRY_RUN: "false", // We want to test the full pipeline
      LLM_PROVIDER: "mock", // Use our new mock provider
      LLM_MODEL: "mock-model",
      LLM_API_KEY: "mock-key",
      GITHUB_SHA: headSha
    };

    // Run Generator
    // Check files immediately before running node
    await execAsync(`ls -R lib && node "${generatorScript}" --run-id "test-e2e-mock-001" --base-sha ${headSha}`, {
      cwd: TARGET_DIR,
      env
    });

    // Verify proposal exists
    const proposalPath = join(TARGET_DIR, "docs/.proposals/test-e2e-mock-001.json");
    expect(await fs.pathExists(proposalPath)).toBe(true);

    const proposalContent = await fs.readJson(proposalPath);
    expect(proposalContent.facts.length).toBeGreaterThan(0);
    // Determine specific mock facts are present
    const hasMockFact = proposalContent.facts.some((f: any) => f.proposedValue === "Mock Engine (PyTorch)");
    expect(hasMockFact).toBe(true);


    // 2. Run Apply
    console.log("Running Apply...");
    const applyScript = join(SCRIPTS_DIR, "dist/scripts/src/actions/apply.js");

    // Use 0.0 threshold for mock because mock facts usually don't cover enough required fields
    await execAsync(`node "${applyScript}" --run-id "test-e2e-mock-001" --coverage-threshold 0.0`, {
      cwd: TARGET_DIR,
      env
    });

    // 3. Verify Output
    const cardPath = join(TARGET_DIR, "docs/ml_system_card.yaml");
    expect(await fs.pathExists(cardPath)).toBe(true);

    const content = await fs.readFile(cardPath, "utf-8");
    const yaml = load(content) as any;

    expect(yaml.meta).toBeDefined();
    expect(yaml.provenance.lastGeneratedAt).toBeDefined();
    // Verify the Mock Reasoner output was applied
    expect(yaml.ai?.engine).toBe("Mock Engine (PyTorch)");

  }, TIMEOUT);
});
