// Privacy leak scanner. Deploy/merge gate for this repo.
//
//   node scripts/lint-privacy.mjs              # scan content/ (+ public/ if built)
//   node scripts/lint-privacy.mjs --self-test  # ALSO prove the scanner works against
//                                              # tests/privacy-fixtures/ (what CI runs;
//                                              # needs no vault access)
//
// Violation classes:
//   E1 private/coordinate frontmatter key present
//   E2 "## Private Notes" heading (or remnant text in built output)
//   E3 canary marker present (vault marker = real leak; fixture marker = test string
//      escaping the fixtures folder)
//   E4 coordinate-shaped value in location context (decimal degrees with >=4 decimal
//      places near words like lat/longitude/GPS/coordinates, or any DMS string).
//      Plain numbers — dimensions, densities, dates, hardness, geological ages —
//      are NOT flagged.
//   E5 image in content/ still carries EXIF/GPS metadata
//
// With the vault reachable (../rock-archive or ROCK_VAULT_DIR), also runs a positive
// control: the vault's Privacy Canary must exist — proving this scanner would catch
// it if it ever leaked. In CI the vault is absent and that check is skipped;
// --self-test provides the CI-safe proof instead.

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, findVault, parseNote, isPrivateKey, VAULT_CANARY, FIXTURE_CANARY } from './lib/vault-export.mjs'

const SELF_TEST = process.argv.includes('--self-test')
const CONTENT = path.join(REPO_ROOT, 'content')
const PUBLIC = path.join(REPO_ROOT, 'public')
const FIXTURES = path.join(REPO_ROOT, 'tests', 'privacy-fixtures')

