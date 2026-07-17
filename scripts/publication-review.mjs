// Publication-review generator. For every vault note with `public: true` but no
// `publication_approved:`, writes a review report into the vault's
// "00 Inbox/Needs Review/" so Warren can see EXACTLY what would publish before
// approving. Nothing exports without his approval date — sync enforces that.
//
//   node scripts/publication-review.mjs

import fs from 'node:fs'
import path from 'node:path'
import { findVault, planExports, PUBLIC_KEYS, isPrivateKey, INTERNAL_KEYS } from './lib/vault-export.mjs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const vault = findVault()
if (!vault) {
  console.error('ERROR: vault not found. Set ROCK_VAULT_DIR or place the vault at ../rock-archive.')
  process.exit(1)
}

const plan = planExports(vault)
if (!plan.blocked.length) {
  console.log('No notes are awaiting publication review (public: true without publication_approved).')
  process.exit(0)
}

const outDir = path.join(vault, '00 Inbox', 'Needs Review')
fs.mkdirSync(outDir, { recursive: true })

function extractSection(body, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'mi')
  const m = body.match(re)
  if (!m) return null
  const rest = body.slice(m.index + m[0].length)
  const next = rest.search(/^##\s+/m)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

for (const note of plan.blocked) {
  const fm = note.fm
  const slug = note.basename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const publicFm = {}
  const privateKeys = []
  const internalKeys = []
  const unknownKeys = []
  for (const [key, value] of Object.entries(fm)) {
    if (PUBLIC_KEYS.includes(key)) {
      const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0)
      if (!empty) publicFm[key] = value
    } else if (isPrivateKey(key)) privateKeys.push(key)
    else if (INTERNAL_KEYS.includes(key)) internalKeys.push(key)
    else unknownKeys.push(key)
  }

  const claimsSection = extractSection(note.body, 'Claims Register')
  const claimRows = (claimsSection || '').split('\n').filter(l => /^\|/.test(l) && !/^\|[\s-|]+\|$/.test(l) && !/^\|\s*Claim\s*\|/i.test(l) && l.replace(/[|\s]/g, '').length > 0)
  const weakClaims = claimRows.filter(l => /hypothesis|inferred|disputed/i.test(l))
  const strongClaims = claimRows.filter(l => !/hypothesis|inferred|disputed/i.test(l))

  const privateNotes = extractSection(note.body, 'Private Notes')
  const wikilinks = [...note.body.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim())

  const images = fm.image_exports || []
  const allImages = fm.image_paths || []
  const notSelected = allImages.filter(p => !images.some(e => e.path === p))

  const lines = []
  lines.push('---')
  lines.push('record_type: publication-review')
  lines.push(`reviews: "${note.relVault}"`)
  lines.push(`generated: ${new Date().toISOString().slice(0, 10)}`)
  lines.push('status: awaiting-decision')
  lines.push('---')
  lines.push('')
  lines.push(`# Publication Review — ${fm.title || note.basename}`)
  lines.push('')
  lines.push(`Vault note: \`${note.relVault}\` · record_type: \`${fm.record_type}\``)
  lines.push('')
  lines.push('## What would publish')
  lines.push('')
  lines.push(`- **Public title:** ${fm.title || note.basename}`)
  if (fm.record_type === 'specimen' || fm.collection_location_public !== undefined) {
    lines.push(`- **Public location wording:** ${fm.collection_location_public || '(empty — nothing would show)'}`)
  }
  if (fm.region_public !== undefined) lines.push(`- **Public region wording:** ${fm.region_public || '(empty)'}`)
  if (fm.possible_identifications?.length) lines.push(`- **Identification wording:** ${JSON.stringify(fm.possible_identifications)}`)
  if (fm.identification_confidence) lines.push(`- **Confidence wording:** ${fm.identification_confidence}`)
  if (fm.estimated_age) lines.push(`- **Age wording:** ${fm.estimated_age} (confidence: ${fm.age_confidence || 'unstated'})`)
  lines.push('')
  lines.push('### Frontmatter that would export')
  lines.push('')
  lines.push('```yaml')
  lines.push(stringifyYaml(publicFm).trimEnd())
  lines.push('```')
  lines.push('')
  lines.push('## Claims')
  lines.push('')
  if (strongClaims.length) {
    lines.push('Claims with confirmed/sourced status:')
    lines.push('')
    lines.push('| Claim | Scope | Status | Sources |')
    lines.push('|---|---|---|---|')
    lines.push(...strongClaims)
    lines.push('')
  }
  if (weakClaims.length) {
    lines.push('⚠ **Still hypothesis / inferred / disputed — these publish with hedged wording; remove any you don\'t want public:**')
    lines.push('')
    lines.push('| Claim | Scope | Status | Sources |')
    lines.push('|---|---|---|---|')
    lines.push(...weakClaims)
    lines.push('')
  }
  if (!claimRows.length) lines.push('_No Claims Register rows found._')
  if (fm.claims_needing_review?.length) {
    lines.push('')
    lines.push(`⚠ **Unsourced claims queued for review:** ${JSON.stringify(fm.claims_needing_review)}`)
  }
  lines.push('')
  lines.push('## Images')
  lines.push('')
  if (images.length) {
    lines.push('| Original | Exports as | Role | Caption |')
    lines.push('|---|---|---|---|')
    const counters = {}
    for (const e of images) {
      const role = e.role || 'view'
      counters[role] = (counters[role] || 0) + 1
      let ext = path.extname(e.path || '').toLowerCase(); if (ext === '.jpeg') ext = '.jpg'
      const name = e.exported_name || `${(fm.id || slug).toLowerCase()}-${role}-${String(counters[role]).padStart(2, '0')}${ext}`
      lines.push(`| ${e.path} | ${name} | ${role} | ${e.caption || ''} |`)
    }
    lines.push('')
    lines.push('All exports are re-encoded (EXIF/GPS stripped) under these sanitized names.')
  } else {
    lines.push('_No images selected for export (image_exports is empty)._')
  }
  if (notSelected.length) {
    lines.push('')
    lines.push(`Not selected (stay private): ${notSelected.join(', ')}`)
  }
  if (fm.record_type === 'specimen') {
    lines.push('')
    lines.push('## Availability')
    lines.push('')
    if (fm.available === true) {
      const priceText = (fm.price === 0 || fm.price) ? `$${fm.price}` : '(no price set)'
      lines.push(`Marked **available** — ${priceText}${fm.purchase_url ? ` · ${fm.purchase_url}` : ' · (no purchase_url set)'}`)
      lines.push('')
      lines.push('Publishes as ONE quiet italic note at the very bottom of the page, after all content — no card, banner, price lead, or checkout. Nothing else on the page or site changes.')
    } else {
      lines.push('Not for sale (`available: false`) — no purchasing information will appear publicly. This is the default and the state after a sale.')
    }
  }
  lines.push('')
  lines.push('## Links')
  lines.push('')
  lines.push(wikilinks.length ? `Outgoing wikilinks: ${[...new Set(wikilinks)].join(' · ')}` : '_No outgoing wikilinks._')
  lines.push('')
  lines.push('Links to targets that are not themselves published will render as dead ends — the sync dry-run lists them.')
  lines.push('')
  lines.push('## What gets stripped as private')
  lines.push('')
  if (privateKeys.length) lines.push(`- Private frontmatter keys (never copied): ${privateKeys.join(', ')}`)
  if (internalKeys.length) lines.push(`- Internal keys (never copied): ${internalKeys.join(', ')}`)
  if (unknownKeys.length) lines.push(`- ⚠ Unknown keys (not copied — check them): ${unknownKeys.join(', ')}`)
  lines.push(privateNotes ? `- \`## Private Notes\` section (${privateNotes.split('\n').length} line(s)) — removed entirely.` : '- No Private Notes section present.')
  lines.push('')
  lines.push('## Your decision')
  lines.push('')
  lines.push('- **Approve:** set `publication_approved: YYYY-MM-DD` in the note\'s frontmatter, then run `node scripts/sync-public.mjs --write`.')
  lines.push('- **Revise identification:** tell me and I\'ll re-rank / adjust wording; or edit `possible_identifications` yourself.')
  lines.push('- **Make location broader:** edit `collection_location_public` / `region_public` first.')
  lines.push('- **Remove this image:** drop it from `image_exports`.')
  lines.push('- **Remove claims:** edit the Claims Register / prose first.')
  lines.push('- **Change price / not available:** set `price:` / `purchase_url:`, or `available: false`.')
  lines.push('- **Keep private:** set `public: false` (this report can be deleted).')
  lines.push('')

  const reportPath = path.join(outDir, `publication-review-${slug}.md`)
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log(`Review written: ${path.relative(vault, reportPath)}`)
}

console.log(`\n${plan.blocked.length} note(s) awaiting Warren's decision.`)
