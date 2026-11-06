// Loads the repo-root .env (gitignored) into process.env without overriding values already set.
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { REPO_ROOT } from "./localState.js";

export const ENV_FILE = path.join(REPO_ROOT, ".env");

export function loadEnv(): void {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (put it in ${ENV_FILE})`);
  return v;
}

export const operatorKey = (): Hex => requireEnv("OPERATOR_PRIVATE_KEY") as Hex;

export function appendEnv(name: string, value: string): void {
  const cur = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  if (new RegExp(`^${name}=`, "m").test(cur)) throw new Error(`${name} already in ${ENV_FILE}; refusing to overwrite`);
  fs.writeFileSync(ENV_FILE, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + `${name}=${value}\n`, { mode: 0o600 });
  process.env[name] = value;
}