const CONTEXT_RE = /(lat\b|latitude|lon\b|lng\b|longitude|gps|coordinates?\b|coord\b|waypoint|location|°\s*[NSEW])/i
const DECIMAL_RE = /-?\b\d{1,3}\.\d{4,}\b/g
const DMS_RE = /\b\d{1,3}\s*°\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*(?:["″]|'')?\s*[NSEW]\b/g

function walk(dir, exts) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some(e => entry.name.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

function scanMarkdownFile(file) {
  const violations = []
  const raw = fs.readFileSync(file, 'utf8')
  const rel = path.relative(REPO_ROOT, file)
  const { fm, body } = parseNote(raw)

  for (const key of Object.keys(fm || {})) {
    if (isPrivateKey(key)) violations.push({ code: 'E1', file: rel, detail: `private frontmatter key "${key}"` })
  }
  if (/^##\s+Private Notes\s*$/mi.test(body)) {
    violations.push({ code: 'E2', file: rel, detail: '"## Private Notes" heading present' })
  }
  if (raw.includes(VAULT_CANARY)) violations.push({ code: 'E3', file: rel, detail: 'VAULT canary marker — real leak path' })
  if (raw.includes(FIXTURE_CANARY)) violations.push({ code: 'E3', file: rel, detail: 'fixture canary marker outside fixtures' })

  for (const m of raw.matchAll(DECIMAL_RE)) {
    const windowStart = Math.max(0, m.index - 80)
    const before = raw.slice(windowStart, m.index)
    if (CONTEXT_RE.test(before)) {
      violations.push({ code: 'E4', file: rel, detail: `coordinate-shaped value "${m[0]}" near location context` })
    }
  }
  for (const m of raw.matchAll(DMS_RE)) {
    violations.push({ code: 'E4', file: rel, detail: `DMS coordinate "${m[0].trim()}"` })
  }
  return violations
}

async function scanImages(dir) {
  const violations = []
  const files = walk(dir, ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.heic'])
  if (!files.length) return violations
  const sharp = (await import('sharp')).default
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file)
    try {
      const meta = await sharp(file).metadata()
      if (meta.exif || meta.gps || meta.xmp || meta.iptc) {
        violations.push({ code: 'E5', file: rel, detail: 'image still carries EXIF/XMP/IPTC metadata' })
      }
    } catch (e) {
      violations.push({ code: 'E5', file: rel, detail: `unreadable image (${e.message}) — refusing to trust it` })
    }
  }
  return violations
}

function scanBuiltOutput(dir) {
  const violations = []
  for (const file of walk(dir, ['.html', '.xml', '.json', '.txt', '.js', '.css'])) {
    const raw = fs.readFileSync(file, 'utf8')
    const rel = path.relative(REPO_ROOT, file)
    const contentBearing = ['.html', '.xml', '.json', '.txt'].some(e => file.toLowerCase().endsWith(e))
    if (raw.includes(VAULT_CANARY)) violations.push({ code: 'E3', file: rel, detail: 'VAULT canary marker in built output' })
    if (raw.includes(FIXTURE_CANARY)) violations.push({ code: 'E3', file: rel, detail: 'fixture canary marker in built output' })
    // Key-name/heading checks only on content-bearing files: bundled JS may contain
    // benign "_private"-shaped identifiers from transpilation.
    if (contentBearing && /_private\b/.test(raw)) violations.push({ code: 'E1', file: rel, detail: '"_private" key name in built output' })
    if (contentBearing && /Private Notes/.test(raw)) violations.push({ code: 'E2', file: rel, detail: '"Private Notes" text in built output' })
  }
  return violations
}

function report(label, violations) {
  if (!violations.length) { console.log(`OK    ${label}: clean`); return }
  console.error(`FAIL  ${label}:`)
  for (const v of violations) console.error(`  ${v.code} ${v.file} — ${v.detail}`)
}

let failed = false

// ---- Self-test: the scanner must catch the known-unsafe fixture and pass the safe one.
if (SELF_TEST) {
  const unsafe = path.join(FIXTURES, 'unsafe-page.md')
  const safe = path.join(FIXTURES, 'safe-page.md')
  if (!fs.existsSync(unsafe) || !fs.existsSync(safe)) {
    console.error('FAIL  self-test: fixtures missing under tests/privacy-fixtures/')
    process.exit(1)
  }
  const unsafeViolations = scanMarkdownFile(unsafe)
  const found = new Set(unsafeViolations.map(v => v.code))
  const expected = ['E1', 'E2', 'E3', 'E4']
  const missing = expected.filter(c => !found.has(c))
  if (missing.length) {
    console.error(`FAIL  self-test: scanner MISSED expected violation class(es) ${missing.join(', ')} in unsafe fixture — scanner is broken.`)
    failed = true
  } else {
    console.log(`OK    self-test: unsafe fixture correctly rejected (${unsafeViolations.length} findings across ${expected.join('/')})`)
  }
  const safeViolations = scanMarkdownFile(safe)
  if (safeViolations.length) {
    console.error('FAIL  self-test: scanner FALSELY flagged the safe fixture:')
    for (const v of safeViolations) console.error(`  ${v.code} ${v.file} — ${v.detail}`)
    failed = true
  } else {
    console.log('OK    self-test: safe fixture (dimensions/densities/ages) not flagged')
  }
}

// ---- Real content scan.
const contentViolations = []
for (const file of walk(CONTENT, ['.md'])) contentViolations.push(...scanMarkdownFile(file))
contentViolations.push(...await scanImages(CONTENT))
report('content/', contentViolations)
if (contentViolations.length) failed = true

if (fs.existsSync(PUBLIC)) {
  const builtViolations = scanBuiltOutput(PUBLIC)
  report('public/', builtViolations)
  if (builtViolations.length) failed = true
}

// ---- Vault positive control (local only; skipped in CI).
const vault = findVault()
if (vault) {
  const canaryPath = path.join(vault, '90 System', 'Privacy Canary.md')
  if (!fs.existsSync(canaryPath) || !fs.readFileSync(canaryPath, 'utf8').includes(VAULT_CANARY)) {
    console.error('FAIL  vault positive control: Privacy Canary missing or marker absent — the tripwire is broken; restore "90 System/Privacy Canary.md".')
    failed = true
  } else {
    console.log('OK    vault positive control: canary present in vault (and absent from public content)')
  }
} else {
  console.log('NOTE  vault not reachable — vault positive control skipped (expected in CI; --self-test covers scanner verification)')
}

if (failed) {
  console.error('\nPrivacy lint FAILED — do not merge or deploy.')
  process.exit(1)
}
console.log('\nPrivacy lint passed.')
