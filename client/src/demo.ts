// yarn demo (BUILD-PLAN §S6): a narrated run for the video.
//   1 deposit  2 fresh recipient at 0 ETH  3 withdraw through TornadoExit  4 recipient funded + explorer link
//   5 the canonical mempool rejects the same kind of tx  6 a duplicate spend of one note is refused
// DEMO_PAUSE_MS (default 2500) sets the pause between steps.
import { concat, keccak256, numberToHex, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, ETHREX_URL, explorerTx } from "./config.js";
import { EXIT } from "./deployments.js";
import { registryAbi } from "./lib/abis.js";
import { explain } from "./lib/attempt.js";
import { operatorKey } from "./lib/env.js";
import { buildExitWithdrawTx, keyFor } from "./lib/exit.js";
import { encodeRaw, getReputation, sendFrameTx, type FrameReceipt } from "./lib/frameTx.js";
import { client, getBalance, rpc, sleep } from "./lib/rpc.js";
import { deposit, pool, type SavedNote } from "./lib/tornado.js";

const PAUSE = Number(process.env.DEMO_PAUSE_MS ?? 2500);
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
let n = 0;
const step = async (title: string) => {
  await sleep(PAUSE);
  console.log(`\n${B(`── ${++n}. ${title}`)}`);
};
const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;

/**
 * Waits for an admitted withdrawal to be mined. The devnet's block builder occasionally never includes an admitted tx,
 * and the sidecar then cancels it ("relayed N times without being included in a block"). If that happens, and only if
 * the note is provably untouched (not spent, its TornadoExit nonce slot unused), the same withdrawal is rebuilt and
 * resubmitted once, and the demo says so on screen.
 */
async function waitMinedOrResubmit(note: SavedNote, recipient: Address, first: Hex): Promise<{ hash: Hex; receipt: FrameReceipt }> {
  let hash = first;
  let resubmitted = false;
  const deadline = () => Date.now() + 180_000;
  let until = deadline();
  while (Date.now() < until) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return { hash, receipt };
    const status: string = await rpc("skandha_frameTransactionStatus", [hash]).then((x: any) => x.status, () => "unknown");
    if (status === "Cancelled") {
      const slot = keccak256(concat([pad(EXIT.address, { size: 32 }), numberToHex(keyFor(note.nullifierHash), { size: 32 })]));
      const untouched = !(await pool.isSpent(note.nullifierHash)) && BigInt(await rpc("eth_getStorageAt", [ADDR.NONCE_MANAGER, slot, "latest"])) === 0n;
      if (resubmitted || !untouched) throw new Error(`withdrawal ${hash} was cancelled by the mempool without being included${untouched ? " (twice)" : ""}; re-run the demo`);
      console.log(Y(`the devnet dropped ${hash.slice(0, 12)}… without including it (the note is untouched); resubmitting once…`));
      const again = await buildExitWithdrawTx(note, recipient);
      hash = await sendFrameTx(again.tx);
      console.log(G(`resubmitted and admitted: ${hash}`));
      resubmitted = true;
      until = deadline();
    }
    await sleep(2000);
  }
  throw new Error(`withdrawal ${hash} was not mined within 180 s; re-run the demo`);
}

console.log(B("Relayer-free Tornado Cash withdrawals on the ERC-8421 alternative mempool"));
const [stake, , withdrawTime] = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [EXIT.address] });
const rep = await getReputation(EXIT.address);
console.log(`TornadoExit ${EXIT.address}: staked ${eth(stake)} (devnet minimum 0.01 ETH), ${withdrawTime === 0n ? "locked" : "UNLOCKING"}, reputation ${rep?.status ?? "ok"}, balance ${eth(await getBalance(EXIT.address))}`);
console.log(`Tornado 0.1 ETH pool ${ADDR.TORNADO_POOL} (the unmodified, real contract)`);

