---
name: review-ticket
description: Run a fresh, independent Codex Reviewer on a built ticket and return CLEAR or BOUNCE. Use for the review stage only.
---

Resolve the ticket, `docs/plans/<ticket-id>.md`, and diff reference; default to `ticket/<ticket-id>`.

If the current thread contains the Builder's implementation conversation rather than artifact-only orchestration, stop and ask for a fresh Codex chat. Otherwise spawn a new project custom agent named `reviewer`. Pass only the ticket path, plan path, and diff reference. Never pass the Builder transcript or self-assessment.

Relay the verdict verbatim. Do not fix findings, merge on CLEAR, or silently convert uncertainty into CLEAR.

