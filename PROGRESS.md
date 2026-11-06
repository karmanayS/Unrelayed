# PROGRESS

Section log, evidence and escalations (BUILD-PLAN §0.1). Times are IST.

## Devnet resets
- none observed so far (first check: block 3594 on 2026-11-06 ~18:20 IST).

## S0. Environment and devnet sanity — PASSED (started 17:55, done ~18:25 IST, ~30 min)

Tooling: Foundry `forge 1.6.0-v1.7.0`, Node 24.22.2 (LTS) for `client/`, Node 16.20.2 installed for the legacy
Tornado stack in `prover/`, yarn 1.22.22. `client/` deps: `viem`, `@forshtat/hegota-support@0.0.1`.

Read: `forshtat/mempool-workshop` (`src/lib/frameTx/*`, steps 3/7/11/12), `forshtat/mempool-workshop-sidecar`
(`deployments/devnet.md`, `deploy/devnet`), docs pages devnet / prefix / opcodes / storage / budget / staking /
use-cases / admission-reports / keyed-nonces / signatures / constants.

Notes that matter later:
- `deployments/devnet.md` reports that websnark's WASM prover produced cryptographically wrong proofs for the
  sidecar author, who then wrote a pure-JS prover. S2 will try the exact tornado-cli stack first (plan), and
  escalate if T2.3 fails.
- hegota-support marks `TXPARAM`, `FRAMEPARAM`, `FRAMEDATALOAD`, `FRAMEDATACOPY` on this devnet as "from the EIP
  text, not yet exercised on the devnet" — T3.7 exercises them.
- Sidecar keyed-nonce rules: one pending tx per `(sender, key)`; same slot = replacement needing a 10 % fee bump.

### T0.1 `yarn check:devnet` (sidecar + gateway) — PASS
```

== https://altmempool.forshtat.com/rpc
PASS  chainId: 1337
PASS  web3_clientVersion contains skandha: skandha/v4.1.1-
PASS  code at Tornado pool 0xF8d72424D07721aB219cdbd2852657F3301673fC: 6615 bytes
PASS  code at Tornado Verifier 0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01: 4723 bytes
PASS  code at NaiveStakingRegistry 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f: 1259 bytes
PASS  code at NONCE_MANAGER 0x0000000000000000000000000000000000008250: 5 bytes
PASS  code at RECENT_ROOT (0x…8272) 0x0000000000000000000000000000000000008272: 144 bytes
PASS  pool levels() == 20: 20
PASS  pool denomination() == 1e17: 100000000000000000
PASS  pool verifier() == Tornado Verifier: 0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01
PASS  blocks advance within 15 s: 3600 -> 3601 in 4.6 s
INFO  current block 3601, Tornado nextIndex() = 0

== https://altmempoolgateway.forshtat.com/rpc
PASS  chainId: 1337
PASS  web3_clientVersion contains skandha: skandha/v4.1.1-
PASS  code at Tornado pool 0xF8d72424D07721aB219cdbd2852657F3301673fC: 6615 bytes
PASS  code at Tornado Verifier 0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01: 4723 bytes
PASS  code at NaiveStakingRegistry 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f: 1259 bytes
PASS  code at NONCE_MANAGER 0x0000000000000000000000000000000000008250: 5 bytes
PASS  code at RECENT_ROOT (0x…8272) 0x0000000000000000000000000000000000008272: 144 bytes
PASS  pool levels() == 20: 20
PASS  pool denomination() == 1e17: 100000000000000000
PASS  pool verifier() == Tornado Verifier: 0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01
PASS  blocks advance within 15 s: 3601 -> 3602 in 2.2 s
INFO  current block 3602, Tornado nextIndex() = 0
PASS  block height did not drop since last check (no devnet reset): last seen 3601, now 3602

all checks passed
```
