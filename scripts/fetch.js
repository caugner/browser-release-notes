#!/usr/bin/env node
// Usage: node scripts/fetch.js --bcd <path to BCD checkout> --out <output dir> <browser>...
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bcd: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
  },
});
if (!values.bcd || !values.out || positionals.length === 0) {
  console.error("Usage: fetch.js --bcd <path> --out <dir> [--force] <browser>...");
  process.exit(2);
}

const UA = "browser-release-notes (https://github.com/caugner/browser-release-notes)";
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const pageCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// archive.org rate-limits aggressively: serialize its requests with a gap between them.
let archiveQueue = Promise.resolve();
function throttleArchive() {
  const turn = archiveQueue.then(() => sleep(1500));
  archiveQueue = turn;
  return turn;
}

async function get(url, { retries = 5 } = {}) {
  const isArchive = new URL(url).hostname.endsWith("archive.org");
  for (let attempt = 0; ; attempt++) {
    try {
      if (isArchive) await throttleArchive();
      const headers = { "user-agent": UA };
      if (process.env.GITHUB_TOKEN && new URL(url).hostname === "api.github.com") {
        headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const res = await fetch(url, { headers, redirect: "follow" });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(isArchive ? 10000 * (attempt + 1) : 2000 * 2 ** attempt);
    }
  }
}

/** Returns the raw body of the closest Wayback snapshot, or null. */
async function wayback(url, releaseDate) {
  const ts = (releaseDate ?? "").replaceAll("-", "");
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}${ts ? `&timestamp=${ts}` : ""}`;
  const info = await (await get(api)).json();
  const snap = info.archived_snapshots?.closest;
  if (!snap?.available) return null;
  // The `id_` flag returns the original body without the Wayback toolbar or rewritten links.
  const raw = snap.url.replace(/\/web\/(\d+)\//, "/web/$1id_/");
  const res = await get(raw);
  return res.ok ? { body: await res.text(), archivedFrom: snap.url } : null;
}

/** Fetches `url` (no fragment), falling back to the Wayback Machine. Cached per URL. */
function fetchPage(url, releaseDate) {
  if (!pageCache.has(url)) {
    pageCache.set(
      url,
      (async () => {
        try {
          const res = await get(url);
          const norm = (u) => new URL(u).pathname.replace(/\/$/, "").toLowerCase();
          // A redirect to a different path usually means the page is gone (e.g. a news front page).
          if (res.ok && norm(res.url) === norm(url)) return { body: await res.text(), archivedFrom: null };
        } catch (e) {
          console.error(`fetch ${url}: ${e.message}`);
        }
        return wayback(url, releaseDate);
      })(),
    );
  }
  return pageCache.get(url);
}

function htmlToMarkdown(html, fragment) {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll("script, style, nav, footer, header, noscript")) el.remove();
  const target = fragment ? document.getElementById(fragment) : null;
  if (target && /^H[1-6]$/.test(target.tagName)) {
    // A heading anchor in a multi-release page: take everything up to the next heading of the same or higher level.
    const level = Number(target.tagName[1]);
    const parts = [target.outerHTML];
    for (let el = target.nextElementSibling; el; el = el.nextElementSibling) {
      const m = /^H([1-6])$/.exec(el.tagName);
      if (m && Number(m[1]) <= level) break;
      parts.push(el.outerHTML);
    }
    return turndown.turndown(parts.join("\n")).trim();
  }
  const root = target ?? document.querySelector("main, article, #content, .content") ?? document.body;
  return turndown.turndown(root?.innerHTML ?? "").trim();
}

/** Extracts one version's section from a Node.js CHANGELOG_V*.md file. */
function nodeSection(md, version) {
  const lines = md.split("\n");
  const re = new RegExp(`^##\\s+.*\\bVersion ${version.replaceAll(".", "\\.")}\\b`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join("\n").trim();
}

