# Browser Release Notes

This repository keeps a searchable archive of release notes for browser and JavaScript runtime releases, one folder per browser.

## Branches

- `main` contains this README and the scripts that fetch and publish the notes.
- `release-notes` is an orphan history with one commit per release, oldest first, dated at the release date. Each commit adds `<browser>/<version>.md` and has an annotated `<browser>-v<version>` tag. It does not contain this README or the scripts.

Use `git switch release-notes` before running `grep`, `git log -S`, or `git blame` against the notes.

## Sources

The release list and release-notes URLs come from the `release_notes` fields in [`browsers/*.json`](https://github.com/mdn/browser-compat-data/tree/main/browsers) in MDN Browser Compat Data. Each file records its origin in front matter:

```yaml
---
browser: firefox
version: "150"
release_date: 2026-04-21
source_url: https://developer.mozilla.org/docs/Mozilla/Firefox/Releases/150
archived_from: https://web.archive.org/web/20260421.../...  # only if the live URL failed
fetched_at: 2026-10-19
---
```

If a URL no longer resolves, the closest [Wayback Machine](https://web.archive.org/) snapshot to the release date is used instead. Releases without a `release_notes` URL, and planned or beta releases, are skipped. "Not mentioned in the notes" is not evidence that a feature did not ship.

Special cases: GitHub release tags are read through the API, and Node.js changelog files are split into the section for one version. Pages that share a URL across releases are fetched once.

## Usage

```sh
npm install
node scripts/fetch.js --bcd ../browser-compat-data --out data firefox nodejs deno bun
git worktree add --orphan -b release-notes ../browser-release-notes-data
node scripts/publish.js --bcd ../browser-compat-data --data data --worktree ../browser-release-notes-data firefox nodejs deno bun
```

`fetch.js` skips files that already exist; pass `--force` to refetch. Set `GITHUB_TOKEN` to avoid the unauthenticated GitHub API rate limit. The fetch report lists releases that have no URL or that failed both live and from the Wayback Machine.
