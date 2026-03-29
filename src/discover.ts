import fg from "fast-glob";
import path from "node:path";

const DEFAULT_PATTERNS = [
  "**/*.js",
  "**/*.jsx",
  "**/*.ts",
  "**/*.tsx",
  "**/*.mjs",
  "**/*.cjs",
];

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.d.ts",
];

export interface DiscoverOptions {
  dir: string;
  patterns?: string[];
  ignore?: string[];
}

/**
 * Returns absolute paths to all JS/TS source files under `dir`,
 * excluding generated output and dependencies.
 */
export async function discoverFiles(opts: DiscoverOptions): Promise<string[]> {
  const { dir, patterns = DEFAULT_PATTERNS, ignore = DEFAULT_IGNORE } = opts;

  const files = await fg(patterns, {
    cwd: path.resolve(dir),
    ignore,
    absolute: true,
    followSymbolicLinks: false,
  });

  return files.sort();
}
