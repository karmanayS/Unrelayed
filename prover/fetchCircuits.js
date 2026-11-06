// Downloads the tornado-core v2.0 release circuit and proving key (the ones matching the devnet's original Dec-2019
// Verifier, see PROGRESS.md ESCALATION 1) into prover/circuits/, and checks their sha256.
const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')

const RELEASE = 'https://github.com/tornadocash/tornado-core/releases/download/v2.0'
const FILES = {
  'withdraw.json': '8ee950ce8476ce7d43aa4f3c2243adc446e17f00ce0a05935f7462e31af3b2bc',
  'withdraw_proving_key.bin': '95a7024dfd37e9e872762487c32d6534e0bc298e13f07a2bec1b9f6a1d57a5c9',
  'withdraw_verification_key.json': 'a29cdf7c8c0285454c1b91794e8127b4a32a0a41ccf1f58578a85f5ab5896ac4',
}
const dir = path.join(__dirname, 'circuits')

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(res.headers.location))
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`))
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

;(async () => {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, want] of Object.entries(FILES)) {
    const file = path.join(dir, name)
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) === want) {
      console.log(`ok   ${name} (cached)`)
      continue
    }
    const buf = await get(`${RELEASE}/${name}`)
    const got = sha(buf)
    if (got !== want) throw new Error(`${name}: sha256 ${got} != expected ${want}`)
    fs.writeFileSync(file, buf)
    console.log(`ok   ${name} (${buf.length} bytes, sha256 ${got})`)
  }
})().catch((e) => { console.error(e.message); process.exit(1) })
