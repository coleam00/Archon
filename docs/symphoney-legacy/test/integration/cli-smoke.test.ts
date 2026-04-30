import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

describe("CLI smoke", () => {
  it("exits non-zero when the workflow file does not exist", async () => {
    const proc = spawn("node", ["--import", "tsx", "src/index.ts", "/tmp/definitely-not-here.md"], {
      cwd: resolvePath(import.meta.dirname, "..", ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const exitCode: number = await new Promise((r) =>
      proc.on("exit", (c) => r(c ?? -1)),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/workflow file not found/);
  });

  it("prints help and exits 0 with --help", async () => {
    const proc = spawn("node", ["--import", "tsx", "src/index.ts", "--help"], {
      cwd: resolvePath(import.meta.dirname, "..", ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    const exitCode: number = await new Promise((r) =>
      proc.on("exit", (c) => r(c ?? -1)),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: symphony");
  });
});
