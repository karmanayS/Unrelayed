// yarn prove --note <note|file> --recipient <addr> --relayer <addr> --fee <wei> [--refund <wei>]
// Prints {proof, root, nullifierHash, recipient, relayer, fee, refund} as JSON.
import { parseArgs } from "node:util";
import type { Address } from "viem";
import { loadNote, proveWithdrawal } from "../lib/tornado.js";

const { values } = parseArgs({
  options: { note: { type: "string" }, recipient: { type: "string" }, relayer: { type: "string" }, fee: { type: "string", default: "0" }, refund: { type: "string", default: "0" } },
});
if (!values.note || !values.recipient || !values.relayer) {
  console.error("usage: yarn prove --note <note|file> --recipient <addr> --relayer <addr> --fee <wei> [--refund <wei>]");
  process.exit(2);
}
const n = await loadNote(values.note);
const p = await proveWithdrawal({ note: n.note, nullifierHash: n.nullifierHash, recipient: values.recipient as Address, relayer: values.relayer as Address, fee: BigInt(values.fee!), refund: BigInt(values.refund!) });
const { proof, root, nullifierHash, recipient, relayer, fee, refund } = p;
console.log(JSON.stringify({ proof, root, nullifierHash, recipient, relayer, fee, refund }, null, 2));