/** Converts Apple DocC JSON (developer.apple.com/documentation) to Markdown. */
function doccToMarkdown(doc) {
  const inline = (nodes = []) =>
    nodes
      .map((n) => {
        switch (n.type) {
          case "codeVoice":
            return `\`${n.code}\``;
          case "emphasis":
            return `*${inline(n.inlineContent)}*`;
          case "strong":
            return `**${inline(n.inlineContent)}**`;
          case "reference":
            return doc.references?.[n.identifier]?.title ?? n.identifier;
          case "link":
            return `[${n.title ?? n.destination}](${n.destination})`;
          default:
            return n.text ?? inline(n.inlineContent);
        }
      })
      .join("");
  const block = (b, indent = "") => {
    switch (b.type) {
      case "heading":
        return `${"#".repeat(b.level)} ${b.text}`;
      case "paragraph":
        return indent + inline(b.inlineContent);
      case "unorderedList":
      case "orderedList":
        return b.items
          .map((item, i) => {
            const marker = b.type === "orderedList" ? `${i + 1}.` : "-";
            const [first, ...rest] = item.content.map((c) => block(c, indent + "  ").trimStart());
            return [`${indent}${marker} ${first}`, ...rest].join("\n");
          })
          .join("\n");
      case "codeListing":
        return `\`\`\`${b.syntax ?? ""}\n${b.code.join("\n")}\n\`\`\``;
      case "aside":
        return b.content.map((c) => `> ${block(c)}`).join("\n");
      default:
        return "";
    }
  };
  const title = doc.metadata?.title ? `# ${doc.metadata.title}\n\n${inline(doc.abstract)}\n\n` : "";
  const body = (doc.primaryContentSections ?? [])
    .flatMap((sec) => sec.content ?? [])
    .map((b) => block(b))
    .filter(Boolean)
    .join("\n\n");
  return `${title}${body}`.trim();
}

async function convert(browser, version, release) {
  const full = new URL(release.release_notes);
  const fragment = full.hash.slice(1);
  full.hash = "";
  const url = full.href;

  // GitHub release tag pages: use the API for the Markdown body.
  const gh = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/(.+)$/);
  if (gh) {
    const res = await get(`https://api.github.com/repos/${gh[1]}/releases/tags/${gh[2]}`);
    if (res.ok) {
      const j = await res.json();
      return { markdown: `# ${j.name ?? j.tag_name}\n\n${j.body ?? ""}`.trim(), archivedFrom: null };
    }
  }

  // Node.js changelog files: fetch raw and pick the section.
  const nodeLog = url.match(/^https:\/\/github\.com\/nodejs\/node\/blob\/([^/]+)\/(doc\/changelogs\/.+\.md)$/);
  if (nodeLog) {
    const res = await get(`https://raw.githubusercontent.com/nodejs/node/${nodeLog[1]}/${nodeLog[2]}`);
    if (res.ok) {
      const section = nodeSection(await res.text(), version);
      if (section) return { markdown: section, archivedFrom: null };
    }
  }

  // Apple documentation pages are JS-rendered; use the DocC JSON behind them.
  if (full.hostname === "developer.apple.com" && full.pathname.startsWith("/documentation/")) {
    const res = await get(`https://developer.apple.com/tutorials/data${full.pathname}.json`);
    if (res.ok) return { markdown: doccToMarkdown(await res.json()), archivedFrom: null };
  }

  const page = await fetchPage(url, release.release_date);
  if (!page) return null;
  return { markdown: htmlToMarkdown(page.body, fragment), archivedFrom: page.archivedFrom };
}

async function runBrowser(browser) {
  const file = path.join(values.bcd, "browsers", `${browser}.json`);
  const releases = JSON.parse(await readFile(file, "utf8")).browsers[browser].releases;
  const dir = path.join(values.out, browser);
  await mkdir(dir, { recursive: true });

  const queue = Object.entries(releases);
  const report = { missingUrl: [], failed: [], archived: [], fetched: 0, skipped: 0 };

  async function worker() {
    for (let item; (item = queue.shift()); ) {
      const [version, release] = item;
      if (["planned", "beta", "nightly"].includes(release.status)) continue;
      if (!release.release_notes) {
        report.missingUrl.push(version);
        continue;
      }
      const target = path.join(dir, `${version}.md`);
      if (!values.force && existsSync(target)) {
        report.skipped++;
        continue;
      }
      try {
        const result = await convert(browser, version, release);
        if (!result?.markdown) {
          report.failed.push(version);
          continue;
        }
        const front = [
          "---",
          `browser: ${browser}`,
          `version: "${version}"`,
          release.release_date ? `release_date: ${release.release_date}` : null,
          `source_url: ${release.release_notes}`,
          result.archivedFrom ? `archived_from: ${result.archivedFrom}` : null,
          `fetched_at: ${new Date().toISOString().slice(0, 10)}`,
          "---",
          "",
        ];
        await writeFile(target, front.filter((l) => l !== null).join("\n") + result.markdown + "\n");
        report.fetched++;
        if (result.archivedFrom) report.archived.push(version);
      } catch (e) {
        report.failed.push(`${version} (${e.message})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
  console.log(
    `${browser}: fetched ${report.fetched}, skipped ${report.skipped}, from Wayback ${report.archived.length}, ` +
      `no URL ${report.missingUrl.length}, failed ${report.failed.length}`,
  );
  if (report.failed.length) console.log(`  failed: ${report.failed.join(", ")}`);
  if (report.missingUrl.length) console.log(`  no URL: ${report.missingUrl.join(", ")}`);
}

for (const browser of positionals) await runBrowser(browser);
