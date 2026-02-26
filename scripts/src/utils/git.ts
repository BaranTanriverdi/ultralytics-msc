import { exec } from "./exec.js";

export async function gitRoot(): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

export async function diffNameOnly(base: string, head: string): Promise<string[]> {
  const { stdout } = await exec("git", ["diff", "--name-only", `${base}..${head}`]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function diffShortStat(
  base: string,
  head: string
): Promise<{ files: number; insertions: number; deletions: number }> {
  const { stdout } = await exec("git", ["diff", "--shortstat", `${base}..${head}`]);
  const filesMatch = stdout.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = stdout.match(/(\d+)\s+insertions?/);
  const deletionsMatch = stdout.match(/(\d+)\s+deletions?/);
  return {
    files: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0
  };
}

export async function revParse(ref: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", ref]);
  return stdout.trim();
}

export async function lsFiles(patterns: string[]): Promise<string[]> {
  const args = ["ls-files", "--"];
  args.push(...patterns);
  const { stdout } = await exec("git", args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function lastMergeThatTouched(path: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["log", "-n", "1", "--pretty=format:%H", path]);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch (_error) {
    return null;
  }
}

export async function readFileAtCommit(path: string, commit: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["show", `${commit}:${path}`]);
    return stdout;
  } catch (error: any) {
    if (error?.result?.exitCode === 128) {
      return null;
    }
    throw error;
  }
}
