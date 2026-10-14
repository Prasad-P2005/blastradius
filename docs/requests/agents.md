# Requests from the agents workstream

## 1. `parseDotenv` keeps inline comments after an empty value
- **To:** lead (`packages/shared/src/env.ts`)
- **What:** `.env.example` has lines like `WEBHOOK_URL=                      # Slack or Discord incoming webhook`. `parseDotenv` strips leading whitespace with `\s*` in the regex, so the value becomes `# Slack or Discord incoming webhook` (the `\s+#` comment rule then has no whitespace to match). Same for `GITHUB_SANDBOX_REPO`. Suggested fix: after taking the unquoted value, `value = value.replace(/(^|\s+)#.*$/, "").trim()`.
- **Why:** the actions step tried to POST to the URL `# Slack or Discord…`. Agents now defend against it (`envVal()` in `packages/agents/src/actions.ts` ignores values starting with `#`, and URLs/repos are validated), but every other consumer of `.env` gets the bad value.
- **Status:** open

## 2. Two scenario expectations differ from what the scripted agents name
- **To:** data (`data/scenarios.json`)
- **What:** `pnpm --filter @blastradius/agents scenarios` runs every scenario. All 11 meet the SPEC §10 bar (expected items are in the tools' top 3), but in two the agent's *finding* names a different item:
  - `acme-payment-failures`: the cause finding names **PR:4059** ("chore: regenerate lock files - fix vulns", newest human PR touching payment directly); `expected.suspectPr` is PR:3869 (#2 in `suspect_changes`). PR:4059 is also checkout's expected suspect.
  - `acme-cart-errors`: the precedent finding names **INC-2026-040** (newest on cart *and* the closest by vector similarity, 0.44 vs 0.38); `expected.pastIncident` is INC-2026-031 (#2).
- **Why:** the presenter will read the finding text. Either update `expected` (and presenter notes) to the items above, or adjust the data so the intended item ranks first. The agents deliberately name the #1 row; no scenario-specific logic in code.
- **Status:** open
