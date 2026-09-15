# Issue tracker: GitHub

Repository: aws-samples/sample-cloudops-agent-amazon-bedrock-agentcore

Issues and specs live in GitHub Issues. Use the gh CLI from this clone,
or explicitly pass --repo aws-samples/sample-cloudops-agent-amazon-bedrock-agentcore.

## Conventions

- Search existing open and closed issues before creating a duplicate.
- Create: gh issue create --title "..." --body-file -
  Supply multiline bodies through a heredoc.
- Read: gh issue view <number> --comments
- List: gh issue list --state open --json number,title,body,labels
- Comment: gh issue comment <number> --body "..."
- Label: gh issue edit <number> --add-label "..." / --remove-label "..."
- Close: gh issue close <number> --comment "..."

"Publish to the issue tracker" means create a GitHub issue.
"Fetch the relevant ticket" means read the issue and its comments.

## Deployment testing

Deploy the repository unchanged. Report confirmed blockers with the tested
revision, reproduction steps, expected behavior, and actual results.
Distinguish observed deployment failures from local reproductions.
Redact credentials and private account data. Make source fixes only when
explicitly requested.

## Pull requests as a triage surface

PRs as a request surface: no.
