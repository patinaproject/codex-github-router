export const GITHUB_WEBHOOK_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"] as const;
const ALLOWED_INCOMING_EVENTS = ["ping", ...GITHUB_WEBHOOK_EVENTS] as const;

export function isAllowedGitHubEvent(event: string): boolean {
  return (ALLOWED_INCOMING_EVENTS as readonly string[]).includes(event);
}
