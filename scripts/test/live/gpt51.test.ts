import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import fs from "fs-extra";
import { load } from "js-yaml";

const execAsync = promisify(exec);

const ROOT_DIR = join(__dirname, "../..");
const SCRIPTS_DIR = join(ROOT_DIR, "scripts");
const TEST_WORKSPACE = join(ROOT_DIR, "test-workspace-e2e-live");
const LOCAL_SOURCE_REPO = join(SCRIPTS_DIR, "test/fixtures/basic-project");
const TARGET_DIR = join(TEST_WORKSPACE, "bhm-at-scale");

// Increase timeout for real LLM calls
const TIMEOUT = 1200000; // 20 minutes

describe("End-to-End Live Test (GPT-5.1)", () => {
  beforeAll(async () => {
    // Try to load .env from root if LLM_API_KEY is missing
    if (!process.env.LLM_API_KEY) {
       const envPath = join(ROOT_DIR, ".env");
       if (await fs.pathExists(envPath)) {
         console.log("Loading .env from", envPath);
         const envContent = await fs.readFile(envPath, "utf-8");
         envContent.split("\n").forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim().replace(/^["']|["']$/g, ""); // strip quotes
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
         });
       }
    }

    if (!process.env.LLM_API_KEY) {
      console.warn("Skipping live test because LLM_API_KEY is not set.");
      // We can't easily skip the whole suite dynamically in Vitest without throw/skip logic inside it(),
      // but for now we'll just let it fail or wrap logic in it().
    }

    // Clean up previous run
    await fs.remove(TEST_WORKSPACE);
    await fs.ensureDir(TEST_WORKSPACE);

    // Copy local test workspace
    if (!await fs.pathExists(LOCAL_SOURCE_REPO)) {
       throw new Error(`Local source repo not found at ${LOCAL_SOURCE_REPO}.`);
    }

    console.log(`Copying ${LOCAL_SOURCE_REPO} to ${TARGET_DIR}...`);
    await fs.copy(LOCAL_SOURCE_REPO, TARGET_DIR);

    // Initialize git
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

    const stakeDir = join(TARGET_DIR, "docs");
    await fs.ensureDir(stakeDir);
    await fs.copy(join(ROOT_DIR, "docs/stakeholders.yaml"), join(stakeDir, "stakeholders.yaml"));

    // Explicitly remove any existing card to force a full generation from scratch
    await fs.remove(join(TARGET_DIR, "docs/ml_system_card.yaml"));
    await fs.remove(join(TARGET_DIR, "docs/ml_system_card.anchors.json"));
  }, TIMEOUT);

  it("should generate a ML system card proposal using GPT-5.1", async () => {
    if (!process.env.LLM_API_KEY) {
      console.warn("Skipping test due to missing API key");
      return;
    }

    // 1. Run Generator
    console.log("Running Generator with GPT-5.1...");
    const generatorScript = join(SCRIPTS_DIR, "dist/scripts/src/actions/generator.js");

    // Get HEAD sha
    const { stdout: shaStdout } = await execAsync("git rev-parse HEAD", { cwd: TARGET_DIR });
    const headSha = shaStdout.trim();

    const env = {
      ...process.env,
      LLM_ENABLED: "true",
      LLM_DRY_RUN: "false",
      LLM_PROVIDER: "openai",
      LLM_MODEL: "gpt-5.1", // Retry with simple name
      // LLM_API_KEY is inherited from process.env
      GITHUB_SHA: headSha
    };

    // Run Generator
    try {
        const { stdout, stderr } = await execAsync(`node "${generatorScript}" --run-id "test-e2e-live-001" --base-sha ${headSha}`, {
        cwd: TARGET_DIR,
        env
        });
        console.log("Generator Output:", stdout);
        if (stderr) console.error("Generator Error Output:", stderr);
    } catch (e: any) {
        console.error("Generator failed:", e.stdout, e.stderr);
        throw e;
    }

    // Verify proposal exists
    const proposalPath = join(TARGET_DIR, "docs/.proposals/test-e2e-live-001.json");
    expect(await fs.pathExists(proposalPath)).toBe(true);

    const proposalContent = await fs.readJson(proposalPath);
    expect(proposalContent.facts.length).toBeGreaterThan(0);

    // Log some facts to see what GPT-5.1 found
    console.log("Generated Facts Sample:", JSON.stringify(proposalContent.facts.slice(0, 3), null, 2));

    // Force-accept all facts (simulate human review approval) to populating the card fully
    const decisions = proposalContent.facts.map((f: any) => ({
      jsonPath: f.jsonPath,
      decision: "accept"
    }));
    await fs.writeJson(join(TARGET_DIR, "docs/.proposals/test-e2e-live-001.decisions.json"), decisions, { spaces: 2 });
    console.log(`[TEST] Auto-approved ${decisions.length} facts via decisions file.`);

    // 2. Run Apply
    console.log("Running Apply...");
    const applyScript = join(SCRIPTS_DIR, "dist/scripts/src/actions/apply.js");

    await execAsync(`node "${applyScript}" --run-id "test-e2e-live-001" --coverage-threshold 0`, {
      cwd: TARGET_DIR,
      env
    });

    // 3. Verify Output
    const cardPath = join(TARGET_DIR, "docs/ml_system_card.yaml");
    expect(await fs.pathExists(cardPath)).toBe(true);

    const content = await fs.readFile(cardPath, "utf-8");
    const yaml = load(content) as any;

    expect(yaml.meta).toBeDefined();
    // We don't check for "Mock Engine" obviously.
    // Check if some content is generated.
    console.log("Final Card Content (Partial):", yaml.card?.name || yaml.ai?.engine);

  }, TIMEOUT);
});