await step("Deposit 0.1 ETH into Tornado (an ordinary deposit; we also make a second note for steps 5–6)");
const key = operatorKey();
const d1 = await deposit(key);
console.log(`deposit tx ${d1.saved.depositTx} → leaf ${d1.event.leafIndex}; note saved to ${d1.file}`);
console.log(`note: ${d1.saved.note.slice(0, 30)}…  (the secret; it never leaves this machine)`);
const d2 = await deposit(key);
console.log(`second deposit ${d2.saved.depositTx} → leaf ${d2.event.leafIndex}`);

await step("A brand-new wallet to withdraw to: no ETH, no history, it never signs anything");
const recipient = fresh();
console.log(`recipient ${recipient}: balance ${eth(await getBalance(recipient))}, nonce ${BigInt(await rpc("eth_getTransactionCount", [recipient, "latest"]))}`);
console.log("no relayer, no funded key: the only parties are this laptop, the mempool, TornadoExit and the Tornado pool");

await step("Withdraw through TornadoExit (frame tx: VERIFY proof in TornadoExit → SENDER Tornado.withdraw)");
// From here on nothing uses a funded key.
const w = await buildExitWithdrawTx(d1.saved, recipient);
console.log(`proof generated locally in ${(w.proof.proveMs / 1000).toFixed(1)} s; relayer = TornadoExit, fee ${eth(w.fee)} (= max gas cost ${eth(w.maxCost)} + 10 %)`);
console.log(`nonce key = nullifierHash ${w.proof.nullifierHash.slice(0, 18)}… (one slot per note)`);
const first = await sendFrameTx(w.tx);
console.log(G(`admitted by the ERC-8421 alt mempool: ${first}`));
const { hash, receipt: r } = await waitMinedOrResubmit(d1.saved, recipient, first);
console.log(`mined in block ${BigInt(r.blockNumber)}; frames ${JSON.stringify(r.frameReceipts?.map((f) => (f.status === "0x1" ? "ok" : "FAILED")))}`);

await step("The recipient is funded");
console.log(G(`recipient ${recipient}: ${eth(await getBalance(recipient))}`));
console.log(`explorer: ${explorerTx(hash)}`);

await step("The canonical EIP-8141 mempool (ethrex) refuses the same kind of transaction");
const recipientA = fresh();
const w2 = await buildExitWithdrawTx(d2.saved, recipientA);
try {
  await rpc("eth_sendRawTransaction", [encodeRaw(w2.tx)], ETHREX_URL);
  console.log(R("unexpected: ethrex accepted it"));
  process.exitCode = 1;
} catch (e) {
  console.log(R(`ethrex: ${(e as Error).message}`));
  console.log("(the proof check needs ~260k validation gas and reads Tornado's storage; the canonical mempool allows 100k and no foreign storage)");
}

await step("One note, two withdrawals at once: the mempool keeps only one");
const wa = w2;
const wb = await buildExitWithdrawTx(d2.saved, fresh());
const ha = await sendFrameTx(wa.tx);
console.log(G(`attempt A admitted: ${ha}`));
try {
  await sendFrameTx(wb.tx);
  console.log(R("unexpected: attempt B admitted too"));
  process.exitCode = 1;
} catch (e) {
  console.log(R(`attempt B refused: ${explain((e as Error).message)}`));
  console.log("(both use the nonce key = nullifierHash, so they occupy the same mempool slot; TornadoExit pays nothing for B)");
}
const { hash: haFinal, receipt: ra } = await waitMinedOrResubmit(d2.saved, recipientA, ha);
console.log(`attempt A mined in block ${BigInt(ra.blockNumber)}: ${explorerTx(haFinal)}`);
const rep2 = await getReputation(EXIT.address);
console.log(`\nTornadoExit reputation: ${rep2?.status} (seen ${rep2?.opsSeen}, included ${rep2?.opsIncluded}); balance ${eth(await getBalance(EXIT.address))}`);
console.log(B("done."));
