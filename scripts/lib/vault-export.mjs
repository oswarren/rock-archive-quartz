// Shared core for sync-public.mjs and publication-review.mjs.
// Computes the export plan: which vault notes are publishable, what their public
// projection looks like, and every warning a human should see before it ships.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '..', '..')

// Markers are assembled from parts so a repo-wide grep for the literal strings
// only ever matches real leaks (and the intentional CI fixture).
export const VAULT_CANARY = ['CANARY', 'ROCK', 'PRIVATE', '0000'].join('-')
export const FIXTURE_CANARY = ['CANARY', 'ROCK', 'TEST', 'FIXTURE'].join('-')

export function findVault() {
  const candidate = process.env.ROCK_VAULT_DIR || path.resolve(REPO_ROOT, '..', 'rock-archive')
  return fs.existsSync(path.join(candidate, 'CLAUDE.md')) ? candidate : null
}

// Sections eligible for export. Everything else in the vault (00 Inbox, 80 Sources,
// 90 System, .obsidian, .claude, ...) is excluded regardless of its contents.
export const SECTIONS = [
  { dir: '10 Specimens', out: 'specimens', types: ['specimen'] },
  { dir: '20 Locations', out: 'locations', types: ['location'] },
  { dir: '30 Materials', out: 'materials', types: ['material'] },
  { dir: '40 Geological Context', out: 'geology', types: ['concept'] },
  { dir: '50 Human Context', out: 'human-context', types: ['concept'] },
  { dir: '60 Themes and Collections', out: 'collections', types: ['theme'] },
  { dir: '70 Public Pages', out: null, types: ['public-page'] },
]

// Frontmatter keys that may reach the public site. Nothing outside this list has a
// code path into an exported file.
export const PUBLIC_KEYS = [
  'id', 'record_type', 'title', 'description', 'aliases', 'tags',
  'date_collected', 'collection_location_public', 'collector', 'rock_type',
  'possible_identifications', 'minerals_observed', 'colors', 'textures',
  'formation_processes', 'estimated_age', 'age_confidence',
  'identification_confidence', 'identification_status', 'evidence_level',
  'formation_hypotheses', 'tests_performed', 'tests_recommended',
  'region_public', 'category', 'diagnostic_properties', 'identification_methods',
  'concept_area', 'membership_criteria', 'member_specimens',
  'related_specimens', 'related_locations', 'related_materials', 'related_themes',
]

// Known vault-internal keys: silently not copied (their presence is normal).
export const INTERNAL_KEYS = [
  'public', 'publication_approved', 'needs_user_review', 'status',
  'research_status', 'sources', 'claims_needing_review',
  'image_paths', 'image_exports', 'revision', 'report_date', 'prepared_by',
  'specimen_id', 'date', 'participants', 'conditions', 'specimens_collected',
]

export function isPrivateKey(key) {
  return /_private$/i.test(key) ||
    ['coordinates', 'coords', 'lat', 'latitude', 'lng', 'lon', 'longitude', 'gps'].includes(key.toLowerCase())
}

export function parseNote(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fm: {}, body: raw }
  let fm
  try {
    fm = parseYaml(m[1]) || {}
  } catch (e) {
    return { fm: {}, body: raw, parseError: String(e.message || e) }
  }
  return { fm, body: raw.slice(m[0].length) }
}

export function kebab(name) {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function walkMd(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkMd(p))
    else if (/\.md$/i.test(entry.name)) out.push(p)
  }
  return out
}

function publicPageRoute(relParts) {
  // relParts: path segments inside "70 Public Pages"
  if (relParts.length === 1) {
    const base = relParts[0].replace(/\.md$/i, '')
    if (base === 'Start Here') return 'index.md'
    if (base === 'About the Archive') return 'about.md'
    return `${kebab(base)}.md`
  }
  return relParts
    .map((seg, i) => {
      if (i < relParts.length - 1) return kebab(seg)
      const base = seg.replace(/\.md$/i, '')
      return base.toLowerCase() === 'index' ? 'index.md' : `${kebab(base)}.md`
    })
    .join('/')
}

