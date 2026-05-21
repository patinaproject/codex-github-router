#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$repo_root/.github/workflows/pull-request.yml"
check_script=$(mktemp)
trap 'rm -f "$check_script"' EXIT

awk '
  $0 == "      - name: Check for linked issue in PR body" { in_step = 1; next }
  in_step && $0 == "      - name: Compare title `!` with breaking-change markers" { exit }
  in_step && /^        run: \|$/ { in_run = 1; next }
  in_run {
    sub(/^          /, "")
    print
  }
' "$workflow" > "$check_script"

if [ ! -s "$check_script" ]; then
  printf 'not ok - failed to extract PR body check from workflow\n'
  exit 1
fi

pass() {
  local name=$1
  local body=$2

  if ! output=$(PR_BODY=$body bash "$check_script" 2>&1); then
    printf 'not ok - %s\n%s\n' "$name" "$output"
    exit 1
  fi
}

fail() {
  local name=$1
  local body=$2

  if output=$(PR_BODY=$body bash "$check_script" 2>&1); then
    printf 'not ok - %s\nexpected failure, got success:\n%s\n' "$name" "$output"
    exit 1
  fi
}

pass "closing keyword" "Closes #1"
pass "closing keyword with colon" "Fixes: #12"
pass "cross-repository closing keyword" "Resolves patinaproject/codex-github-router#123"
pass "related issue link" "Related to #1"
pass "blocks issue link" "Blocks #2"
pass "partially satisfies issue link" "Partially satisfies #3"
pass "nested list issue link" $'- Parent\n    - Related to #1'

fail "empty body" ""
fail "bare issue reference" "#1"
fail "inline code is ignored" 'This mentions `Related to #1` only in inline code.'
fail "double backtick inline code is ignored" 'This mentions ``Related to #1`` only in inline code.'
fail "fenced code is ignored" $'```\nCloses #1\n```'
fail "tilde fenced code is ignored" $'~~~\nRelated to #1\n~~~'
fail "mixed fences stay inside opening fence" $'~~~\n```\nRelated to #1\n~~~'
fail "long backtick fence ignores shorter inner fence" $'````\n```\nRelated to #1\n````'
fail "long tilde fence ignores shorter inner fence" $'~~~~\n~~~\nRelated to #1\n~~~~'
fail "fence closer with text stays inside fence" $'~~~\n~~~ not closing\nRelated to #1\n~~~'
fail "fence closer indented four spaces stays inside fence" $'```\n    ```\nRelated to #1\n```'
pass "HTML comment markers inside fence do not remove valid link" $'```\n<!--\n```\nRelated to #1\n-->'
fail "indented code is ignored" "    Related to #1"
fail "blockquote is ignored" "> Related to #1"
fail "lazy blockquote continuation is ignored" $'> context\nRelated to #1'
fail "strikethrough is ignored" "~~Related to #1~~"
fail "HTML comment is ignored" "<!-- Related to #1 -->"
fail "multiline HTML comment is ignored" $'<!--\nRelated to #1\n-->'
fail "multiline inline code is ignored" $'`\nRelated to #1\n`'
fail "multiline double backtick inline code is ignored" $'``\nRelated to #1\n``'
fail "undocumented relates phrase is ignored" "Relates to #1"
fail "undocumented blocked by phrase is ignored" "Blocked by #1"
fail "undocumented satisfy phrase is ignored" "Partially satisfy #1"

printf 'ok - PR body issue link checks passed\n'
