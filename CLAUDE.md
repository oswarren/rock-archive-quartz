# rock-archive-quartz — public site for the Rock Collection Archive

Quartz v5 site publishing curated records from the **private vault** at
`C:\Users\myema\Projects\rock-archive`. This repo is the public frontend only.

## Architecture

| Layer | Role |
|---|---|
| Private vault (`..\rock-archive`) | Canonical records, original photos, precise locations. Separate git repo, never on GitHub-public, never read by the Quartz build. |
| `scripts\sync-public.mjs` | **The only bridge.** Exports vault notes carrying BOTH `public: true` AND `publication_approved:`; allowlisted frontmatter only; strips `## Private Notes`; renders source citations; sanitizes image filenames; strips EXIF/GPS via sharp. |
| This repo `content/` | **Generated** public Markdown. If it's in `content/`, it's on the internet. Never edit synced pages in place — edit the vault record and re-sync. |
| GitHub (`origin` = oswarren/rock-archive-quartz) | Version control + CI. Live deploy is DEFERRED: `deploy.yml` is workflow_dispatch-only and Pages is unconfigured until the first real reviewed specimens exist. |

## Hard rules

1. **Never commit anything from the vault** by hand. `content/` is written only by
   `sync-public.mjs`. Pre-merge gate: `node scripts/lint-privacy.mjs` (exit 1 blocks).
2. **Never edit `quartz/` internals** or other upstream-tracked code. Customize via
   `quartz.config.yaml` (theme, plugins, `layout:` — Quartz v5 has no
   quartz.layout.ts) and root `quartz.ts` — keeps `git merge upstream/v5` cheap.
   `upstream` = jackyzha0/quartz.
3. **`explicit-publish` stays enabled.** Only pages with `publish: true` build, and
   only the sync script writes that key.
4. **The vault canary marker (`CANARY-ROCK-PRIVATE` + `-0000`) must never appear in
   this repo.** Its only legitimate home is the vault. The similarly-named marker in
   `tests/privacy-fixtures/` is a deliberately different string used to prove the
   scanner works in CI.
5. Conventional commits; `content:` prefix for sync-generated page updates.

## Scripts

- `node scripts/sync-public.mjs [--write]` — vault → `content/` export. Dry-run by
  default: reports what would export, what's blocked awaiting publication review, and
  unresolved wikilinks. Manifest at `.sync-manifest.json` lets it remove stale exports.
- `node scripts/publication-review.mjs` — for every vault note with `public: true`
  but no `publication_approved:`, writes a review report into the vault's
  `00 Inbox\Needs Review\` for Warren. Nothing exports without his approval date.
- `node scripts/lint-privacy.mjs [--self-test]` — leak scanner over `content/` (and
  `public/` if built): `*_private` keys, `## Private Notes` remnants, canary markers,
  contextual coordinate detection (decimal pairs only near location-context words —
  dimensions/dates/ratios are not flagged), EXIF/GPS in images. With vault access it
  also verifies the vault canary exists (positive control). `--self-test` proves the
  scanner catches the fixture in `tests/privacy-fixtures/` — this is what CI runs, so
  CI never needs the vault.

## Workflow

- `main` + short-lived branches. Local preview: `npx quartz build --serve`.
- Before every merge: `node scripts/lint-privacy.mjs`.
- Publishing a new record: Warren sets `public: true` in the vault → run
  `publication-review.mjs` → Warren approves (`publication_approved: YYYY-MM-DD`) →
  `sync-public.mjs --write` → lint → build → commit.
- **Launch checklist (when first real specimens are reviewed):** flip `deploy.yml`
  trigger from `workflow_dispatch` to push-on-main, enable Pages (source: GitHub
  Actions), verify the Actions lint step gates the deploy.
