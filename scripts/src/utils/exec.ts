import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function exec(command: string, args: string[] = [], options: { cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", reject);

    child.on("close", (exitCode) => {
      const result: ExecResult = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: exitCode ?? 0
      };
      if (exitCode === 0) {
        resolve(result);
      } else {
        const error = new Error(`Command failed: ${command} ${args.join(" ")}`);
        (error as any).result = result;
        reject(error);
      }
    });
  });
}
