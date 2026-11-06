# Demo script (≤ 3 minutes)

Record with a terminal (large font, dark theme) on the left and the explorer (https://explorer.altmempool.wtf) in a
browser on the right. Before recording: `yarn check:devnet` must pass and the operator must hold ≥ 0.3 ETH. Then run
`DEMO_PAUSE_MS=6000 yarn demo` (about 2 minutes with that pacing). The step numbers below match the demo's output.

| Time | Shot | Say (roughly) |
|---|---|---|
| 0:00–0:20 | Title card, or the README's first lines | "Withdrawing privately from Tornado Cash to a brand-new wallet needs someone to pay gas. Today that's a relayer: a server that sees your IP, can log you, can refuse you, can be shut down. We replace it with a staked contract on the ERC-8421 alternative mempool." |
| 0:20–0:35 | Terminal: demo header (TornadoExit staked 0.012 ETH, reputation ok; the real Tornado pool) | "TornadoExit is an EIP-8141 smart account that is the sender of every withdrawal. It's staked in the ERC-8421 registry. The Tornado pool is the real, unmodified contract." |
| 0:35–0:50 | Step 1: deposit | "An ordinary 0.1 ETH deposit. The note is the secret, and it never leaves this laptop." |
| 0:50–1:00 | Step 2: fresh recipient at 0 ETH, nonce 0 | "We withdraw to a wallet that has never existed: no ETH, and it will never sign anything." |
| 1:00–1:35 | Step 3: proof generated locally; "admitted by the ERC-8421 alt mempool"; frames ok,ok | "The proof is made locally. The transaction has two frames. In the VERIFY frame TornadoExit checks the Groth16 proof, reads Tornado's state, checks the exact shape and that the fee covers the worst-case gas, and only then approves paying. The SENDER frame calls Tornado's withdraw with TornadoExit as the relayer, so Tornado pays the fee back to it. No relayer, no funded key." |
| 1:35–1:55 | Step 4: recipient balance 0.0969 ETH; switch to the browser and open the explorer link | "The new wallet has 0.1 ETH minus the fee. On the explorer: sender TornadoExit, both frames succeeded." |
| 1:55–2:20 | Step 5: ethrex rejects ("prefix gas budget … exceeds MAX_VERIFY_GAS") | "Why only the alternative mempool can do this: the proof check needs about 260 thousand gas of validation and reads another contract's storage. The canonical mempool allows 100 thousand gas and only the sender's storage, so it refuses this exact transaction. An unstaked copy of TornadoExit is refused too. The stake is what unlocks it." |
| 2:20–2:45 | Step 6: attempt A admitted, attempt B refused ("cannot be replaced: fee too low") | "Every withdrawal's nonce key is the note's nullifier hash. Two attempts to spend one note occupy the same mempool slot, so the mempool keeps only one. Duplicates can't pile up or cost TornadoExit anything." |
| 2:45–3:00 | Final line (reputation ok, balance) + README "Deployed" table | "TornadoExit earns a small margin on every withdrawal and its reputation stays clean. Contracts, the test log and the qualification transaction are in the repo." |

Shot list:
1. Title / README header (qualification tx link visible).
2. Terminal: `DEMO_PAUSE_MS=6000 yarn demo`, from the header through step 6.
3. Browser: explorer page of the step-4 transaction (frames, sender = TornadoExit).
4. Browser (optional, 3 s): explorer **Reputation** tab showing TornadoExit `isStaked`, status ok.
5. README "Deployed on the devnet" table.

Fallbacks: if the devnet is slow, cut the waits in editing. If it was reset, re-run setup per PROGRESS.md before
recording. Don't show `notes/` or `.env` on screen.
