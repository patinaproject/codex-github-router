# codex-github-router

```text
               C Y B E R P U N K    E V E N T    R O U T I N G    A C T I O N
                  __                   _ __  __          __                        __
  _________  ____/ /__  _  __   ____ _(_) /_/ /_  __  __/ /_     _________  __  __/ /____  _____
 / ___/ __ \/ __  / _ \| |/_/  / __ `/ / __/ __ \/ / / / __ \   / ___/ __ \/ / / / __/ _ \/ ___/
/ /__/ /_/ / /_/ /  __/>  <   / /_/ / / /_/ / / / /_/ / /_/ /  / /  / /_/ / /_/ / /_/  __/ /
\___/\____/\__,_/\___/_/|_|   \__, /_/\__/_/ /_/\__,_/_.___/  /_/   \____/\__,_/\__/\___/_/
                             /____/
```

Routes GitHub events to Codex.

## Why This Exists

I wanted my GitHub PR activity to talk directly to my Codex Desktop sessions.
My workflow already turns Q&A into issues, issues into worktrees, and worktrees
into PRs, but too much time still went into babysitting agents: telling the
right session when I left review feedback, created a code review, or needed a
branch updated.

I could not find a small tool for that loop, so I made one. The goal is simple:
spend more time reviewing and testing code, and less time manually relaying
messages between GitHub and local Codex worktrees.

For PR activity, the router is meant to preserve the working context: it matches
the GitHub repository and pull request head branch to the local Codex session
for that branch, then delivers the comment or review into that session.

## Usage

Run the router as a foreground CLI:

```sh
npx codex-github-router
```

```text
codex-github-router ready
local  http://127.0.0.1:3000/webhooks/github
public https://router.example.com/webhooks/github
hook   https://github.com/organizations/patinaproject/settings/hooks/123

[R] Reload webhooks  [S] Settings  [Q] Quit
```

The default mode starts a local listener and a managed ngrok tunnel.
Pull request comments and reviews are routed to the local Codex session whose
GitHub repository and PR head branch match the incoming activity.

Delivery uses one path: the router starts `codex app-server --listen stdio://`,
initializes the app-server protocol, resumes the target thread, starts a turn,
and waits for `turn/completed`. Codex Desktop picks up the new chat activity
from the same local Codex session store that this stdio app-server writes.

While the foreground router is attached to an interactive terminal, it exposes
small runtime commands:

```text
[R] Reload webhooks  [S] Settings  [Q] Quit
```

Runtime output never prints webhook secrets.

## Repository Baseline

This repository follows the Patina Project baseline for commit conventions,
pull request hygiene, markdown linting, and GitHub Actions pinning.

## Local Setup

```sh
pnpm install
pnpm build
```

## Verification

```sh
pnpm typecheck
pnpm test
pnpm lint:md
pnpm exec commitlint --help
```

## Commit Convention

Commits and pull request titles use Conventional Commits with a required GitHub
issue reference:

```text
type: #123 short description
```

See [AGENTS.md](./AGENTS.md) for the full contributor workflow.

## Advanced Options

Use an existing public HTTPS tunnel:

```sh
codex-github-router --url https://router.example.com
```

Replay local webhook requests without touching GitHub webhook settings:

```sh
codex-github-router --localhost
```

Clear remembered local settings and cache:

```sh
codex-github-router --clear
```

## Agent Commands

The CLI also exposes JSON commands intended for Codex and automation:

```sh
codex-github-router --json doctor
codex-github-router --json settings show
codex-github-router --json webhooks reload
codex-github-router --json request get /user
```

- `doctor` checks local prerequisites, GitHub CLI auth, config paths, setup
  state, and the selected stdio Codex app-server command.
- `settings show` prints sanitized local router settings.
- `webhooks reload` re-reads remembered settings and reports whether reload can
  run with the current setup.
- `request get` is a read-only GitHub API escape hatch through `gh api`.

With `--json`, successful commands emit a stable object with `ok: true`.
Failures emit `ok: false` and an `error` object containing a machine-readable
`code` and human-readable `message`. Diagnostics and progress belong on stderr;
JSON output belongs on stdout. Tokens, webhook secrets, signatures, cookies, and
raw authorization values must not appear in JSON output.

## License

See [LICENSE](./LICENSE).
