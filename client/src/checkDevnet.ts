// yarn check:devnet — S0 sanity checks (BUILD-PLAN §S0 task 5). Exits non-zero on any failure.
// Checks every URL given in CHECK_URLS (comma separated), default: sidecar and gateway.
import { ADDR, CHAIN_ID, GATEWAY_URL, SIDECAR_URL, TORNADO } from "./config.js";
import { tornadoAbi } from "./lib/abis.js";
import { blockNumber, getCode, publicClientFor, rpc, sleep } from "./lib/rpc.js";
import { readLocalState, writeLocalState } from "./lib/localState.js";
import { OUR_CONTRACTS } from "./deployments.js";

const urls = (process.env.CHECK_URLS ?? `${SIDECAR_URL},${GATEWAY_URL}`).split(",").map((s) => s.trim()).filter(Boolean);
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

async function checkUrl(url: string) {
  console.log(`\n== ${url}`);
  const pc = publicClientFor(url);
  const chainId = Number(await rpc("eth_chainId", [], url));
  check(chainId === CHAIN_ID, "chainId", String(chainId));

  const clientVersion: string = await rpc("web3_clientVersion", [], url);
  check(/skandha/i.test(clientVersion), "web3_clientVersion contains skandha", clientVersion);

  const codeTargets: [string, `0x${string}`][] = [
    ["Tornado pool", ADDR.TORNADO_POOL],
    ["Tornado Verifier", ADDR.TORNADO_VERIFIER],
    ["NaiveStakingRegistry", ADDR.STAKING_REGISTRY],
    ["NONCE_MANAGER", ADDR.NONCE_MANAGER],
    ["RECENT_ROOT (0x…8272)", ADDR.RECENT_ROOT],
  ];
  for (const [name, a] of codeTargets) {
    const code = await getCode(a, url);
    check(code !== "0x" && code.length > 2, `code at ${name} ${a}`, `${(code.length - 2) / 2} bytes`);
  }

  const read = (functionName: "levels" | "denomination" | "verifier" | "nextIndex") =>
    pc.readContract({ address: ADDR.TORNADO_POOL, abi: tornadoAbi, functionName });
  const [levels, denomination, verifier, nextIndex] = await Promise.all([read("levels"), read("denomination"), read("verifier"), read("nextIndex")]);
  check(Number(levels) === TORNADO.levels, "pool levels() == 20", String(levels));
  check(denomination === TORNADO.denomination, "pool denomination() == 1e17", String(denomination));
  check(String(verifier).toLowerCase() === ADDR.TORNADO_VERIFIER.toLowerCase(), "pool verifier() == Tornado Verifier", String(verifier));

  const b0 = await blockNumber(url);
  const t0 = Date.now();
  let b1 = b0;
  while (Date.now() - t0 < 15_000 && b1 <= b0) {
    await sleep(2000);
    b1 = await blockNumber(url);
  }
  check(b1 > b0, "blocks advance within 15 s", `${b0} -> ${b1} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`INFO  current block ${b1}, Tornado nextIndex() = ${nextIndex}`);

  // Reset detection (BUILD-PLAN §0.5): the block height must never drop, and our own contracts must still exist.
  const st = readLocalState();
  if (st.maxBlockSeen !== undefined) {
    check(b1 >= BigInt(st.maxBlockSeen), "block height did not drop since last check (no devnet reset)", `last seen ${st.maxBlockSeen}, now ${b1}`);
  }
  if (st.maxBlockSeen === undefined || b1 > BigInt(st.maxBlockSeen)) writeLocalState({ maxBlockSeen: b1.toString() });
  for (const [name, a] of Object.entries(OUR_CONTRACTS)) {
    const code = await getCode(a, url);
    check(code !== "0x", `our contract ${name} ${a} still has code`, `${(code.length - 2) / 2} bytes`);
  }
}

for (const url of urls) {
  try {
    await checkUrl(url);
  } catch (e) {
    check(false, `checks against ${url} threw`, (e as Error).message);
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