export function loadSources(vault) {
  const sources = new Map() // lowercased basename -> { basename, fm }
  for (const file of walkMd(path.join(vault, '80 Sources'))) {
    const basename = path.basename(file).replace(/\.md$/i, '')
    const { fm } = parseNote(fs.readFileSync(file, 'utf8'))
    sources.set(basename.toLowerCase(), { basename, fm: fm || {} })
  }
  return sources
}

const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

function stripPrivateNotes(body, label, errors) {
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
  const pnIndex = headings.findIndex(h => h[1].trim().toLowerCase() === 'private notes')
  if (pnIndex === -1) return body
  if (pnIndex !== headings.length - 1) {
    errors.push(`${label}: "## Private Notes" must be the LAST section — found later heading "## ${headings[pnIndex + 1][1]}". Export refused.`)
    return null
  }
  return body.slice(0, headings[pnIndex].index).replace(/\s+$/, '') + '\n'
}

function formatCitation(src) {
  const fm = src.fm
  const bits = []
  bits.push(`**${fm.title || src.basename}**`)
  if (fm.author_or_org) bits.push(fm.author_or_org)
  if (fm.publication) bits.push(`*${fm.publication}*`)
  if (fm.url_or_reference && /^https?:/i.test(fm.url_or_reference)) bits.push(`[link](${fm.url_or_reference})`)
  else if (fm.url_or_reference) bits.push(fm.url_or_reference)
  if (fm.access_date) bits.push(`accessed ${fm.access_date}`)
  return bits.join('. ')
}

