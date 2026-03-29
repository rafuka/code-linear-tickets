# code-linear-tickets

Scan JS/TS/JSX/TSX source files for annotated code snippets and automatically create Linear issues from them.

## How it works

Wrap any block of code with `@linear-start` / `@linear-end` comment markers. Metadata is provided as `key: value` comment lines immediately after the start marker.

```tsx
// @linear-start
// id: auth-redirect-fix          (recommended — see "Updating issues" below)
// title: Fix broken auth redirect after OAuth flow
// priority: high
// labels: bug, auth
// assignee: user@example.com   (optional)
// team: ENG                     (optional — overrides default)
const result = await signIn(provider);
if (!result.ok) {
  router.push("/login"); // should redirect to original destination
}
// @linear-end
```

Running the tool against this file creates a Linear issue titled **"Fix broken auth redirect after OAuth flow"** with the code block embedded in the description.

## Authentication

This tool authenticates with Linear using a **personal API key**. Linear also supports OAuth for applications, but a personal API key is the simplest approach for a local CLI.

**Steps to create your API key:**

1. Go to [Linear → Settings → API](https://linear.app/settings/api) (you must be logged in).
2. Under **Personal API keys**, click **Create key**, give it a name (e.g. `code-linear-tickets`), and copy the generated key — it is only shown once.
3. Paste it as `LINEAR_API_KEY` in your `.env` file.

> **Scope:** Personal API keys inherit the permissions of the user who created them. The key needs to be able to read teams/labels/members and create issues. No extra configuration is required beyond generating the key.

**Relevant Linear documentation:**
- [Authentication overview](https://developers.linear.app/docs/graphql/working-with-the-graphql-api#authentication) — personal keys vs. OAuth
- [API keys settings page](https://linear.app/settings/api) — where keys are created and revoked
- [Linear GraphQL API reference](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) — full API docs (used internally by `@linear/sdk`)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your credentials
cp .env.example .env
# Edit .env: set LINEAR_API_KEY (from steps above) and LINEAR_TEAM (e.g. ENG)
```

## Usage

```bash
# Scan the current directory and create tickets
npm start

# Scan a specific directory
npm start -- --dir ./src

# Target a specific team
npm start -- --dir ./src --team INFRA

# Preview what would be created without hitting the API
npm start -- --dry-run

# List all annotated snippets found
npm start -- list --dir ./src

# Show filed vs. pending status
npm start -- status --dir ./src
```

## Metadata reference

| Key        | Required | Values                                        |
|------------|----------|-----------------------------------------------|
| `id`       | no*      | A stable slug, e.g. `auth-redirect-fix` — see below |
| `title`    | yes      | Any string                                    |
| `priority` | no       | `urgent`, `high`, `medium`, `low`, `no_priority` (default) |
| `labels`   | no       | Comma-separated label names, e.g. `bug, auth` |
| `assignee` | no       | Email address of a Linear workspace member    |
| `team`     | no       | Team key (e.g. `ENG`) — overrides `--team` flag |

## Updating issues

When you edit code inside a snippet that has already been filed, the tool's behaviour depends on whether the snippet has an `id` field:

| Has `id`? | Code changed? | Result |
|-----------|--------------|--------|
| Yes       | Yes          | Existing Linear issue is **updated** in place |
| Yes       | No           | Skipped (up to date) |
| No        | Yes          | New ticket is **created** (old entry becomes orphaned) |
| No        | No           | Skipped (up to date) |

**Recommendation:** always add `// id: <slug>` to your snippets. The slug can be anything unique and URL-safe (e.g. `auth-redirect-fix`, `user-form-refactor`). This is the only stable anchor the tool has to recognise a snippet across edits.

## Idempotency

A `.linear-tickets.json` lockfile is written to the scanned directory after each run. Each entry stores a content hash of the snippet; on subsequent runs the tool compares the current hash against the stored one to decide whether to skip or update.

Add `.linear-tickets.json` to your `.gitignore` if you don't want to commit it, or commit it to share filed state across your team.

## Supported file types

`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`
