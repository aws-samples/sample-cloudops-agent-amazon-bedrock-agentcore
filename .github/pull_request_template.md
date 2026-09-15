<!-- Adapted from BerriAI/litellm:
https://github.com/BerriAI/litellm/blob/939d320246d5598d4312dd277b066af3984296ae/.github/pull_request_template.md
Write for human reviewers: plain language, short sentences, concrete evidence.
Remove optional sections that do not apply. Redact credentials and private account data.
-->

## TLDR

Problem this solves:

- <!-- State the problem. -->

How it solves it:

- <!-- Summarize the approach. -->

## User Flow

<!-- Read the linked issue first. Describe the same task from the user's or
operator's perspective. Keep steps identical until behavior diverges.
Name actual commands, routes, or visible results rather than implementation details.
For authorization changes, show what each role can or cannot do.
For changes with no user-visible effect, say so and explain why.
-->

### Before

1. <!-- User action and observed result. -->

### After

1. <!-- Same action and changed result. -->

## Relevant issues

<!-- Fixes #123 or Refs #123. -->

## Affected release

<!-- Regression fixes only: identify the first affected release or commit, if known. -->

## Pre-Submission checklist

- [ ] This PR solves one specific problem with minimal scope.
- [ ] Relevant tests pass; new behavior and regressions have meaningful coverage, or an explanation of why tests do not apply.
- [ ] Required CI checks pass, or unavailable checks are identified.
- [ ] Documentation reflects changed behavior or setup requirements.
- [ ] Deployment evidence identifies the tested revision, region, and prerequisites without exposing secrets.

## Screenshots / Proof of Fix

<!-- Show the latest evidence: Before at the merge base, After at the current PR tip.
Use the same cases in the same order, with numbered commands/actions and observed results.
For bug fixes, reproduce the failure before and repeat the same steps after.
For features, show the capability missing before and working after.
Include before/after screenshots for UI changes.
Distinguish unit/mocked checks from live end-to-end verification; tests alone do not prove deployment success.
Use only authorized AWS environments for live checks. If not run, state that and why.
Put shared setup above Before. Use subheadings for multiple cases.
-->

### Before (<commit>)

1. <!-- Command or action, followed by actual output. -->

### After (<commit>)

1. <!-- Same command or action, followed by actual output. -->

## Type

<!-- Keep only the applicable types. -->

- New feature
- Bug fix
- Refactoring
- Documentation
- Infrastructure
- Test

## Caveats (if any)

<!-- Keep only applicable severity headings and use short bullets:
Severe: intentional rollout impact, data migration, breaking behavior, or authorization changes.
High: unresolved correctness, security, data-loss, or compatibility defects unsafe to ship.
Medium: a known gap with a workaround or limited impact.
Low: minor follow-ups or limitations.
Include untested assumptions and what happens if they are wrong.
-->

## QA runbook

<!-- Only for added or changed end-to-end tests. For each test, name its test ID
and what it proves, then list manual actions and exact expected results.
Include environment prerequisites and cleanup steps for test resources.
-->

## Final Attestation

- [ ] The evidence matches the current PR revision; limitations, skipped checks, and known risks are disclosed.