// Builds the full export plan without writing anything.
export function planExports(vault) {
  const plan = { exports: [], blocked: [], skipped: [], errors: [], warnings: [] }
  const sources = loadSources(vault)

  for (const section of SECTIONS) {
    const dir = path.join(vault, section.dir)
    for (const file of walkMd(dir)) {
      const relVault = path.relative(vault, file).split(path.sep).join('/')
      if (/(^|\/)README\.md$/i.test(relVault)) continue
      const { fm, body, parseError } = parseNote(fs.readFileSync(file, 'utf8'))
      if (parseError) {
        plan.warnings.push(`${relVault}: frontmatter parse error (${parseError}) — treated as private.`)
        continue
      }
      const basename = path.basename(file).replace(/\.md$/i, '')
      const note = { file, relVault, basename, fm, body, section }

      if (!section.types.includes(fm.record_type)) {
        if (fm.public === true) {
          plan.warnings.push(`${relVault}: record_type "${fm.record_type}" is not exportable from "${section.dir}" — never exported.`)
        }
        continue
      }
      if (fm.public !== true) {
        plan.skipped.push(relVault)
        continue
      }
      if (!fm.publication_approved) {
        plan.blocked.push(note)
        continue
      }

      // Route
      let route
      if (fm.record_type === 'specimen') {
        if (!/^ROCK-\d{4}$/.test(fm.id || '')) {
          plan.errors.push(`${relVault}: specimen has invalid id "${fm.id}" — export refused.`)
          continue
        }
        route = `specimens/${fm.id.toLowerCase()}/index.md`
      } else if (section.out === null) {
        route = publicPageRoute(relVault.split('/').slice(1))
      } else {
        route = `${section.out}/${kebab(basename)}.md`
      }

      // Frontmatter projection: allowlist only.
      const publicFm = {}
      const droppedPrivate = []
      const droppedInternal = []
      for (const [key, value] of Object.entries(fm)) {
        if (PUBLIC_KEYS.includes(key)) {
          const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0)
          if (!empty) publicFm[key] = value
        } else if (isPrivateKey(key)) {
          droppedPrivate.push(key)
        } else if (INTERNAL_KEYS.includes(key)) {
          droppedInternal.push(key)
        } else {
          plan.warnings.push(`${relVault}: unknown frontmatter key "${key}" — not exported (add to PUBLIC_KEYS if it should be).`)
        }
      }
      publicFm.publish = true
      publicFm.generated = true

      // Body: strip Private Notes (must be last section).
      const errsBefore = plan.errors.length
      let publicBody = stripPrivateNotes(body, relVault, plan.errors)
      if (publicBody === null || plan.errors.length > errsBefore) continue
      const strippedPrivateNotes = publicBody.length !== body.length

      // Images (specimens only): only image_exports entries, sanitized names.
      const images = []
      if (fm.record_type === 'specimen') {
        const roleCounters = {}
        for (const entry of fm.image_exports || []) {
          const role = entry.role || 'view'
          roleCounters[role] = (roleCounters[role] || 0) + 1
          const src = path.resolve(path.dirname(file), entry.path || '')
          let ext = path.extname(entry.path || '').toLowerCase()
          if (ext === '.jpeg') ext = '.jpg'
          const exportedName = entry.exported_name ||
            `${fm.id.toLowerCase()}-${role}-${String(roleCounters[role]).padStart(2, '0')}${ext}`
          if (!fs.existsSync(src)) {
            plan.errors.push(`${relVault}: image_exports entry "${entry.path}" not found — export refused.`)
            continue
          }
          images.push({ src, exportedName, role, caption: entry.caption || '', original: entry.path })
        }
      }

      note.route = route
      note.publicFm = publicFm
      note.publicBody = publicBody
      note.images = images
      note.droppedPrivate = droppedPrivate
      note.droppedInternal = droppedInternal
      note.strippedPrivateNotes = strippedPrivateNotes
      plan.exports.push(note)
    }
  }

  // Resolution set: what an exported wikilink may point to.
  const resolvable = new Set()
  for (const note of plan.exports) {
    resolvable.add(note.basename.toLowerCase())
    if (note.fm.title) resolvable.add(String(note.fm.title).toLowerCase())
    for (const alias of note.fm.aliases || []) resolvable.add(String(alias).toLowerCase())
    if (note.fm.id) resolvable.add(String(note.fm.id).toLowerCase())
  }

  // Second pass per export: citations, embeds, wikilink validation.
  for (const note of plan.exports) {
    const usedSources = new Map()
    const unresolved = []
    const embedErrors = []

    note.publicBody = note.publicBody.replace(WIKILINK_RE, (full, bang, target, anchor, alias) => {
      const key = target.trim().toLowerCase()

      if (bang === '!') {
        // Embed: only publication-approved images may appear.
        const img = note.images.find(i =>
          i.original.toLowerCase() === key || path.basename(i.original).toLowerCase() === `${key}`.toLowerCase() ||
          path.basename(i.original).toLowerCase() === key)
        if (img) return `![${img.caption || alias || note.fm.title || ''}](${img.exportedName})`
        if (/\.(jpe?g|png|webp|tiff?|heic|gif)$/i.test(key)) {
          embedErrors.push(`${note.relVault}: embedded image "${target}" is not in image_exports — export refused (no unapproved image may publish).`)
          return full
        }
        return full // non-image embed: leave for Quartz to resolve
      }

      const source = loadedSource(sources, key)
      if (source) {
        usedSources.set(source.basename, source)
        const label = alias || source.fm.title || source.basename
        const url = source.fm.url_or_reference
        return url && /^https?:/i.test(url) ? `[${label}](${url})` : `*${label}*`
      }

      if (!resolvable.has(key)) unresolved.push(target.trim())
      return full
    })

    if (embedErrors.length) {
      plan.errors.push(...embedErrors)
      plan.exports = plan.exports.filter(n => n !== note)
      continue
    }

    if (usedSources.size) {
      const lines = [...usedSources.values()].map(s => `- ${formatCitation(s)}`)
      note.publicBody = `${note.publicBody.replace(/\s+$/, '')}\n\n## Sources\n\n${lines.join('\n')}\n`
    }
    note.unresolvedLinks = unresolved
    if (unresolved.length) {
      plan.warnings.push(`${note.relVault}: wikilinks to non-exported targets: ${unresolved.join(', ')}`)
    }
  }

  return plan
}

function loadedSource(sources, key) {
  return sources.get(key) || null
}

export function renderExport(note) {
  const fmText = stringifyYaml(note.publicFm).trimEnd()
  const header = '<!-- Generated from the private rock-archive vault by scripts/sync-public.mjs. Do not edit here; edit the vault record and re-sync. -->'
  return `---\n${fmText}\n---\n${header}\n\n${note.publicBody.replace(/\s+$/, '')}\n`
}
