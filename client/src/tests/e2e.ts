// yarn test:e2e (BUILD-PLAN §S6): T5.1–T5.7 against the devnet with fresh notes and fresh recipients, plus the devnet
// sanity check first. Exits non-zero on any failure.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { NOTES_DIR } from "../lib/tornado.js";

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("npx", ["tsx", ...args], { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;

const started = Date.now();
if (run(["src/checkDevnet.ts"]) !== 0) {
  console.error("e2e: devnet check failed");
  process.exit(1);
}
const results = path.join(NOTES_DIR, `e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const code = run(["src/tests/s5.ts", "t51", "t52", "t53", "t54", "t55", "t56", "t57"], { SWEEP: "1", FRESH_UNSTAKED: "1", S5_RESULTS: results });
console.log(`\ne2e ${code === 0 ? "PASSED" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(0)} s (results: ${results})`);
process.exit(code);
