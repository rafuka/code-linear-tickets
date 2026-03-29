#!/usr/bin/env tsx
import "dotenv/config";
import { Command } from "commander";
import path from "node:path";
import { discoverFiles } from "./discover.ts";
import { extractSnippetsFromFiles } from "./parse.ts";
import { createIssue, updateIssue, issueExists } from "./linear.ts";
import {
  readLockfile,
  writeLockfile,
  isAlreadyFiled,
  hasChanged,
  recordEntry,
} from "./lockfile.ts";
import type { Snippet } from "./schema.ts";

const program = new Command();

program
  .name("code-linear-tickets")
  .description(
    "Scan source files for @linear-start / @linear-end annotations and create Linear issues."
  )
  .version("1.0.0");

program
  .command("scan", { isDefault: true })
  .description("Scan a directory and create Linear tickets for annotated snippets")
  .option(
    "-d, --dir <path>",
    "Root directory to scan (defaults to current working directory)",
    process.cwd()
  )
  .option(
    "-t, --team <team>",
    "Linear team key or name to file issues under (e.g. ENG)",
    process.env.LINEAR_TEAM ?? ""
  )
  .option("--dry-run", "Print tickets that would be created without calling the API", false)
  .option(
    "--no-lockfile",
    "Skip reading/writing the .linear-tickets.json lockfile (allows duplicate tickets)"
  )
  .option(
    "--no-deleted-check",
    "Skip verifying that previously-filed issues still exist in Linear (faster, but won't re-create deleted tickets)"
  )
  .action(async (options) => {
    const dir = path.resolve(options.dir as string);
    const team = options.team as string;
    const dryRun = options.dryRun as boolean;
    const useLockfile = options.lockfile as boolean;
    const checkDeleted = options.deletedCheck as boolean;
    const apiKey = process.env.LINEAR_API_KEY ?? "";

    // --- Validation ---
    if (!dryRun && !apiKey) {
      console.error("Error: LINEAR_API_KEY environment variable is not set.");
      console.error("       Add it to your .env file or export it in your shell.");
      process.exit(1);
    }

    if (!dryRun && !team) {
      console.error(
        "Error: No team specified. Use --team <key> or set LINEAR_TEAM in your .env file."
      );
      process.exit(1);
    }

    console.log(`Scanning: ${dir}`);
    if (dryRun) console.log("Mode:     dry-run (no changes will be made)\n");

    // --- Discover files ---
    const files = await discoverFiles({ dir });
    console.log(`Found ${files.length} source file(s) to scan.\n`);

    // --- Extract snippets ---
    const snippets = await extractSnippetsFromFiles(files);

    if (snippets.length === 0) {
      console.log("No @linear-start annotations found. Nothing to do.");
      return;
    }

    console.log(`Found ${snippets.length} annotated snippet(s).\n`);

    // --- Load lockfile ---
    let lockfile = useLockfile ? await readLockfile(dir) : { version: 1 as const, entries: {} };

    // --- Categorise snippets into three buckets ---
    const toCreate: Snippet[] = [];
    const toUpdate: Snippet[] = [];
    const skipped: Snippet[] = [];

    for (const snippet of snippets) {
      if (!useLockfile || !isAlreadyFiled(lockfile, snippet.stableId)) {
        toCreate.push(snippet);
      } else if (hasChanged(lockfile, snippet.stableId, snippet.contentHash)) {
        toUpdate.push(snippet);
      } else {
        skipped.push(snippet);
      }
    }

    // --- Detect deleted issues among unchanged snippets ---
    // Track which re-creates are due to deletion (for display purposes).
    const recreateIds = new Set<string>();

    if (useLockfile && checkDeleted && skipped.length > 0 && apiKey) {
      process.stdout.write(
        `Verifying ${skipped.length} unchanged snippet(s) against Linear ... `
      );

      const checks = await Promise.all(
        skipped.map(async (s) => {
          const entry = lockfile.entries[s.stableId];
          const exists = await issueExists({ apiKey, defaultTeam: team }, entry.issueId);
          return { snippet: s, exists };
        })
      );

      const deleted = checks.filter((c) => !c.exists).map((c) => c.snippet);
      const intact = checks.filter((c) => c.exists).map((c) => c.snippet);

      console.log(
        deleted.length > 0
          ? `${deleted.length} deleted, ${intact.length} intact.`
          : "all intact."
      );

      // Promote deleted snippets to re-create; keep only intact ones in skipped.
      skipped.length = 0;
      intact.forEach((s) => skipped.push(s));
      deleted.forEach((s) => {
        recreateIds.add(s.stableId);
        toCreate.push(s);
      });

      if (deleted.length > 0) console.log();
    } else if (useLockfile && checkDeleted && skipped.length > 0 && !apiKey && dryRun) {
      console.log(
        `Note: skipping deleted-issue check for ${skipped.length} unchanged snippet(s) — no API key available in dry-run mode.\n`
      );
    }

    if (skipped.length > 0) {
      console.log(`Skipping ${skipped.length} unchanged snippet(s):`);
      for (const s of skipped) {
        const entry = lockfile.entries[s.stableId];
        console.log(`  [unchanged] "${s.meta.title}" → ${entry?.issueUrl ?? "unknown"}`);
      }
      console.log();
    }

    if (toCreate.length === 0 && toUpdate.length === 0) {
      console.log("All snippets are up to date. Nothing to do.");
      return;
    }

    // --- Process tickets ---
    let created = 0;
    let updated = 0;
    let failed = 0;
    const linearConfig = { apiKey, defaultTeam: team };

    for (const snippet of toCreate) {
      const label = `"${snippet.meta.title}"`;
      const location = `${path.relative(dir, snippet.file)}:${snippet.startLine}`;
      const isRecreate = recreateIds.has(snippet.stableId);
      const verb = isRecreate ? "Re-create" : "Create";

      if (dryRun) {
        console.log(`[dry-run] Would ${verb.toLowerCase()}: ${label}${isRecreate ? " (deleted in Linear)" : ""}`);
        console.log(`          File:     ${location}`);
        console.log(`          Priority: ${snippet.meta.priority}`);
        if (snippet.meta.labels.length > 0) {
          console.log(`          Labels:   ${snippet.meta.labels.join(", ")}`);
        }
        if (snippet.meta.assignee) {
          console.log(`          Assignee: ${snippet.meta.assignee}`);
        }
        console.log();
        continue;
      }

      try {
        process.stdout.write(`${verb}:  ${label} ... `);
        const issue = await createIssue(linearConfig, snippet);

        lockfile = recordEntry(lockfile, {
          stableId: snippet.stableId,
          contentHash: snippet.contentHash,
          issueId: issue.id,
          issueUrl: issue.url,
          title: issue.title,
          file: snippet.file,
          startLine: snippet.startLine,
          createdAt: new Date().toISOString(),
        });

        console.log(`✓ ${issue.url}`);
        created++;
      } catch (err) {
        console.log(`✗ failed`);
        console.error(`  Error: ${(err as Error).message}`);
        failed++;
      }
    }

    for (const snippet of toUpdate) {
      const label = `"${snippet.meta.title}"`;
      const location = `${path.relative(dir, snippet.file)}:${snippet.startLine}`;
      const existingEntry = lockfile.entries[snippet.stableId];

      if (dryRun) {
        console.log(`[dry-run] Would update: ${label} → ${existingEntry?.issueUrl ?? "unknown"}`);
        console.log(`          File:     ${location}`);
        console.log(`          Priority: ${snippet.meta.priority}`);
        if (snippet.meta.labels.length > 0) {
          console.log(`          Labels:   ${snippet.meta.labels.join(", ")}`);
        }
        if (snippet.meta.assignee) {
          console.log(`          Assignee: ${snippet.meta.assignee}`);
        }
        console.log();
        continue;
      }

      try {
        process.stdout.write(`Updating: ${label} ... `);
        const issue = await updateIssue(linearConfig, existingEntry.issueId, snippet);

        lockfile = recordEntry(lockfile, {
          ...existingEntry,
          contentHash: snippet.contentHash,
          title: issue.title,
          file: snippet.file,
          startLine: snippet.startLine,
          updatedAt: new Date().toISOString(),
        });

        console.log(`✓ ${issue.url}`);
        updated++;
      } catch (err) {
        console.log(`✗ failed`);
        console.error(`  Error: ${(err as Error).message}`);
        failed++;
      }
    }

    // --- Save lockfile ---
    if (!dryRun && useLockfile && (created > 0 || updated > 0)) {
      await writeLockfile(dir, lockfile);
    }

    // --- Summary ---
    console.log();
    if (dryRun) {
      const parts = [];
      if (toCreate.length > 0) parts.push(`${toCreate.length} to create`);
      if (toUpdate.length > 0) parts.push(`${toUpdate.length} to update`);
      console.log(`Dry run complete. ${parts.join(", ")}.`);
    } else {
      const parts = [];
      if (created > 0) parts.push(`${created} created`);
      if (updated > 0) parts.push(`${updated} updated`);
      if (failed > 0) parts.push(`${failed} failed`);
      console.log(`Done. ${parts.join(", ") || "nothing changed"}.`);
    }
  });

