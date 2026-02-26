import { logger } from "./logger.js";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const API_BASE = "https://api.github.com";
const USER_AGENT = "ml-system-card-scripts";

interface RepoContext {
  owner: string;
  repo: string;
  token: string;
}

export class GithubError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GithubError";
  }
}

function resolveRepoContext(): RepoContext {
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!repoSlug) {
    throw new Error("GITHUB_REPOSITORY is not defined");
  }
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repoSlug}`);
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.ML_SYSTEM_CARD_GITHUB_TOKEN ?? process.env.PROTOTYPE_CARD_GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN or ML_SYSTEM_CARD_GITHUB_TOKEN must be set");
  }
  return { owner, repo, token };
}

async function githubRequest<T>(
  method: HttpMethod,
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> } = {}
): Promise<T> {
  const context = resolveRepoContext();
  const url = new URL(`${API_BASE}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (typeof value === "undefined") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.token}`,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new GithubError(text || response.statusText, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

type Label = { name?: string | null };

type MinimalPullRequest = {
  number: number;
  head: { ref: string };
  base: { ref: string };
  body?: string | null;
  labels?: Label[];
};

export async function findPullRequestByBranch(branch: string): Promise<MinimalPullRequest | null> {
  try {
    const context = resolveRepoContext();
    const pulls = await githubRequest<MinimalPullRequest[]>("GET", `/repos/${context.owner}/${context.repo}/pulls`, {
      query: {
        state: "open",
        head: `${context.owner}:${branch}`,
        per_page: 100
      }
    });
    return pulls.length > 0 ? pulls[0] : null;
  } catch (error) {
    logger.warn("Failed to find PR by branch", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function listOpenPullRequestsByBase(baseRef: string): Promise<MinimalPullRequest[]> {
  try {
    const context = resolveRepoContext();
    return await githubRequest<MinimalPullRequest[]>("GET", `/repos/${context.owner}/${context.repo}/pulls`, {
      query: {
        state: "open",
        base: baseRef,
        per_page: 100
      }
    });
  } catch (error) {
    logger.warn("Failed to list PRs by base", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export async function updatePullRequest(
  number: number,
  payload: { body?: string; state?: "open" | "closed" }
): Promise<void> {
  const context = resolveRepoContext();
  await githubRequest("PATCH", `/repos/${context.owner}/${context.repo}/pulls/${number}`, {
    body: payload
  });
}

export async function addLabels(number: number, labels: string[]): Promise<void> {
  if (labels.length === 0) {
    return;
  }
  const context = resolveRepoContext();
  await githubRequest("POST", `/repos/${context.owner}/${context.repo}/issues/${number}/labels`, {
    body: { labels }
  });
}

export async function removeLabel(number: number, label: string): Promise<void> {
  const context = resolveRepoContext();
  try {
    await githubRequest("DELETE", `/repos/${context.owner}/${context.repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) {
      return;
    }
    throw error;
  }
}

export async function createIssueComment(number: number, body: string): Promise<void> {
  const context = resolveRepoContext();
  await githubRequest("POST", `/repos/${context.owner}/${context.repo}/issues/${number}/comments`, {
    body: { body }
  });
}

export async function getPullRequestLabels(number: number): Promise<string[]> {
  const context = resolveRepoContext();
  const pr = await githubRequest<MinimalPullRequest>("GET", `/repos/${context.owner}/${context.repo}/pulls/${number}`);
  return (pr.labels ?? []).map((label) => label.name).filter((name): name is string => Boolean(name));
}
