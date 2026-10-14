# Requests from the agents workstream

## 1. `parseDotenv` keeps inline comments after an empty value
- **To:** lead (`packages/shared/src/env.ts`)
- **What:** `.env.example` has lines like `WEBHOOK_URL=                      # Slack or Discord incoming webhook`. `parseDotenv` strips leading whitespace with `\s*` in the regex, so the value becomes `# Slack or Discord incoming webhook` (the `\s+#` comment rule then has no whitespace to match). Same for `GITHUB_SANDBOX_REPO`. Suggested fix: after taking the unquoted value, `value = value.replace(/(^|\s+)#.*$/, "").trim()`.
- **Why:** the actions step tried to POST to the URL `# Slack or Discord…`. Agents now defend against it (`envVal()` in `packages/agents/src/actions.ts` ignores values starting with `#`, and URLs/repos are validated), but every other consumer of `.env` gets the bad value.
- **Status:** open
