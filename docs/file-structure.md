# File Structure

This repository currently contains the Patina Project baseline scaffolding for
repository hygiene and automation.

```text
.
├── .claude/
│   └── settings.json
├── .github/
│   ├── workflows/
│   │   ├── actions.yml
│   │   ├── markdown.yml
│   │   └── pull-request.yml
│   ├── CODEOWNERS
│   ├── actionlint.yaml
│   └── pull_request_template.md
├── .husky/
│   ├── commit-msg
│   └── pre-commit
├── docs/
│   ├── file-structure.md
│   ├── release-flow.md
│   └── wiki-index.md
├── AGENTS.md
├── CLAUDE.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md
├── commitizen.config.json
├── commitlint.config.js
├── package.json
└── pnpm-lock.yaml
```

## Tooling Files

| Path | Purpose |
|---|---|
| `commitlint.config.js` | Enforces conventional commits with `#<issue>` subjects |
| `commitizen.config.json` | Drives the `pnpm commit` prompt |
| `.husky/commit-msg` | Runs commitlint for local commits |
| `.husky/pre-commit` | Runs lint-staged before commits |
| `.markdownlint.jsonc` | Markdownlint configuration |
| `.markdownlintignore` | Markdownlint exclusions |

## Agent Guidance

`AGENTS.md` is the source of truth for agent-facing workflow rules. `CLAUDE.md`
imports it for Claude Code.