program
  .command("list")
  .description("List all snippets found in a directory without creating tickets")
  .option("-d, --dir <path>", "Root directory to scan", process.cwd())
  .action(async (options) => {
    const dir = path.resolve(options.dir as string);
    const files = await discoverFiles({ dir });
    const snippets = await extractSnippetsFromFiles(files);

    if (snippets.length === 0) {
      console.log("No @linear-start annotations found.");
      return;
    }

    console.log(`Found ${snippets.length} snippet(s):\n`);
    for (const s of snippets) {
      console.log(`  • "${s.meta.title}"`);
      console.log(`    File:     ${path.relative(dir, s.file)}:${s.startLine}`);
      console.log(`    Priority: ${s.meta.priority}`);
      if (s.meta.labels.length > 0) console.log(`    Labels:   ${s.meta.labels.join(", ")}`);
      if (s.meta.assignee) console.log(`    Assignee: ${s.meta.assignee}`);
      console.log();
    }
  });

program
  .command("status")
  .description("Show which snippets have already been filed vs. pending")
  .option("-d, --dir <path>", "Root directory to scan", process.cwd())
  .option(
    "--check-deleted",
    "Verify each filed issue still exists in Linear (requires LINEAR_API_KEY)"
  )
  .action(async (options) => {
    const dir = path.resolve(options.dir as string);
    const checkDeleted = options.checkDeleted as boolean;
    const apiKey = process.env.LINEAR_API_KEY ?? "";
    const files = await discoverFiles({ dir });
    const snippets = await extractSnippetsFromFiles(files);
    const lockfile = await readLockfile(dir);

    const filed = snippets.filter((s) => isAlreadyFiled(lockfile, s.stableId));
    const changed = filed.filter((s) => hasChanged(lockfile, s.stableId, s.contentHash));
    const pending = snippets.filter((s) => !isAlreadyFiled(lockfile, s.stableId));

    // Optionally verify existence of filed issues against the Linear API.
    const deletedIds = new Set<string>();
    if (checkDeleted && filed.length > 0) {
      if (!apiKey) {
        console.warn("Warning: --check-deleted requires LINEAR_API_KEY to be set — skipped.\n");
      } else {
        process.stdout.write(`Verifying ${filed.length} filed issue(s) against Linear ... `);
        const checks = await Promise.all(
          filed.map(async (s) => {
            const entry = lockfile.entries[s.stableId];
            const exists = await issueExists({ apiKey, defaultTeam: "" }, entry.issueId);
            return { stableId: s.stableId, exists };
          })
        );
        checks.filter((c) => !c.exists).forEach((c) => deletedIds.add(c.stableId));
        console.log(
          deletedIds.size > 0
            ? `${deletedIds.size} deleted, ${filed.length - deletedIds.size} intact.`
            : "all intact."
        );
        console.log();
      }
    }

    console.log(
      `Total: ${snippets.length} snippet(s) — ` +
        `${pending.length} pending, ` +
        `${filed.length - changed.length - deletedIds.size} up to date, ` +
        `${changed.length} changed` +
        (deletedIds.size > 0 ? `, ${deletedIds.size} deleted in Linear` : "") +
        "\n"
    );

    if (filed.length > 0) {
      console.log("Filed:");
      for (const s of filed) {
        const entry = lockfile.entries[s.stableId];
        const flags: string[] = [];
        if (hasChanged(lockfile, s.stableId, s.contentHash)) flags.push("changed");
        if (deletedIds.has(s.stableId)) flags.push("deleted in Linear");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        console.log(`  ✓ "${s.meta.title}"${flagStr} → ${entry.issueUrl}`);
      }
      console.log();
    }

    if (pending.length > 0) {
      console.log("Pending:");
      for (const s of pending) {
        console.log(`  ○ "${s.meta.title}" (${path.relative(dir, s.file)}:${s.startLine})`);
      }
    }
  });

program.parse();
