# codex-github-router

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

The default mode starts a local listener and a managed ngrok tunnel.
Pull request comments and reviews are routed to the local Codex session whose
GitHub repository and PR head branch match the incoming activity.

Delivery can run in three modes:

- `background`: starts a stdio Codex app-server turn. This preserves the
  previous durable delivery behavior, but it does not prove that an already-open
  Desktop chat will live-refresh.
- `live`: connects through the Codex app-server proxy and requires the target
  thread to already be loaded before starting the turn. If the live app-server
  cannot prove ownership of the thread, delivery fails closed.
- `auto`: tries live delivery first, then downgrades to background delivery with
  an explicit warning when live-thread proof is unavailable.

Select a mode with `CODEX_GITHUB_ROUTER_DELIVERY_MODE=live`, `background`, or
`auto`. When no mode is set, the router uses `background` for compatibility.
Live mode always uses the Codex app-server proxy. Set
`CODEX_APP_SERVER_CONTROL_SOCKET` when you have a known control socket.
Transient Desktop socket paths are only useful when they answer the app-server
protocol and prove the target thread is loaded.

While the foreground router is attached to an interactive terminal, it exposes
small runtime commands:

```text
[R] Reload webhooks  [S] Show settings  [Q] Quit
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
  state, selected Codex app-server binary, Desktop process status, daemon help
  availability, candidate control sockets, and target-thread readiness hints.
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
