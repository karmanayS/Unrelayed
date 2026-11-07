# Unrelayed

**Withdraw from Tornado Cash to a brand-new wallet with no relayer. A staked contract pays your gas.**

ETHGlobal Mumbai 2026 · EF track: Best use of the Frame Transaction Alternative Mempool

Example withdrawal on the public devnet (the real Tornado 0.1 ETH pool, a never-used recipient, no relayer, nothing
signed by the user):
https://explorer.altmempool.wtf/tx/0x7ee14bc425b7490f5f9e2ecf3cc16bf84bf6e6d46b060e8088a7b5c53e5c505d

## What it does

To withdraw privately from Tornado Cash you withdraw to a fresh wallet. A fresh wallet has no ETH, so it can't pay the
gas for its own withdrawal. Today a **relayer** pays it: an off-chain server that sends your transaction for a fee. The
relayer sees your IP address, can log you, can refuse you, and can be shut down.

Unrelayed replaces the relayer with **TornadoExit**, a staked smart contract that sends the withdrawal itself. It uses
EIP-8141 frame transactions and the ERC-8421 alternative mempool. TornadoExit checks the zero-knowledge proof and
Tornado's state on-chain, agrees to pay the gas only if everything is valid, and gets the gas back from the fee Tornado
already pays relayers.

As a user you:
- make the proof on your own machine;
- name any address, including one that has never been used;
- sign nothing, and need no ETH.

## How it works

### The withdrawal transaction

Every withdrawal is one frame transaction with exactly this shape:

```
sender      = TornadoExit
nonceKeys   = [ nullifierHash ]      // one mempool slot per note
nonceSeq    = 0
signatures  = none
frames:
  [0] VERIFY  TornadoExit.verifyWithdrawal()       // checks everything, then agrees to pay
  [1] SENDER  TornadoPool.withdraw(proof, root, nullifierHash, recipient, relayer = TornadoExit, fee, refund = 0)
```

- **Frame 0** is where TornadoExit decides whether to pay.
- **Frame 1** is an ordinary call to the **unmodified** Tornado pool. The pool sends `0.1 ETH − fee` to the recipient
  and `fee` to TornadoExit.
- **The fee** is the transaction's worst-case gas cost plus 10 %. On the devnet that's about 0.0031 ETH, of which about
  0.0018 ETH is actual gas, so TornadoExit nets about +0.0014 ETH per withdrawal.

### What TornadoExit checks before it pays

