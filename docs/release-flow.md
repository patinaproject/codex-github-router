# Release Flow

This repository is scaffolded with release-friendly conventions even before a
dedicated release workflow exists.

## Commit Inputs

Release automation expects squash commits to use the PR title. Keep PR titles in
the same format as commit messages:

```text
type: #123 short description
```

Use `feat` for minor releases, `fix` for patch releases, and `type!` plus a
`BREAKING CHANGE:` footer for major releases if release automation is added.

## Repository Settings

The expected merge settings are:

| Setting | Expected value |
|---|---|
| Allow squash merging | Enabled |
| Allow merge commits | Disabled |
| Allow rebase merging | Disabled |
| Default squash title | Pull request title |
| Default squash message | Pull request title and commit details |
| Automatically delete head branches | Enabled |
| Always suggest updating pull request branches | Enabled |
| Release immutability | Enabled |

## First Release

When this repository grows a packaged artifact, add release automation that reads
Conventional Commits from squash-merged PRs and updates `CHANGELOG.md`.
