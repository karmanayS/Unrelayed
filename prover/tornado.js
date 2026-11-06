// Tornado note, commitment, Merkle tree and proof generation, ported as-is from the archived
// tornadocash/tornado-cli cli.js (createDeposit, parseNote, generateMerkleProof, generateProof), with the chain I/O
// removed: the caller passes the Deposit-event leaves in. Same dependency set as tornado-cli.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')
const snarkjs = require('snarkjs')
const circomlib = require('circomlib')
const merkleTree = require('fixed-merkle-tree')
const buildGroth16 = require('websnark/src/groth16')
const websnarkUtils = require('websnark/src/utils')

const bigInt = snarkjs.bigInt
const MERKLE_TREE_HEIGHT = 20

/** Generate random number of specified byte length */
const rbigint = (nbytes) => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))

/** Compute pedersen hash */
const pedersenHash = (data) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]

/** BigNumber to hex string of specified length */
function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)
  return '0x' + str.padStart(length * 2, '0')
}

/** Create deposit object from secret and nullifier */
function createDeposit({ nullifier, secret }) {
  const deposit = { nullifier, secret }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.commitmentHex = toHex(deposit.commitment)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  deposit.nullifierHex = toHex(deposit.nullifierHash)
  return deposit
}

/** A new random note in tornado-cli's format: tornado-<currency>-<amount>-<netId>-0x<nullifier‖secret> */
function newNote({ currency = 'eth', amount = '0.1', netId = 1337 } = {}) {
  const deposit = createDeposit({ nullifier: rbigint(31), secret: rbigint(31) })
  const note = toHex(deposit.preimage, 62)
  return { noteString: `tornado-${currency}-${amount}-${netId}-${note}`, deposit }
}

/** Parses Tornado.cash note (tornado-cli parseNote) */
function parseNote(noteString) {
  const noteRegex = /tornado-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g
  const match = noteRegex.exec(noteString)
  if (!match) throw new Error('The note has invalid format')
  const buf = Buffer.from(match.groups.note, 'hex')
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  const deposit = createDeposit({ nullifier, secret })
  return { currency: match.groups.currency, amount: match.groups.amount, netId: Number(match.groups.netId), deposit }
}

/**
 * Merkle tree and path for `deposit`, from the commitments of every Deposit event (tornado-cli generateMerkleProof).
 * `events` = [{ commitment: '0x…', leafIndex: n }]. The root/spent checks against the pool are done by the caller.
 */
function generateMerkleProof(deposit, events) {
  let leafIndex = -1
  const leaves = events
    .slice()
    .sort((a, b) => a.leafIndex - b.leafIndex) // Sort events in chronological order
    .map((e) => {
      const index = Number(e.leafIndex)
      if (bigInt(e.commitment).equals(bigInt(deposit.commitmentHex))) leafIndex = index
      return bigInt(e.commitment).toString(10)
    })
  const tree = new merkleTree(MERKLE_TREE_HEIGHT, leaves)
  assert(leafIndex >= 0, 'The deposit is not found in the tree')
  const { pathElements, pathIndices } = tree.path(leafIndex)
  return { root: tree.root(), pathElements, pathIndices, leafIndex }
}

/** Merkle root of the given events' commitments (used for T2.2). */
function computeRoot(events) {
  const leaves = events.slice().sort((a, b) => a.leafIndex - b.leafIndex).map((e) => bigInt(e.commitment).toString(10))
  return toHex(new merkleTree(MERKLE_TREE_HEIGHT, leaves).root())
}

let groth16, circuit, provingKey
async function loadProver(circuitsDir) {
  if (!groth16) groth16 = await buildGroth16()
  if (!circuit) circuit = require(path.join(circuitsDir, 'withdraw.json'))
  if (!provingKey) provingKey = fs.readFileSync(path.join(circuitsDir, 'withdraw_proving_key.bin')).buffer
}

/** Generate SNARK proof for withdrawal (tornado-cli generateProof) */
async function generateProof({ circuitsDir, deposit, events, recipient, relayerAddress = 0, fee = 0, refund = 0 }) {
  await loadProver(circuitsDir)
  const { root, pathElements, pathIndices, leafIndex } = generateMerkleProof(deposit, events)
  const input = {
    // Public snark inputs
    root: root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(recipient),
    relayer: bigInt(relayerAddress),
    fee: bigInt(fee),
    refund: bigInt(refund),
    // Private snark inputs
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements: pathElements,
    pathIndices: pathIndices,
  }
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, provingKey)
  const { proof } = websnarkUtils.toSolidityInput(proofData)
  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund),
  ]
  return { proof, args, leafIndex }
}

module.exports = { toHex, createDeposit, newNote, parseNote, generateMerkleProof, computeRoot, generateProof, pedersenHash, bigInt }
