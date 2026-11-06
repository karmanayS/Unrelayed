# TornadoExit: relayer-free Tornado Cash withdrawals on the ERC-8421 alternative mempool

**ETHGlobal Mumbai 2026 · track: EF "Best use of the Frame Transaction Alternative Mempool"**

**Qualification tx** (a withdrawal from the real Tornado 0.1 ETH pool to a brand-new wallet; TornadoExit paid the
gas, no relayer, the recipient never signed anything):
https://explorer.altmempool.wtf/tx/0x7ee14bc425b7490f5f9e2ecf3cc16bf84bf6e6d46b060e8088a7b5c53e5c505d

## The problem and the fix

To withdraw privately from Tornado Cash to a fresh wallet, someone has to pay that withdrawal's gas, because the
fresh wallet has no ETH. Today that is a **relayer**: an off-chain service that sees your IP address, can log you,
can refuse you, and can be shut down. **TornadoExit** replaces the relayer with a staked smart contract that *is the
sender* of every withdrawal: an EIP-8141 frame transaction, submitted to the ERC-8421 alternative mempool, in which
TornadoExit first checks the zero-knowledge proof and Tornado's state, then agrees to pay the gas, and the
**unmodified** Tornado pool pays it back through the fee it already pays relayers. You make the proof on your own
machine and name any fresh address. You sign nothing and need no ETH.

## How it works

### The transaction (the only shape TornadoExit approves)

```
FrameTx (type 0x06, profile ethrex-eip8141-tracer)
  sender      = TornadoExit
  nonceKeys   = [ uint256(nullifierHash) ]        // EIP-8250 keyed nonce: one mempool slot per note
  nonceSeq    = 0
  signatures  = []                                 // a contract sender needs none
  frames:
    [0] VERIFY  target = TornadoExit  scope = EXECUTION_AND_PAYMENT
                data = verifyWithdrawal()
    [1] SENDER  target = Tornado pool  value = 0
                data = withdraw(proof, root, nullifierHash, recipient, relayer = TornadoExit, fee, refund = 0)
                limits: execution ≥ 603,000, state ≥ 352,000
```

`fee = ceil(MAX_COST × 1.10)`, where `MAX_COST` is the transaction's worst-case gas cost (ethrex's `TXPARAM 0x06`).
The withdrawal pays `0.1 ETH − fee` to the recipient and `fee` to TornadoExit. Measured on the devnet: fee
0.0031359 ETH, actual gas 0.0017847 ETH, **TornadoExit nets +0.0013511 ETH per withdrawal** (T5.6).

### What `verifyWithdrawal()` checks (all inside the VERIFY frame)

