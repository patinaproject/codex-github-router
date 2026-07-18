#!/usr/bin/env bash
# install-third-party-skills.sh
#
# Restore the third-party vendored skills recorded in `skills-lock.json`.
# Run on demand via `pnpm skills:restore`. Re-runs reconcile the committed
# overlays with the upstream paths recorded in the lock.

set -euo pipefail

# Skip if CI explicitly opts out (e.g., when only running unrelated jobs).
if [ "${PATINA_SKIP_SKILL_INSTALL:-0}" = "1" ]; then
  echo "install-third-party-skills: PATINA_SKIP_SKILL_INSTALL=1, skipping"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f skills-lock.json ]; then
  echo "install-third-party-skills: no skills-lock.json, nothing to do"
  exit 0
fi

echo "install-third-party-skills: restoring vendored skills from skills-lock.json..."
npx --yes skills@latest experimental_install --yes
echo "install-third-party-skills: done"