| Check | Why | Code |
|---|---|---|
| Called by the protocol's entry point | Only runs as a frame of a transaction | [L84](contracts/src/TornadoExit.sol#L84) |
| Exactly 2 frames, and this is frame 0 | No extra frames for TornadoExit to pay for | [L87–88](contracts/src/TornadoExit.sol#L87-L88) |
| Frame 1 is a plain call to the Tornado pool, with no ETH value and no batching | Only Tornado withdrawals | [L91–94](contracts/src/TornadoExit.sol#L91-L94) |
| Frame 1's calldata is a well-formed `withdraw` with a 256-byte proof | No malformed input | [L97–123](contracts/src/TornadoExit.sol#L97-L123) |
| Relayer is TornadoExit, refund is 0, fee ≤ 0.1 ETH | TornadoExit gets reimbursed | [L134–136](contracts/src/TornadoExit.sol#L134-L136) |
| Fee ≥ the transaction's maximum gas cost | The fee always covers the gas | [L139–140](contracts/src/TornadoExit.sol#L139-L140) |
| Recipient isn't the zero address | | [L145](contracts/src/TornadoExit.sol#L145) |
| Nonce key = the note's nullifier hash, nonce 0 | One withdrawal attempt per note, ever | [L148–150](contracts/src/TornadoExit.sol#L148-L150) |
| Frame 1 gets at least 603,000 execution gas and 352,000 state gas | The withdrawal can't be made to run out of gas | [L153–154](contracts/src/TornadoExit.sol#L153-L154) |
| Tornado knows the Merkle root, and the note isn't spent | Reads Tornado's state | [L157–158](contracts/src/TornadoExit.sol#L157-L158) |
| The Groth16 proof is valid for these exact public inputs | The core check | [L161–164](contracts/src/TornadoExit.sol#L161-L164) |
| TornadoExit can afford the maximum gas cost | Fail early, not later | [L167](contracts/src/TornadoExit.sol#L167) |
| Approve paying for execution and gas | Only after everything above passed | [L170](contracts/src/TornadoExit.sol#L170) |

Nothing can run between frame 0 and frame 1. These checks replay everything Tornado's `withdraw` checks and guarantee
it enough gas, so an approved withdrawal succeeds and TornadoExit is paid back. The one exception is a recipient
contract that rejects ETH (see [Limitations](#limitations)).

TornadoExit also accepts Tornado's fee through [`receive()`](contracts/src/TornadoExit.sol#L176), which never approves
anything. Its owner can [`stake`](contracts/src/TornadoExit.sol#L188),
[`unlockStake`](contracts/src/TornadoExit.sol#L192), [`withdrawStake`](contracts/src/TornadoExit.sol#L196) and
[`withdrawFunds`](contracts/src/TornadoExit.sol#L200).

### Proof verification inside the check

Tornado's own on-chain Verifier calls the elliptic-curve precompiles in a way the mempool's validation rules forbid
(`staticcall(sub(gas, 2000), …)`). So the check uses
[`Groth16TornadoVerifier`](contracts/src/Groth16TornadoVerifier.sol): the same verification, with the same verifying
key, the same input parsing and the same field checks, but calling the precompiles with `staticcall(gas(), …)`. During
the withdrawal itself, Tornado still verifies the proof again with its own unmodified Verifier.

## Why it needs the ERC-8421 alternative mempool

| TornadoExit needs | Canonical EIP-8141 mempool | ERC-8421 mempool, staked entity |
|---|---|---|
| ~290k gas to validate (the proof check alone is ~260k) | 100,000 gas cap | 1,000,000 |
| To read Tornado's storage (roots, spent notes) | only the sender's own storage | read access to other contracts |
| To check its own balance | not allowed | allowed |
| To stop duplicate attempts piling up | — | one pending transaction per `(sender, nonce key)` |

What happens on the devnet:
- **The canonical mempool** rejects the same transaction: `Frame transaction prefix gas budget (frames + sig cost)
  exceeds MAX_VERIFY_GAS`.
- **An unstaked copy of TornadoExit** is rejected: `payer uses banned opcode: SELFBALANCE`. The stake is what unlocks
  the design.
- **A second withdrawal of the same note** is refused at submission: `Frame transaction cannot be replaced: fee too
  low`. TornadoExit pays nothing for it, and its reputation stays clean.

## Run it

Requirements: Foundry, Node 24 (`client/`), Node 16 (`prover/`, which uses the original Tornado proving stack), yarn 1.

```sh
# install
yarn --cwd client install
yarn --cwd contracts install
PATH=<node16>/bin:$PATH yarn --cwd prover install
yarn fetch-circuits              # Tornado's withdraw circuit + proving key (sha256-checked)
forge build --root contracts

# .env at the repo root (gitignored)
OPERATOR_PRIVATE_KEY=0x…         # only for deposits and admin; `yarn --cwd client setup:key` generates one
PROVER_NODE=<node16>/bin/node

# devnet ETH for deposits (one-time). The devnet has no faucet: one account is funded at genesis and its key is
# published in forshtat/mempool-workshop-sidecar, deploy/devnet/genesis.values.env. Put that key in .env as
# GENESIS_PRIVATE_KEY, then:
yarn --cwd client setup:key      # generates OPERATOR_PRIVATE_KEY into .env (skip if you already set one)
FUND_ETH=1 yarn --cwd client setup:fund   # one transfer from the genesis account to your operator key
# afterwards remove GENESIS_PRIVATE_KEY from .env. 1 ETH covers ~9 deposits; `yarn demo` uses 2 per run.

# use it
yarn check:devnet                # is the devnet up, and are the contracts there?
yarn cli deposit                 # deposit 0.1 ETH; prints and saves your note in notes/
yarn cli withdraw --note notes/note-….json [--to 0x…]   # relayer-free withdrawal; uses no funded key
yarn cli status --note notes/note-….json                # deposited? spent?
yarn demo                        # narrated walkthrough
yarn test:e2e                    # end-to-end tests against the devnet
```

`withdraw` generates a fresh recipient wallet if you don't pass `--to`, and prints its key once. It never touches a
funded key.

The prover uses the circuit and proving key from tornado-core's v2.0 release, because the devnet's Tornado pool is the
original 2019 deployment.

## Deployed (public devnet, chain 1337)

| Contract | Address |
|---|---|
| **TornadoExit** (staked 0.012 ETH, 1-day unstake delay) | `0x5bcf973fbd8f50610061821cd7a83baf818828c3` |
| Groth16TornadoVerifier | `0x01163fc3ee187d4ff4234b47ff08d0238b5c6fd1` |
| Tornado Cash 0.1 ETH pool (unmodified) | `0xF8d72424D07721aB219cdbd2852657F3301673fC` |
| Tornado Verifier (unmodified) | `0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01` |
| ERC-8421 staking registry | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |

Explorer: [example withdrawal](https://explorer.altmempool.wtf/tx/0x7ee14bc425b7490f5f9e2ecf3cc16bf84bf6e6d46b060e8088a7b5c53e5c505d)
· [reputation view](https://explorer.altmempool.wtf/reputation) (TornadoExit: staked, status OK)

## Limitations

- **Small anonymity set on the devnet.** The privacy comes from the pool, and the devnet pool has few deposits.
- **Your IP address.** The node you submit to can see it. Use Tor or a private RPC; the same goes for the
  `eth_getLogs` reads used to rebuild the Merkle tree.
- **Recipients that reject ETH.** The mempool doesn't allow reading a fresh address's code during validation, so
  TornadoExit can't rule out a recipient contract that reverts on receive. Such a withdrawal fails and costs TornadoExit
  one transaction's gas, but it also uses up that note's only nonce slot, so each note can cost TornadoExit at most one
  failed attempt. The CLI refuses recipients that have code, so honest users never hit this.
- **Root freshness.** A proof is only valid while its Merkle root is among Tornado's last 30 roots. A withdrawal that
  waits too long has to be re-proved.
- **Stake is never slashed.** It only buys mempool permissions and reputation.
- **Not on mainnet yet.** Frame transactions and the ERC-8421 mempool run on a public test network today.
- **Tornado Cash** is used because it's the best-known privacy pool and runs here unmodified. The same design works
  for any Merkle-tree privacy pool that pays a relayer fee; Railgun is the natural next target.

## Repository

```
contracts/   TornadoExit.sol, Groth16TornadoVerifier.sol, and small probe contracts for the mempool's rules
prover/      Tornado notes, Merkle tree and proof generation (Node 16)
client/      TypeScript client: frame-transaction builder, CLI, demo, devnet tests
```

## AI usage

I designed Unrelayed end to end:
- the idea of a staked contract as the shared sender that replaces relayers;
- the transaction shape and every check TornadoExit makes before it pays;
- nullifier-hash nonce keys for deduplication, and the staking model;
- the testing approach: everything against the live devnet, no mocks.

I also made the design calls during the build, including:
- switching to Tornado's v2.0 proving key;
- the validation-safe verifier;
- the one-attempt-per-note limit for recipients that reject ETH;
- the gas minimums.

I used Claude Code (Anthropic) to help with the implementation: writing code from my design, running the devnet tests,
and drafting documentation.

## License

MIT, see [LICENSE](LICENSE). `prover/tornado.js` ports code from tornadocash/tornado-cli. The verifying key in
`Groth16TornadoVerifier.sol` comes from tornadocash/tornado-core v2.0 (MIT). The frame-transaction approach follows
forshtat/mempool-workshop (MIT).
