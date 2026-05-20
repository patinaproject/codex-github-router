export const GITHUB_WEBHOOK_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"] as const;

export function isAllowedGitHubEvent(event: string): boolean {
  return (GITHUB_WEBHOOK_EVENTS as readonly string[]).includes(event);
}
