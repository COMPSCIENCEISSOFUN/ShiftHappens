# Allocation Flow

ShiftHappens separates eligibility from ranking. Ranking can change the order of candidates, but it cannot admit a candidate rejected by eligibility.

## Processing Order

1. Resolve the task and organization.
2. Evaluate every active Staff membership with the deterministic eligibility service.
3. Remove ineligible and explicitly excluded memberships.
4. Build ranking attributes for the remaining candidates.
5. Load and normalize the organization's ranking priorities.
6. Ask the configured AI provider to rank the eligible candidates, with provider failover.
7. Use the weighted deterministic ranker when an AI key, request, or response is unavailable.
8. Remove invented and duplicate membership IDs from provider output.
9. Perform final eligibility and headcount validation when assignments are committed.

## Ranking Priorities

| Factor | Default | Meaning |
| --- | ---: | --- |
| Workload balance | 30% | More remaining daily hours produces a higher factor score. |
| Availability fit | 25% | A recorded availability schedule produces a higher factor score. |
| Certification breadth | 25% | More verified certifications produces a higher factor score. |
| Department experience | 20% | More prior assignments in the task's department produces a higher factor score. |

Each configured value must be an integer from `0` through `100`, and at least one factor must be positive. The values are normalized to integer percentages totaling `100` before storage and use. Missing or malformed legacy configuration uses the defaults above.

The deterministic score is the sum of each active factor score multiplied by its normalized percentage. Explanations show only factors whose configured percentage is above zero.

## AI Boundary

Groq and Gemini receive the same normalized factor percentages and only the server-filtered eligible candidate list. AI output is advisory: unknown and duplicate membership IDs are removed, and final assignment creation rechecks eligibility. Provider failures and malformed responses use the same weighted deterministic ranking rather than a separate ordering rule.
