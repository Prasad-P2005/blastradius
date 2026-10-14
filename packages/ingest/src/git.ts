/**
 * Reading merged pull requests out of a git clone. Everything here is REAL.
 *
 * GitHub records a merged PR on the default branch in one of two ways:
 *   - squash merge:  one commit whose subject ends in "(#1234)"
 *   - merge commit:  "Merge pull request #1234 from owner/branch"; the PR title
 *                    is the first line of the body and the PR author is the
 *                    author of the merge's second parent (the branch tip).
 * We walk `--first-parent` history so each PR appears exactly once, and use
 * `--numstat` for per-file additions/deletions (for a merge commit git diffs
 * against the first parent, i.e. the whole PR). Direct pushes without a PR
 * number are skipped: they are not PRs.
 *
 * No emails are read: the log format only asks for the author NAME (%an).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@blastradius/shared/env";
import { REPOS_DIR, type SourceConfig } from "./sources.ts";

export interface RawFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface RawPr {
  number: number;
  /** squash or merge commit sha on the default branch */
  sha: string;
  /** committer time of that commit = when it landed, epoch ms */
  mergedAt: number;
  authorName: string;
  title: string;
  files: RawFileChange[];
  additions: number;
  deletions: number;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

export function cloneDirFor(src: SourceConfig, root = findRepoRoot()): string {
  return join(root, REPOS_DIR, src.cloneDir);
}

/** Full clone (we need blobs for --numstat; blobless clones fetch lazily and are ~100x slower). */
export function cloneOrFetch(src: SourceConfig, root = findRepoRoot()): { dir: string; head: string; action: string } {
  const dir = cloneDirFor(src, root);
  let action: string;
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["clone", "--quiet", src.url, dir], { stdio: "inherit" });
    action = "cloned";
  } else if (hasCommit(dir, src.snapshotSha) && hasCommit(dir, src.deltaSha)) {
    action = "present"; // pinned commits already here: no network needed
  } else {
    git(dir, ["fetch", "--quiet", "origin"]);
    action = "fetched";
  }
  for (const sha of [src.snapshotSha, src.deltaSha]) {
    if (!hasCommit(dir, sha)) throw new Error(`${src.repo}: pinned commit ${sha} not found after fetch`);
  }
  const head = git(dir, ["rev-parse", "origin/HEAD"]).trim();
  return { dir, head, action };
}

export function hasCommit(dir: string, sha: string): boolean {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Detached checkout of the pinned snapshot commit, so the working tree matches the data. */
export function checkoutPinned(dir: string, sha: string): void {
  git(dir, ["checkout", "--quiet", "--detach", sha]);
}

const SQUASH_RE = /\s*\(#(\d+)\)\s*$/;
const MERGE_RE = /^Merge pull request #(\d+) from \S+/;

interface CommitMeta {
  sha: string;
  ct: number;
  authorName: string;
  parents: string[];
  subject: string;
}

/**
 * Merged PRs reachable from `to` by first-parent history, newest first.
 * `from` (exclusive) limits the range, like `git log from..to`.
 */
export function readMergedPrs(dir: string, opts: { to: string; from?: string }): RawPr[] {
  const range = opts.from ? `${opts.from}..${opts.to}` : opts.to;

  // Pass 1: one line of metadata per commit. \x1f separates fields.
  const metaOut = git(dir, ["log", "--first-parent", "--format=%H%x1f%ct%x1f%an%x1f%P%x1f%s", range]);
  const metas: CommitMeta[] = [];
  for (const line of metaOut.split("\n")) {
    if (!line) continue;
    const [sha, ct, an, parents, ...rest] = line.split("\x1f");
    metas.push({ sha: sha!, ct: Number(ct), authorName: an!, parents: (parents ?? "").split(" ").filter(Boolean), subject: rest.join("\x1f") });
  }

  // Pass 2: numstat per commit. A \x1e record separator precedes each sha.
  const statOut = git(dir, ["log", "--first-parent", "--no-renames", "--numstat", "--format=%x1e%H", range]);
  const filesBySha = new Map<string, RawFileChange[]>();
  for (const block of statOut.split("\x1e")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const sha = lines[0]!.trim();
    const files: RawFileChange[] = [];
    for (const l of lines.slice(1)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (!m) continue;
      // "-" means binary: count it as a changed file with 0 lines.
      files.push({ path: m[3]!, additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) });
    }
    filesBySha.set(sha, files);
  }

  const prs: RawPr[] = [];
  const seen = new Set<number>();
  for (const c of metas) {
    let number: number | null = null;
    let title = c.subject;
    let authorName = c.authorName;
    const merge = MERGE_RE.exec(c.subject);
    const squash = SQUASH_RE.exec(c.subject);
    if (merge && c.parents.length > 1) {
      number = Number(merge[1]);
      const body = git(dir, ["log", "-1", "--format=%b", c.sha]).split("\n").map((s) => s.trim()).find(Boolean);
      title = body ?? c.subject;
      authorName = git(dir, ["log", "-1", "--format=%an", c.parents[1]!]).trim() || c.authorName;
    } else if (squash) {
      number = Number(squash[1]);
      title = c.subject.replace(SQUASH_RE, "").trim();
    }
    if (number === null || seen.has(number)) continue; // not a PR, or a duplicate (keep newest)
    seen.add(number);
    const files = filesBySha.get(c.sha) ?? [];
    prs.push({
      number,
      sha: c.sha,
      mergedAt: c.ct * 1000,
      authorName,
      title: title || `PR #${number}`,
      files,
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
    });
  }
  return prs; // git log order = newest first
}

/** Reads a file as it was at a commit (used to sanity-check curated deps). */
export function showFile(dir: string, sha: string, path: string): string | null {
  try {
    return git(dir, ["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}
