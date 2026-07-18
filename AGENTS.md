# Repository Guidelines

This repository routes GitHub events to Codex.

## Project Structure

- `README.md`: human-facing project overview.
- `docs/`: contributor and operational references.
- `.github/workflows/`: pull request, markdown, and workflow lint checks.
- `.github/pull_request_template.md`: required PR body structure.
- `.claude/settings.json`: local Claude Code plugin configuration.
- `.agents/skills/<name>/`, `.claude/skills/<name>`: committed skill overlays.
- `skills-lock.json`: project-local skill catalog and upstream source paths.
- `package.json`: repository tooling for commitlint, commitizen, husky, and markdownlint.

## Commands

- `pnpm install`: install tooling and wire Husky hooks.
- `pnpm skills:update`: refresh every valid locked skill from its upstream
  default branch and update `skills-lock.json`.
- `pnpm skills:restore`: regenerate the committed `.agents/skills/**` and
  `.claude/skills/**` overlays from `skills-lock.json`.
- `pnpm test`: run the router tests and pull request body contract test.
- `pnpm lint:md`: lint Markdown files.
- `pnpm exec commitlint --edit <commit-message-file>`: validate one commit message.
- `pnpm commit`: open the commitizen prompt for a convention-compliant commit.

## Conventions

- Keep Markdown ASCII-only unless the file already requires otherwise.
- Keep workflow actions pinned to full 40-character SHAs with a comment naming
  the human-readable action tag above each `uses:` line.
- Use `gh label list` and the repository label descriptions as the source of
  truth before applying issue or PR labels.
- Store durable product, design, and implementation context in GitHub issues
  and pull requests, not in throwaway local planning files.
- Keep `skills-lock.json`, `.agents/skills/**`, and `.claude/skills/**` in sync.
  For catalog maintenance, run `pnpm skills:update`, resolve any retired names,
  then run `pnpm skills:restore` and commit the regenerated overlays.

## Commit Type Selection

Start from the files touched, then choose the type that matches the user-visible
surface of the change before falling back to the implementation mechanism.

Product-surface path guide:

- `.github/workflows/**`, `.github/actionlint.yaml`: `ci`
- `.husky/**`, `commitlint.config.js`, `commitizen.config.json`: `chore`
- `docs/**`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`: `docs`
- `package.json`, `pnpm-lock.yaml`, `.nvmrc`: `build`
- Formatting-only changes: `style`
- Tests or test harnesses: `test`

| Type | Use when |
|---|---|
| `feat` | Adds user-visible behavior or capability |
| `fix` | Corrects broken behavior |
| `docs` | Changes documentation only |
| `chore` | Updates repo plumbing, hooks, or maintenance conventions |
| `style` | Changes formatting without behavior changes |
| `refactor` | Restructures code without changing behavior |
| `perf` | Improves performance |
| `test` | Adds or changes tests |
| `build` | Changes package, dependency, or runtime setup |
| `ci` | Changes CI workflows or automation |
| `revert` | Reverts a prior commit |

Rationalization examples:

| Change | Type | Why |
|---|---|---|
| Update `.github/workflows/pull-request.yml` | `ci` | The CI surface changed |
| Add a section to `README.md` | `docs` | Documentation only |
| Bump markdownlint tooling in `package.json` | `build` | Dependency setup changed |
| Change Husky commit hook behavior | `chore` | Repository workflow plumbing changed |

STOP before committing when:

- The message lacks a GitHub issue reference.
- The subject is longer than 72 characters.
- The title uses a scope such as `feat(api):`.
- A breaking change marker `!` lacks a `BREAKING CHANGE:` footer, or the footer
  exists without `!` in the title.

WRONG -> RIGHT:

- `feat: add router` -> `feat: #123 add GitHub event router`
- `fix(router): #123 handle retries` -> `fix: #123 handle router retries`
- `docs: #123 Update README` -> `docs: #123 update README`

## Commits

Use Conventional Commits with no scope:

```text
type: #123 short description
```

Allowed types are `feat`, `fix`, `docs`, `chore`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, and `revert`. The subject must begin with a GitHub issue
reference and stay within 72 characters.

## Pull Requests

- Use the same format for PR titles as commit messages so squash merges can
  reuse the title directly.
- Include one `Closes #123`, `Fixes #123`, or `Resolves #123` line for each
  issue the PR completes. Add non-closing references only as extra context.
- Fill out `What changed` for a human who has not seen the work: explain what
  changed and why by purpose, not file by file.
- Add `Testing steps` only for behavior changes with useful outcome evidence.
  Each item must pair an action already performed with the result actually
  observed; never write aspirational checks or mobile/web platform QA matrices.
  Omit the section when it adds no reviewer value.
