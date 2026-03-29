import { parse, type ParserOptions } from "@babel/parser";
import type { File } from "@babel/types";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TicketMetaSchema } from "./schema.ts";
import type { Snippet } from "./schema.ts";

const START_MARKER = "@linear-start";
const END_MARKER = "@linear-end";

interface CommentRange {
  metaLines: string[];
  startLine: number;
  endLine: number;
}

/**
 * Determines the appropriate Babel parser plugins based on file extension.
 */
function getParserPlugins(filePath: string): NonNullable<ParserOptions["plugins"]> {
  const ext = path.extname(filePath).toLowerCase();
  const plugins: NonNullable<ParserOptions["plugins"]> = [
    "decorators-legacy",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "dynamicImport",
    "exportDefaultFrom",
    "optionalChaining",
    "nullishCoalescingOperator",
  ];

  if (ext === ".tsx") {
    plugins.push("typescript", "jsx");
  } else if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    plugins.push("typescript");
  } else if (ext === ".jsx") {
    plugins.push("jsx");
  } else if (ext === ".mjs" || ext === ".cjs" || ext === ".js") {
    plugins.push("jsx");
  }

  return plugins;
}

/**
 * Extracts key: value metadata pairs from lines between @linear-start and the
 * first non-comment code line.
 *
 * Example lines:
 *   // title: Fix broken auth
 *   // priority: high
 *   // labels: bug, auth
 */
function parseMetaLines(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of lines) {
    const cleaned = line.replace(/^\s*\/\/\s*/, "").trim();
    const colonIdx = cleaned.indexOf(":");
    if (colonIdx === -1) continue;
    const key = cleaned.slice(0, colonIdx).trim().toLowerCase();
    const value = cleaned.slice(colonIdx + 1).trim();
    if (key && value) meta[key] = value;
  }
  return meta;
}

/**
 * Collects all comment lines that immediately follow the @linear-start marker
 * (before the actual code starts), using the raw source lines.
 */
function collectMetaLines(
  sourceLines: string[],
  markerLine: number // 1-indexed
): { metaLines: string[]; codeStartLine: number } {
  const metaLines: string[] = [];
  let i = markerLine; // markerLine is the line of @linear-start; start at next line (still 1-indexed → index markerLine)

  while (i < sourceLines.length) {
    const line = sourceLines[i]; // array is 0-indexed, i starts at markerLine (1-based → index = markerLine)
    const trimmed = line.trim();
    // Stop collecting meta when we hit a blank line or a non-comment line
    if (trimmed === "" || !trimmed.startsWith("//")) {
      break;
    }
    // Stop if we've hit another marker
    if (trimmed.includes(START_MARKER) || trimmed.includes(END_MARKER)) {
      break;
    }
    metaLines.push(line);
    i++;
  }

  return { metaLines, codeStartLine: i + 1 }; // +1 back to 1-indexed
}

/**
 * Finds all @linear-start / @linear-end ranges in a parsed AST + source text.
 */
function findMarkerRanges(ast: File, sourceLines: string[]): CommentRange[] {
  const ranges: CommentRange[] = [];
  const allComments = ast.comments ?? [];

  // Only match single-line comments whose trimmed value starts with the marker
  // to avoid false positives from JSDoc or other block comments that merely
  // mention the marker in descriptive text.
  const startComments = allComments.filter(
    (c) => c.type === "CommentLine" && c.value.trim().startsWith(START_MARKER)
  );
  const endComments = allComments.filter(
    (c) => c.type === "CommentLine" && c.value.trim().startsWith(END_MARKER)
  );

  for (const start of startComments) {
    const startLine = start.loc!.start.line;

    // Find the nearest @linear-end that comes after this start
    const end = endComments.find(
      (c) => c.loc!.start.line > startLine
    );

    if (!end) {
      console.warn(
        `  Warning: @linear-start on line ${startLine} has no matching @linear-end — skipped.`
      );
      continue;
    }

    const { metaLines } = collectMetaLines(sourceLines, startLine);

    ranges.push({
      metaLines,
      startLine,
      endLine: end.loc!.start.line,
    });
  }

  return ranges;
}

/**
 * Parses a single source file and returns all annotated snippets found in it.
 */
export async function extractSnippets(filePath: string): Promise<Snippet[]> {
  const source = await fs.readFile(filePath, "utf-8");
  const sourceLines = source.split("\n");

  let ast: File;
  try {
    ast = parse(source, {
      sourceType: "module",
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: true,
      plugins: getParserPlugins(filePath),
    });
  } catch (err) {
    console.warn(`  Warning: Could not parse ${filePath} — skipped. (${(err as Error).message})`);
    return [];
  }

  const ranges = findMarkerRanges(ast, sourceLines);
  const snippets: Snippet[] = [];

  for (const range of ranges) {
    const rawMeta = parseMetaLines(range.metaLines);
    const metaResult = TicketMetaSchema.safeParse(rawMeta);

    if (!metaResult.success) {
      console.warn(
        `  Warning: Invalid metadata in ${filePath} at line ${range.startLine}:`
      );
      for (const issue of metaResult.error.issues) {
        console.warn(`    - ${issue.path.join(".")}: ${issue.message}`);
      }
      continue;
    }

    // Capture lines between the two markers (exclusive of marker lines themselves)
    const codeLines = sourceLines.slice(range.startLine, range.endLine - 1);
    // Strip leading meta comment lines from the captured code
    const metaLineCount = range.metaLines.length;
    const code = codeLines.slice(metaLineCount).join("\n").trim();

    // Hash covers title + code so that changes to either are detected.
    const contentHash = createHash("sha256")
      .update(`${metaResult.data.title}:${code}`)
      .digest("hex")
      .slice(0, 16);

    // stableId is user-supplied (meta.id) when available so the snippet can be
    // tracked across content edits. Falls back to contentHash for snippets
    // without an explicit id, preserving the original create-only behaviour.
    const stableId = metaResult.data.id ?? contentHash;

    snippets.push({
      meta: metaResult.data,
      code,
      file: filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      contentHash,
      stableId,
    });
  }

  return snippets;
}

/**
 * Processes multiple files and returns all snippets found across them.
 */
export async function extractSnippetsFromFiles(
  files: string[]
): Promise<Snippet[]> {
  const results: Snippet[] = [];

  for (const file of files) {
    const snippets = await extractSnippets(file);
    results.push(...snippets);
  }

  return results;
}
