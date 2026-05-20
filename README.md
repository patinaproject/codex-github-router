# codex-github-router

Routes GitHub events to Codex.

## Repository Baseline

This repository follows the Patina Project baseline for commit conventions,
pull request hygiene, markdown linting, and GitHub Actions pinning.

## Local Setup

```sh
pnpm install
```

## Verification

```sh
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

## License

See [LICENSE](./LICENSE).
