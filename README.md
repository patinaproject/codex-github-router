# codex-github-router

Routes GitHub events to Codex.

## Usage

Run the router as a foreground CLI:

```sh
npx codex-github-router
```

The default mode starts a local listener and a managed ngrok tunnel.

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

- `doctor` checks local prerequisites, GitHub CLI auth, config paths, and setup
  state.
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
