#!/usr/bin/env node
// Usage: node scripts/publish.js --bcd <BCD checkout> --data <fetched dir> --worktree <path> <browser>...
// Adds one commit per release (oldest first) to the orphan `release-notes` branch, dated at the release date.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { bcd: { type: "string" }, data: { type: "string" }, worktree: { type: "string" } },
});
if (!values.bcd || !values.data || !values.worktree || positionals.length === 0) {
  console.error("Usage: publish.js --bcd <path> --data <dir> --worktree <path> <browser>...");
  process.exit(2);
}

const git = (args, env = {}) =>
  execFileSync("git", ["-C", values.worktree, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

for (const browser of positionals) {
  const file = path.join(values.bcd, "browsers", `${browser}.json`);
  const { name, releases } = JSON.parse(await readFile(file, "utf8")).browsers[browser];
  const ordered = Object.entries(releases)
    .filter(([v]) => existsSync(path.join(values.data, browser, `${v}.md`)))
    .sort(([, a], [, b]) => (a.release_date ?? "").localeCompare(b.release_date ?? ""));

  for (const [version, release] of ordered) {
    const tag = `${browser}-v${version}`;
    if (git(["tag", "--list", tag])) continue;
    const rel = path.join(browser, `${version}.md`);
    await mkdir(path.join(values.worktree, browser), { recursive: true });
    await copyFile(path.join(values.data, rel), path.join(values.worktree, rel));
    git(["add", rel]);
    const date = `${release.release_date ?? "1970-01-01"}T12:00:00Z`;
    git(["commit", "-S", "-m", `${name} ${version}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    git(["tag", "-a", "-m", `${name} ${version}`, tag]);
    console.log(`${tag}`);
  }
}
