#!/usr/bin/env node
// JSON-in/JSON-out wrapper the TypeScript client spawns (Node 16). Reads one JSON request on stdin, writes one JSON
// result on stdout. Commands: newNote, parseNote, computeRoot, prove.
const path = require('path')
const t = require('./tornado')

const CIRCUITS_DIR = process.env.TORNADO_CIRCUITS_DIR || path.join(__dirname, 'circuits')

async function main() {
  const req = JSON.parse(require('fs').readFileSync(0, 'utf8'))
  switch (req.cmd) {
    case 'newNote': {
      const { noteString, deposit } = t.newNote({ netId: req.netId || 1337 })
      return { note: noteString, commitment: deposit.commitmentHex, nullifierHash: deposit.nullifierHex }
    }
    case 'parseNote': {
      const { deposit, currency, amount, netId } = t.parseNote(req.note)
      return { commitment: deposit.commitmentHex, nullifierHash: deposit.nullifierHex, currency, amount, netId }
    }
    case 'computeRoot':
      return { root: t.computeRoot(req.events) }
    case 'prove': {
      const { deposit } = t.parseNote(req.note)
      const started = Date.now()
      const { proof, args, leafIndex } = await t.generateProof({
        circuitsDir: CIRCUITS_DIR, deposit, events: req.events, recipient: req.recipient,
        relayerAddress: req.relayer, fee: req.fee, refund: req.refund || 0,
      })
      const [root, nullifierHash, recipient, relayer, fee, refund] = args
      return { proof, root, nullifierHash, recipient, relayer, fee, refund, leafIndex, proveMs: Date.now() - started }
    }
    default:
      throw new Error(`unknown cmd ${req.cmd}`)
  }
}

main().then(
  (out) => { process.stdout.write(JSON.stringify(out) + '\n'); process.exit(0) },
  (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1) },
)
