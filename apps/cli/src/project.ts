import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isProjectRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "designer"))
    && fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"));
}

export function findProjectRoot(startDirectory = process.cwd()): string {
  const packageCandidate = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  if (isProjectRoot(packageCandidate)) return packageCandidate;
  let candidate = path.resolve(startDirectory);
  for (;;) {
    if (isProjectRoot(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("FormaSpec project root was not found. Run this command from the FormaSpec workspace.");
}

export function launcherPath(projectRoot: string): string {
  const launcher = path.join(projectRoot, "designer");
  const stat = fs.statSync(launcher);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) {
    throw new Error("The designer compatibility launcher is not executable.");
  }
  return launcher;
}
