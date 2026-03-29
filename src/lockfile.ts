import fs from "node:fs/promises";
import path from "node:path";

const LOCKFILE_NAME = ".linear-tickets.json";

export interface LockfileEntry {
  /** The stable identifier used as the lockfile key (meta.id or contentHash). */
  stableId: string;
  /**
   * Hash of the snippet's title + code at the time it was last synced.
   * When this differs from the current snippet's contentHash, the issue is updated.
   * May be absent on entries written by older versions of the tool; treated as unchanged.
   */
  contentHash?: string;
  issueId: string;
  issueUrl: string;
  title: string;
  file: string;
  startLine: number;
  createdAt: string;
  updatedAt?: string;
}

export interface Lockfile {
  version: 1;
  entries: Record<string, LockfileEntry>;
}

function emptyLockfile(): Lockfile {
  return { version: 1, entries: {} };
}

export async function readLockfile(dir: string): Promise<Lockfile> {
  const lockPath = path.join(dir, LOCKFILE_NAME);
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    return JSON.parse(raw) as Lockfile;
  } catch {
    return emptyLockfile();
  }
}

export async function writeLockfile(dir: string, lockfile: Lockfile): Promise<void> {
  const lockPath = path.join(dir, LOCKFILE_NAME);
  await fs.writeFile(lockPath, JSON.stringify(lockfile, null, 2) + "\n", "utf-8");
}

/** Returns true if a lockfile entry exists for the given stableId. */
export function isAlreadyFiled(lockfile: Lockfile, stableId: string): boolean {
  return stableId in lockfile.entries;
}

/**
 * Returns true if a filed snippet's content has changed since it was last synced.
 * Entries written by older versions of the tool lack a contentHash field; those
 * are treated as unchanged to avoid spurious updates on first migration.
 */
export function hasChanged(
  lockfile: Lockfile,
  stableId: string,
  currentContentHash: string
): boolean {
  const entry = lockfile.entries[stableId];
  if (!entry?.contentHash) return false;
  return entry.contentHash !== currentContentHash;
}

export function recordEntry(
  lockfile: Lockfile,
  entry: LockfileEntry
): Lockfile {
  return {
    ...lockfile,
    entries: {
      ...lockfile.entries,
      [entry.stableId]: entry,
    },
  };
}
