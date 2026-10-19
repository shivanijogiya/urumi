# ADR 000 — Phase 1 planning decisions

Status: Accepted (Aadi, 20 Oct 2026: "Plan approved")

## Context
`docs/PLAN.md` §8 listed nine open questions with recommendations. Aadi approved the plan as written.

## Decisions
| Q | Decision |
|---|---|
| Q1 | Infra track (#2–#5) runs while contracts #6 waits for G1 |
| Q2 | D1–D8 checkpoint moves to 24 Oct 18:00; VPS #25 cut unless checkpoint lands by 24 Oct 12:00 |
| Q3 | Secret Detection, SAST and IaC scan jobs land in #2 (not #22) |
| Q4 | Third upstream = GitLab MCP with a dedicated fine-grained PAT (MCP tool: Execute); fallback DeepWiki no-auth |
| Q5 | Dashboard login = email + password (scrypt), admin-created members, admin seeded from a Secret |
| Q6 | External MCP endpoint = `POST /mcp`, stateless Streamable HTTP, Bearer key checked per request |
| Q7 | Chat model = Claude Sonnet (latest) |
| Q8 | GitHub copy via GitLab push-mirror to a public GitHub repo, set up 26 Oct |
| Q9 | Canary (#23) runs on ephemeral k3d inside CI; fallback a project runner on the Mac |

## Alternatives
Recorded per question in `docs/PLAN.md` §8.

## Consequences
Q5 and Q6 are fixed in the #6 contracts MR (G1). Q4 and Q7 need Aadi to supply `GITLAB_MCP_TOKEN` and `ANTHROPIC_API_KEY` in `.env.local` by 23 Oct.
