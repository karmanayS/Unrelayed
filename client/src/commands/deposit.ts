// yarn deposit: creates a note, deposits 0.1 ETH from the operator (legacy tx), saves the note under notes/.
import { explorerTx } from "../config.js";
import { operatorKey } from "../lib/env.js";
import { deposit } from "../lib/tornado.js";

const r = await deposit(operatorKey());
console.log(`deposited: tx ${r.saved.depositTx}  leafIndex ${r.event.leafIndex} (nextIndex before: ${r.nextIndexBefore})`);
console.log(`explorer: ${explorerTx(r.saved.depositTx!)}`);
console.log(`note saved to ${r.file}`);
console.log(`note: ${r.saved.note}`);
