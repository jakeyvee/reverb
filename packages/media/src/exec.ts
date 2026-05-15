import { spawn, type SpawnOptions } from "node:child_process";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

// Thin wrapper around child_process.spawn that buffers stdout/stderr. Tests
// inject a fake to assert the exact argv ffmpeg/ffprobe are invoked with,
// without having to ship a real binary.
export type Runner = (
  cmd: string,
  args: readonly string[],
  opts?: SpawnOptions,
) => Promise<ExecResult>;

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

export class MediaProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: readonly string[],
    public readonly result: ExecResult,
  ) {
    const tail = result.stderr.trim().split("\n").slice(-3).join(" / ") || result.stdout.trim();
    super(`${command} exited ${result.code}: ${tail || "no stderr"}`);
    this.name = "MediaProcessError";
  }
}
