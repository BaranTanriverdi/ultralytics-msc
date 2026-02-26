# Plan: Move to Synthetic Test Fixtures

## Problem
The current E2E testing strategy relies on an external repository (`bhm-at-scale`).
1.  **External dependency**: Downloading it from GitHub in CI is flaky and relies on a public repo.
2.  **Repo pollution**: "Vendoring" (committing) the full repo into `test-workspace/` is unacceptable as it adds unrelated project files to the tool's source.

## Solution
Replace the heavy `bhm-at-scale` dependency with a **minimal synthetic test fixture** (`scripts/test/fixtures/basic-project`).

### Benefits
*   **Zero external dependencies**: Tests run fully offline/isolated.
*   **Minimal footprint**: Only adds ~3 small files to the repo.
*   **Determinism**: We control the exact state of the test input.

## Implementation Steps
1.  [x] Create `scripts/test/fixtures/basic-project` directory.
2.  [x] Add minimal Python structure:
    *   `src/main.py`: Dummy code with imports (pandas, numpy).
    *   `requirements.txt`: Minimal dependencies.
    *   `README.md`.
3.  [x] Update `scripts/test/e2e.test.ts` to copy this fixture instead of `test-workspace/bhm-at-scale`.
4.  [x] Update `scripts/test/e2e-gpt51.test.ts` similarly.
5.  [ ] Clean up: Remove `test-workspace/bhm-at-scale` (or keep it strictly local/ignored).

## Verification
Run `npm test` to ensure the E2E tests pass with the new fixture.
