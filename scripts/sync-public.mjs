// Vault → content/ exporter. THE ONLY bridge between the private vault and this
// public repo. Dry-run by default; pass --write to apply.
//
//   node scripts/sync-public.mjs           # report what would happen
//   node scripts/sync-public.mjs --write   # export + sanitize images + prune stale
//
// Only vault notes carrying BOTH `public: true` AND `publication_approved:` export
// (see scripts/publication-review.mjs). Frontmatter is allowlisted, `## Private
// Notes` is stripped, source wikilinks become citations, and specimen images are
// re-encoded via sharp (drops all EXIF/GPS) under sanitized filenames.

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, findVault, planExports, renderExport } from './lib/vault-export.mjs'

const WRITE = process.argv.includes('--write')
const CONTENT = path.join(REPO_ROOT, 'content')
const MANIFEST = path.join(REPO_ROOT, '.sync-manifest.json')

const vault = findVault()
if (!vault) {
  console.error('ERROR: vault not found. Set ROCK_VAULT_DIR or place the vault at ../rock-archive.')
  process.exit(1)
}

const plan = planExports(vault)

console.log(`Vault: ${vault}`)
console.log(`Mode:  ${WRITE ? 'WRITE' : 'dry-run (pass --write to apply)'}\n`)

const bySection = {}
for (const note of plan.exports) {
  bySection[note.section.dir] = (bySection[note.section.dir] || 0) + 1
}
console.log('Exports:')
for (const [dir, count] of Object.entries(bySection)) console.log(`  ${dir}: ${count}`)
if (!plan.exports.length) console.log('  (none)')

if (plan.blocked.length) {
  console.log('\nBlocked — public: true but NO publication_approved (run scripts/publication-review.mjs):')
  for (const note of plan.blocked) console.log(`  ${note.relVault}`)
}
console.log(`\nPrivate (skipped): ${plan.skipped.length} notes`)

for (const w of plan.warnings) console.log(`WARN  ${w}`)
for (const e of plan.errors) console.error(`ERROR ${e}`)
if (plan.errors.length) {
  console.error(`\n${plan.errors.length} error(s) — nothing written.`)
  process.exit(1)
}

const expected = new Set()
for (const note of plan.exports) {
  expected.add(note.route)
  for (const img of note.images) expected.add(path.posix.join(path.posix.dirname(note.route), img.exportedName))
}

if (!WRITE) {
  console.log('\nWould write:')
  for (const f of [...expected].sort()) console.log(`  content/${f}`)
  process.exit(0)
}

const sharp = (await import('sharp')).default
const written = []
const imageMapRows = []

for (const note of plan.exports) {
  const dest = path.join(CONTENT, note.route)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, renderExport(note), 'utf8')
  written.push(note.route)

  for (const img of note.images) {
    const imgDest = path.join(path.dirname(dest), img.exportedName)
    // sharp drops all metadata (EXIF/GPS/XMP) unless .withMetadata() is called —
    // which we never do. .rotate() bakes EXIF orientation into pixels first.
    await sharp(img.src).rotate().toFile(imgDest)
    const meta = await sharp(imgDest).metadata()
    if (meta.exif || meta.gps) {
      console.error(`ERROR ${note.relVault}: exported image ${img.exportedName} still carries metadata — aborting.`)
      fs.rmSync(imgDest)
      process.exit(1)
    }
    written.push(path.posix.join(path.posix.dirname(note.route), img.exportedName))
    imageMapRows.push({
      date: new Date().toISOString().slice(0, 10),
      specimen: note.fm.id,
      original: img.original,
      exported: img.exportedName,
      role: img.role,
    })
  }
}

// Prune exports that are no longer generated (manifest-tracked files only).
let previous = []
if (fs.existsSync(MANIFEST)) {
  try { previous = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).files || [] } catch {}
}
let pruned = 0
for (const rel of previous) {
  if (!expected.has(rel)) {
    const p = path.join(CONTENT, rel)
    if (fs.existsSync(p)) { fs.rmSync(p); pruned++ ; console.log(`Pruned stale export: content/${rel}`) }
  }
}
fs.writeFileSync(MANIFEST, JSON.stringify({ updated: new Date().toISOString(), files: [...expected].sort() }, null, 2))

// Append new image mappings to the vault-private Image Export Map.
if (imageMapRows.length) {
  const mapPath = path.join(vault, '90 System', 'Processing Logs', 'Image Export Map.md')
  let existing = ''
  if (fs.existsSync(mapPath)) existing = fs.readFileSync(mapPath, 'utf8')
  else existing = '# Image Export Map (private — never exported)\n\nOriginal filename ↔ sanitized public name. Appended by sync-public.mjs.\n\n| Export date | Specimen | Original | Exported as | Role |\n|---|---|---|---|---|\n'
  let appended = 0
  for (const row of imageMapRows) {
    const line = `| ${row.date} | ${row.specimen} | ${row.original} | ${row.exported} | ${row.role} |`
    if (!existing.includes(`| ${row.specimen} | ${row.original} | ${row.exported} |`)) {
      existing += line + '\n'
      appended++
    }
  }
  fs.writeFileSync(mapPath, existing, 'utf8')
  if (appended) console.log(`Image Export Map: ${appended} new row(s) appended (vault-private).`)
}

console.log(`\nDone: ${written.length} file(s) written, ${pruned} pruned.`)
console.log('Next: node scripts/lint-privacy.mjs && npx quartz build')