| # | Check | Why | Code |
|---|---|---|---|
| C0 | `msg.sender == ENTRY_POINT (0x…aa)` | Only callable as a frame | [L84](contracts/src/TornadoExit.sol#L84) |
| C1 | `FRAME_COUNT == 2`, `CURRENT_FRAME_INDEX == 0` | Exact shape; no extra frames we would pay for | [L87–88](contracts/src/TornadoExit.sol#L87-L88) |
| C2 | Frame 1: mode SENDER, target = pool, value 0, no ATOMIC_BATCH flag | Only Tornado withdrawals | [L91–94](contracts/src/TornadoExit.sol#L91-L94) |
| C3 | Frame 1 data: exact length (516 bytes), selector `0x21a0adb6`, proof exactly 256 bytes, clean address words | No malformed calldata | [L97–123](contracts/src/TornadoExit.sol#L97-L123) |
| C4 | `relayer == TornadoExit`, `refund == 0`, `fee <= denomination` | We get reimbursed; Tornado's own rules | [L134–136](contracts/src/TornadoExit.sol#L134-L136) |
| C5 | `fee >= txparam(MAX_COST)` | The fee covers the worst-case gas cost | [L139–140](contracts/src/TornadoExit.sol#L139-L140) |
| C6 | `recipient != 0` (see [limitations](#trade-offs-and-limitations)) | | [L145](contracts/src/TornadoExit.sol#L145) |
| C7 | one nonce key, `== nullifierHash`, `nonceSeq == 0` | Mempool-level dedup: one slot per note, ever | [L148–150](contracts/src/TornadoExit.sol#L148-L150) |
| C8 | Frame 1 execution limit ≥ 603,000 and state limit ≥ 352,000 | The withdrawal cannot be made to run out of gas | [L153–154](contracts/src/TornadoExit.sol#L153-L154) |
| C9 | `isKnownRoot(root)`, `!isSpent(nullifierHash)` | Reads Tornado's storage (allowed for a staked entity, STORAGE-032) | [L157–158](contracts/src/TornadoExit.sol#L157-L158) |
| C10 | Groth16 proof valid for `[root, nullifierHash, recipient, relayer, fee, refund]` | Core check | [L161–164](contracts/src/TornadoExit.sol#L161-L164) |
| C11 | `address(this).balance >= MAX_COST` | SELFBALANCE (staked only): fail admission, not later | [L167](contracts/src/TornadoExit.sol#L167) |
| C12 | `approve(EXECUTION_AND_PAYMENT)` | Last statement | [L170](contracts/src/TornadoExit.sol#L170) |

Also: [`receive()`](contracts/src/TornadoExit.sol#L176) accepts Tornado's fee and never reaches `approve`;
[`fallback()`](contracts/src/TornadoExit.sol#L178) reverts; owner-only [`stake`](contracts/src/TornadoExit.sol#L188),
[`unlockStake`](contracts/src/TornadoExit.sol#L192), [`withdrawStake`](contracts/src/TornadoExit.sol#L196),
[`withdrawFunds`](contracts/src/TornadoExit.sol#L200). `stake()` makes the registry stake TornadoExit itself
(0.012 ETH, 86,400 s delay).

**Why TornadoExit cannot lose money on a withdrawal it approves:** nothing runs between frame 0 and frame 1. Frame 1
can only fail if Tornado's `withdraw` reverts. C2–C4 and C9–C10 replay every check `withdraw` makes, and C8
guarantees enough gas. The one remaining case is a recipient contract that reverts on receive, covered below.

**The embedded verifier.** The pool's own predeployed Verifier calls the pairing precompiles with
`staticcall(sub(gas, 2000), …)`. The mempool rejects that inside VERIFY ("payer uses banned opcode: GAS", because GAS
is allowed only immediately before a `*CALL`). [`Groth16TornadoVerifier`](contracts/src/Groth16TornadoVerifier.sol)
is the same verification, with the same verifying key, the same input parsing and the same field checks, but with
[`staticcall(gas(), …)`](contracts/src/Groth16TornadoVerifier.sol#L79). TornadoExit uses it in VERIFY. The pool still
verifies the proof again with its own unmodified Verifier during the withdrawal. Evidence: all 28 VK constants are
PUSH32 operands of the deployed Verifier, in order (T4.1); 3 real proofs × 8 cases give identical results on both
(T4.2); `yarn check:bytecode` shows every GAS is followed by a `*CALL` (T4.3).

## Why this needs the ERC-8421 alternative mempool

| Needed by TornadoExit | Canonical EIP-8141 mempool | ERC-8421 alt mempool (staked) |
|---|---|---|
| ~293k gas of validation (proof check ~261k) | 100,000 cap → **rejected** | 1,000,000 per staked entity |
| Read Tornado's storage (`isKnownRoot`, `isSpent`) | only the sender's own storage | STORAGE-032: read-only access to any non-entity contract |
| SELFBALANCE (C11) | banned | OPCODES-010: allowed when staked |
| Duplicate attempts must not pile up | — | keyed nonce = nullifierHash: one pending tx per `(sender, key)` |

Evidence, from the same transaction bytes:
- **Canonical mempool** (ethrex `eth_sendRawTransaction`, T5.4): `Invalid params: Frame transaction prefix gas
  budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
- **Unstaked TornadoExit** (same code, same constructor arguments, no stake, T5.5): `payer uses banned opcode:
  SELFBALANCE`. With the storage reads alone, an unstaked probe gets `unstaked payer accessed 0xf8d7…73fc slot …`
  (T3.5).
- **Duplicate spend** (T5.3): a second withdrawal of the same note to another recipient is refused at submission
  with `Frame transaction cannot be replaced: fee too low`. Only one is included, TornadoExit pays nothing for the
  other, and its reputation stays `ok`.

## Setup and run

Requirements: Foundry (solc 0.8.28 is pinned), Node 24 (`client/`), **Node 16** (`prover/`, the 2019 Tornado
proving stack), yarn 1.

```sh
# install
yarn --cwd client install
yarn --cwd contracts install                       # hegota-support Solidity sources
PATH=<node16>/bin:$PATH yarn --cwd prover install  # circomlib / snarkjs / websnark (Node 16)
yarn fetch-circuits                                # tornado-core v2.0 withdraw.json + proving key, sha256-checked
forge build --root contracts

# .env (gitignored), at the repo root
OPERATOR_PRIVATE_KEY=0x…        # yarn --cwd client setup:key generates it (deposits, deploys, stake only)
PROVER_NODE=<node16>/bin/node   # the Node 16 binary used for proving
# optional: RPC_URL (default the sidecar https://altmempool.forshtat.com/rpc), EXIT_ADDRESS, DEMO_PAUSE_MS

yarn check:devnet               # chain 1337, predeploys, pool parameters, sidecar, reset detection
yarn cli deposit                # 0.1 ETH deposit from the operator key; prints + saves the note under notes/
yarn cli withdraw --note notes/note-….json [--to 0x…]   # relayer-free withdrawal; uses NO funded key
yarn cli status --note notes/note-….json
yarn test:e2e                   # T5.1–T5.7 against the devnet with fresh notes and recipients
yarn demo                       # the narrated run used in the video
yarn check:bytecode             # GAS-opcode rule check of the compiled contracts
```

Setup of your own TornadoExit: `yarn --cwd client setup:fund` (one transfer from the published genesis key, which
must be in `.env` as `GENESIS_PRIVATE_KEY` for that one run), then `yarn --cwd client deploy:exit` (deploy with a 0.3
ETH float, then `stake()`), then set `EXIT_ADDRESS`. Section test suites: `yarn --cwd client test:s1 … test:s5`.

## Deployed on the devnet (chain 1337)

| Contract | Address | Tx |
|---|---|---|
| **TornadoExit** (live, staked 0.012 ETH / 86,400 s) | `0x5bcf973fbd8f50610061821cd7a83baf818828c3` | [deploy](https://explorer.altmempool.wtf/tx/0xdae6a4535ec8806b3f9629f6745beeb48aa7b35eedf1dcc7244053d0f9a22b75), [stake](https://explorer.altmempool.wtf/tx/0xda698c66011da63997d0e5c4a965cd14a52fc2bfdbf50056bfb45ee5fc76ac40) |
| Groth16TornadoVerifier | `0x01163fc3ee187d4ff4234b47ff08d0238b5c6fd1` | [deploy](https://explorer.altmempool.wtf/tx/0xd01b14f300cf4d1a44419f461efef7c32e9abfc7e39e76b4db92a748a1f77b4c) |
| Tornado 0.1 ETH pool (predeploy, unmodified) | `0xF8d72424D07721aB219cdbd2852657F3301673fC` | |
| Tornado Verifier (predeploy, unmodified) | `0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01` | |
| NaiveStakingRegistry (ERC-8421) | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` | |

Transactions:
- Qualification withdrawal (T5.1): [`0x7ee14bc4…505d`](https://explorer.altmempool.wtf/tx/0x7ee14bc425b7490f5f9e2ecf3cc16bf84bf6e6d46b060e8088a7b5c53e5c505d)
- Demo withdrawal: [`0x8afb0b6e…8301`](https://explorer.altmempool.wtf/tx/0x8afb0b6e64c63b335220ef8d199ca8fd74e41854c4e8729402773bf833418301)
- Explorer reputation view (TornadoExit staked, `ok`): https://explorer.altmempool.wtf/reputation

Every test, with its tx hashes and node messages, is logged in [PROGRESS.md](PROGRESS.md).

## Findings on the devnet (worth knowing if you build on it)

1. **The predeployed Tornado pool uses its original Dec-2019 verifier.** tornado-cli's proving key is the later
   (post-ceremony, v2.1) one and produces proofs this Verifier rejects. The matching key is the tornado-core **v2.0**
   release, and it only proves correctly with websnark at v2.0's own pin (`peppersec/websnark#c254b596`); the newer
   websnark produces invalid proofs with it. `prover/` uses v2.0's circuit and key (sha256-pinned) with that websnark.
2. **GAS inside VERIFY** must be immediately followed by a `*CALL`, which old snarkjs verifiers violate. Hence the
   embedded verifier.
3. **EXTCODESIZE on an address with no code is rejected** inside validation (`payer accesses un-deployed contract
   address … with opcode EXTCODESIZE`), staked or not. So "recipient has no code" cannot be checked in VERIFY.
4. **ethrex needs more execution gas *limit* than it reports as used** for a withdrawal that creates a new account and
   a new storage slot: it reports 306,907 used but fails below a ≈481,627 limit. Gas minimums must come from the
   smallest limit that succeeds, not from `gasUsed`. C8 uses 481,627 × 1.25 → 603,000.
5. A reverted SENDER frame still consumes the keyed nonce.

## Trade-offs and limitations

- **Tiny anonymity set.** The devnet pool has a few dozen deposits, all ours. The privacy comes from the pool, not
  from this project.
- **Network-level privacy is separate.** The node you submit to sees your IP address. Use Tor or an anonymising RPC.
  The Merkle tree is rebuilt from plain `eth_getLogs` reads of `Deposit` events; an anonymising RPC could hide those
  too.
- **Contract recipients (C6 dropped).** The mempool forbids touching an address with no code during validation, so
  TornadoExit cannot check that the recipient is not a contract that reverts on receive. A reverting recipient makes
  frame 1 revert and costs TornadoExit one transaction's gas (≈ 0.0012 ETH on the devnet, T5.2 l). The loss is bounded:
  that transaction consumes the note's keyed nonce, and C7 requires nonce 0, so **each note can cost TornadoExit at
  most one failed transaction, ever**. The attacker needs a fresh 0.1 ETH deposit per attempt (recoverable by a normal
  withdrawal). The client refuses recipients with code, so honest users never hit this.
- **Revalidation churn.** Every new deposit changes the pool's root history, and a proof stays usable only while its
  root is among the pool's last 30 roots. A pending withdrawal whose root falls out of that window fails C9, so its
  VERIFY frame no longer approves and it cannot be included or paid for. It has to be re-proved against a newer root.
  (Not exercised by our tests: the devnet pool is too quiet.)
- **Embedded verifier.** VERIFY uses our verifier (identical key and maths, different gas plumbing), and the pool
  re-verifies with its own. If the two ever disagreed, the worst case is one failed transaction per note (see above),
  never a wrong withdrawal.
- **Nonce keys are not truncated.** The devnet accepts 256-bit keys (T3.2), so the key is the nullifier hash itself.
- **Stake is never slashed.** ERC-8421 stake only buys mempool permissions and reputation.
- **Tornado Cash's legal history.** We use it because it is the best-known mainnet privacy pool and it is predeployed
  here unmodified. The design applies to any Merkle-root privacy pool that pays a relayer fee; Railgun is
  predeployed on this devnet as the production-grade target.
- **Frame transactions are not on mainnet yet.** EIP-8141 / ERC-8421 run here on a public throwaway devnet.

## Prior art

- **Privacy-preserving Paymaster** (ETHGlobal Lisbon 2023): an ERC-4337 approach.
- **Himitsu** (ETHGlobal Tokyo 2026): a custom pool and a patched mempool.

How this project differs: it uses the **unmodified, real Tornado pool** (replayed on the devnet from its original mainnet deployment), the
**standard ERC-8421 mempool** with no patches, an **ERC-8421 stake** for the permissions it needs, and **keyed-nonce
dedup** (nonce key = nullifier hash), so the mempool itself refuses duplicate spends.

## Repository layout

```
contracts/   Foundry: src/TornadoExit.sol, src/Groth16TornadoVerifier.sol, src/probes/*.sol (validation-rule probes)
prover/      Tornado note, commitment, Merkle tree, proof generation (port of tornado-cli; Node 16)
client/      TypeScript: devnet config, frame-tx builder (@forshtat/hegota-support), CLI, demo, devnet test suites
PROGRESS.md  section-by-section log: evidence, tx hashes, node messages, escalations and decisions
```

## AI usage disclosure

The project's idea, architecture and build plan were written by the author, who also made every design decision
recorded as an "ESCALATION" in [PROGRESS.md](PROGRESS.md). The implementation was produced with an AI coding agent
(Claude Code, Anthropic) working under that plan. That covers the code in `contracts/`, `prover/` and `client/`, the
devnet test suites, and the first drafts of this README and PROGRESS.md. Every claim in this README is backed by a
test that ran against the public devnet and is logged in PROGRESS.md.

## License

MIT, see [LICENSE](LICENSE). `prover/tornado.js` ports MIT/ISC code from tornadocash/tornado-cli; the verifying key in
`Groth16TornadoVerifier.sol` comes from tornadocash/tornado-core v2.0 (MIT); the frame-tx approach follows
forshtat/mempool-workshop (MIT).
