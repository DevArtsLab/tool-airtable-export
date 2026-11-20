# Changelog

## [1.6.1] - 2026-11-20

- Fixed `Failed to capture readSharedViewData request URL`: Airtable now issues a single shared-view request that always sets `allowMsgpackOfResult`, which the old filter skipped
- The captured URL now has `allowMsgpackOfResult` rewritten to `false` and the `x-airtable-accept-msgpack` header dropped, so the API returns JSON instead of msgpack

## [1.6.0] - 2026-09-02

- Removed parent `ARCHITECTURE.md` pipeline design to keep the repo focused on its own export capability

## [1.5.0] - 2026-09-01

- Renamed default output directory from `output/` to `objects/`
- Output filenames now use full page title slugged with dashes, prefixed by org abbreviation from `orgs.json` config (e.g., `ctd-employer-partners-apprentice-facing.json`)
- Added `orgs.json` to map Airtable app IDs to org name, abbreviation, and excluded fields
- Added per-source field exclusion via `exclude_fields` in `orgs.json` (e.g., drop `Attachments` column for employer partners)
- String arrays in output JSON are collapsed to one line (e.g., `["Full-Time"]`, `["Technology", "Consulting"]`)
- `objects/` folder is now tracked in git (no longer gitignored)
- Updated `README.md`, `skill.md`, and `ARCHITECTURE.md` to reflect new directory and filenames

## [1.4.0] - 2026-09-01

- Added `ARCHITECTURE.md` with orchestrator-based pipeline design
- Updated `skill.md` to match current `export.js` (dynamic interception, native types, rich text flattening, `_meta` block, YAML frontmatter)

## [1.3.0] - 2026-08-31

- Added `--output <dir>` flag to specify custom output directory
- Added `pageTitle` to `_meta` block
- Flattened Airtable rich text fields (documentValue) to plain text strings
- Removed row count from output filenames (stable names across re-exports)
- Added `.prettierrc` to prevent formatting diffs on committed output files
- Added git submodule usage instructions to README
- Added `setup.sh` for one-command installation
- Fixed `exportedAt` to use local timezone instead of UTC

## [1.2.0] - 2026-08-31

- Added `--merge` flag to append only new records to existing output (by `_id` comparison)
- Added `_meta` block to output JSON (sourceUrl, exportedAt, rowCount, columnCount)
- Added retry logic (3 attempts with 3s delay)
- Added support for multiple URLs in a single run
- Added progress logging during parsing
- Preserved native JSON types (arrays, objects) instead of stringifying
- Added summary output showing per-table results and new record counts

## [1.1.0] - 2026-08-31

- Made script fully generic - accepts any share URL as CLI argument
- Auto-captures access policy via network request interception (no more hardcoded URLs)
- Auto-names output files based on Airtable page title + row count
- Added `output/` subdirectory to separate exports from app files
- Removed CSV output (JSON only)
- Added `skill.md` playbook for agents

## [1.0.0] - 2026-08-31

- Initial working version
- Extracts all rows from Airtable public shared views via internal `readSharedViewData` API
- Uses Playwright to load page and fetch from browser context (bypasses authentication)
- Maps cell values to column names, resolves select field IDs to text
- Outputs JSON and CSV
