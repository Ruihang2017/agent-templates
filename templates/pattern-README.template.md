# Pattern: <Human-Readable Pattern Name>

<!-- Copy this file to patterns/<kebab-name>/README.md and fill EVERY section.
     Format reference: patterns/three-agent-architect-builder-reviewer/README.md
     Rules: CLAUDE.md "Grounding rules" — every model/effort claim carries a source label;
     no training-data impressions; as-of date moves with every recommendation change. -->

| Field | Value |
|---|---|
| **Pattern name** | `<kebab-name>` (= directory name) |
| **Status** | `proposed` <!-- proposed → trialed → adopted → deprecated --> |
| **As-of date** | YYYY-MM-DD |
| **Expiry trigger** | First successor release to any listed model, or YYYY-MM-DD (+6 months), whichever comes first |
| **Sign-off** | <name, role, date> |

<One- or two-sentence summary of the agent topology: who does what, in what order.>

## 1. When to use / when not to use

**Use when:**
- <concrete task shape>

**Do not use when:**
- <concrete task shape — every pattern has a floor below which its overhead dominates>

## 2. Agent roles & boundaries

| Agent | Does | Never does |
|---|---|---|
| **<Role>** | <responsibility> | <hard boundary> |

<Who judges whom; which contexts must stay isolated; which boundaries are hard requirements vs tunable.>

## 3. Model + effort assignment (as of YYYY-MM-DD)

| Role | Model | Effort | Reasoning | Source labels |
|---|---|---|---|---|
| <Role> | <exact model name> | <effort level> | <why this model/effort for this role> | <`[official]` / `[vendor-benchmark]` / `[third-party]` / `[internal]` / `[unverified]` / `[team-policy]` + link or "link not captured — attach at first re-verification"> |

## 4. Known failure modes / pitfalls

| Pitfall | Context | Mitigation | Recorded |
|---|---|---|---|
| <symptom> | <the specific harness/project/conditions it was observed in — or "design constraint (not a measured incident)"> | <mitigation> | YYYY-MM-DD |
| Harness-specific failures for these exact model+effort combinations | **None recorded yet** (as of YYYY-MM-DD) | Record here with harness name, conditions, and date when observed | — |

## 5. Upstream / downstream integration

**Upstream (work intake):** <how work enters — master PRD → sub-PRD → ticket; which docs each agent reads; where ADRs come in.>

**Downstream (deliverables):** <what leaves — PR, verdict, docs; what gates a merge.>

**Human gates:** <where humans decide (e.g. the start signal), where they must NOT be needed, and the exception path that pulls a human back in.>

## 6. Scaffold

<List of files under scaffold/ and what each is for. Point to scaffold/INSTALL.md for install steps. Note the date the scaffold's config keys were last verified against Claude Code docs.>

## 7. Provenance & change log

| Date | Change | Basis | Author |
|---|---|---|---|
| YYYY-MM-DD | Initial entry | <source record / doc links> | <who> |
