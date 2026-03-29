import { LinearClient } from "@linear/sdk";
import type { Snippet } from "./schema.ts";
import { LINEAR_PRIORITY_MAP } from "./schema.ts";

export interface LinearConfig {
  apiKey: string;
  /** Default team key/name to file issues under (e.g. "ENG"). Can be overridden per-snippet. */
  defaultTeam: string;
}

export interface CreatedIssue {
  id: string;
  url: string;
  title: string;
}

let _client: LinearClient | null = null;

function getClient(apiKey: string): LinearClient {
  if (!_client) {
    _client = new LinearClient({ apiKey });
  }
  return _client;
}

/**
 * Resolves a team ID from a team key or name string.
 * Linear team keys look like "ENG", "INFRA", etc.
 */
async function resolveTeamId(
  client: LinearClient,
  teamKeyOrName: string
): Promise<string> {
  const teams = await client.teams();
  const match = teams.nodes.find(
    (t) =>
      t.key.toLowerCase() === teamKeyOrName.toLowerCase() ||
      t.name.toLowerCase() === teamKeyOrName.toLowerCase()
  );

  if (!match) {
    const available = teams.nodes.map((t) => `${t.key} (${t.name})`).join(", ");
    throw new Error(
      `Team "${teamKeyOrName}" not found. Available teams: ${available}`
    );
  }

  return match.id;
}

/**
 * Resolves label IDs from label names for a given team.
 * Unknown labels are silently skipped with a warning.
 */
async function resolveLabelIds(
  client: LinearClient,
  teamId: string,
  labelNames: string[]
): Promise<string[]> {
  if (labelNames.length === 0) return [];

  const labels = await client.issueLabels({ filter: { team: { id: { eq: teamId } } } });
  const ids: string[] = [];

  for (const name of labelNames) {
    const match = labels.nodes.find(
      (l) => l.name.toLowerCase() === name.toLowerCase()
    );
    if (match) {
      ids.push(match.id);
    } else {
      console.warn(`  Warning: Label "${name}" not found in team — skipped.`);
    }
  }

  return ids;
}

/**
 * Resolves a Linear user ID from an email address.
 */
async function resolveAssigneeId(
  client: LinearClient,
  email: string
): Promise<string | undefined> {
  const members = await client.users({ filter: { email: { eq: email } } });
  return members.nodes[0]?.id;
}

/**
 * Builds the markdown description body for the Linear issue.
 */
function buildDescription(snippet: Snippet): string {
  const ext = snippet.file.split(".").pop() ?? "ts";
  const relFile = snippet.file;

  return [
    `**Source:** \`${relFile}\` (lines ${snippet.startLine}–${snippet.endLine})`,
    "",
    "```" + ext,
    snippet.code,
    "```",
  ].join("\n");
}

/**
 * Returns true if the Linear issue with the given ID still exists and has not
 * been permanently deleted. Archived issues are treated as still existing.
 */
export async function issueExists(
  config: LinearConfig,
  issueId: string
): Promise<boolean> {
  const client = getClient(config.apiKey);
  try {
    const issue = await client.issue(issueId);
    return issue != null;
  } catch {
    // Any error (not-found, network, etc.) is treated as non-existent so that
    // a transient failure doesn't silently cause a re-create. The caller should
    // decide whether to proceed based on context.
    return false;
  }
}

/**
 * Updates an existing Linear issue to reflect the current state of a snippet.
 * Re-resolves labels and assignee in case they changed in the metadata.
 */
export async function updateIssue(
  config: LinearConfig,
  issueId: string,
  snippet: Snippet
): Promise<CreatedIssue> {
  const client = getClient(config.apiKey);

  const teamKey = snippet.meta.team ?? config.defaultTeam;
  const teamId = await resolveTeamId(client, teamKey);

  const [labelIds, assigneeId] = await Promise.all([
    resolveLabelIds(client, teamId, snippet.meta.labels),
    snippet.meta.assignee
      ? resolveAssigneeId(client, snippet.meta.assignee)
      : Promise.resolve(undefined),
  ]);

  const payload = await client.updateIssue(issueId, {
    title: snippet.meta.title,
    description: buildDescription(snippet),
    priority: LINEAR_PRIORITY_MAP[snippet.meta.priority],
    ...(labelIds.length > 0 && { labelIds }),
    ...(assigneeId && { assigneeId }),
  });

  const issue = await payload.issue;
  if (!issue) {
    throw new Error(`Linear API did not return an issue for "${snippet.meta.title}"`);
  }

  return {
    id: issue.id,
    url: issue.url,
    title: issue.title,
  };
}

/**
 * Creates a single Linear issue from a snippet.
 */
export async function createIssue(
  config: LinearConfig,
  snippet: Snippet
): Promise<CreatedIssue> {
  const client = getClient(config.apiKey);

  const teamKey = snippet.meta.team ?? config.defaultTeam;
  const teamId = await resolveTeamId(client, teamKey);

  const [labelIds, assigneeId] = await Promise.all([
    resolveLabelIds(client, teamId, snippet.meta.labels),
    snippet.meta.assignee
      ? resolveAssigneeId(client, snippet.meta.assignee)
      : Promise.resolve(undefined),
  ]);

  const payload = await client.createIssue({
    teamId,
    title: snippet.meta.title,
    description: buildDescription(snippet),
    priority: LINEAR_PRIORITY_MAP[snippet.meta.priority],
    ...(labelIds.length > 0 && { labelIds }),
    ...(assigneeId && { assigneeId }),
  });

  const issue = await payload.issue;
  if (!issue) {
    throw new Error(`Linear API did not return an issue for "${snippet.meta.title}"`);
  }

  return {
    id: issue.id,
    url: issue.url,
    title: issue.title,
  };
}
