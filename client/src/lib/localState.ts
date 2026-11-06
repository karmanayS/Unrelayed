// Small gitignored JSON file for local, non-secret bookkeeping (last block seen, etc.).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = path.join(REPO_ROOT, "notes", "local-state.json");

export function readLocalState(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeLocalState(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...readLocalState(), ...patch }, null, 2) + "\n");
}
