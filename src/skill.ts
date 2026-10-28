import { DESCRIPTION } from "./cli.js";

export const SKILL_DESCRIPTION =
  "Use the bitbucket-axi CLI to inspect Bitbucket Cloud repositories, pull requests, and pipelines, call raw API endpoints, manage keychain credentials, or configure its optional Git HTTPS credential helper. Use whenever a task involves Bitbucket Cloud repository state or API operations.";

export const SKILL_AUTHOR = "Kit Chan";

const HERMES_TAGS = ["bitbucket", "repositories", "pull-requests", "pipelines"];
const HERMES_CATEGORY = "developer-tools";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

export function createSkillMarkdown(): string {
  return `---
name: bitbucket-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# bitbucket-axi

${DESCRIPTION}

## When to use

Use bitbucket-axi whenever a task needs Bitbucket Cloud repository details, pull requests, pipeline runs, raw API access, or credential setup for those operations. It also provides an opt-in Git HTTPS credential helper; SSH remains the default Git transport.

Get every command, flag, and workflow from the live CLI - it is the single source of truth:

- \`npx -y bitbucket-axi\` - dashboard for the current repository
- \`npx -y bitbucket-axi --help\` - global usage
- \`npx -y bitbucket-axi <command> --help\` - per-command usage

API credentials are stored in the OS credential manager. If the CLI reports that credentials are missing, run \`npx -y bitbucket-axi config set\`; for automation, provide the account email and pipe the token to \`npx -y bitbucket-axi config set --email <email> --token-stdin\`. If it instead reports that the login keychain is locked, the stored credential is intact and must not be re-entered - the user has to unlock the keychain in their own terminal with \`security unlock-keychain ~/Library/Keychains/login.keychain-db\` (no \`-p\`/\`-u\`).

## Images in pull request descriptions

Bitbucket Cloud's public REST API cannot attach images to a pull request (BCLOUD-23909 is still open). Descriptions are Markdown, so host the image in the repository's Downloads and reference that URL:

1. \`npx -y bitbucket-axi api POST /repositories/{workspace}/{repo}/downloads --file files=./screenshot.png\` - form field \`files\`, needs \`write:repository:bitbucket\`. Use a name unique to the pull request and revision; a repeated name replaces its bytes. The upload reply has no body, so read \`http_status: 201\` beside the empty \`api_response\` as success.
2. An upload never edits the PR. Read the latest body with \`npx -y bitbucket-axi pr view <id> --full\`, append \`![caption](https://bitbucket.org/<workspace>/<repo>/downloads/<name>)\`, and write the whole body back with \`npx -y bitbucket-axi api PUT /repositories/{workspace}/{repo}/pullrequests/<id> --field description="$(cat body.md)"\`. Reference the \`bitbucket.org\` URL only; a Downloads request redirects to an expiring signed storage URL.
3. Verify in that order: the saved description and its \`rendered.description.html\` carry one \`<img>\` per reference, then a browser signed in with repository read access displays the images. Bytes on the server and \`<img>\` tags in API HTML do not prove a viewer sees them, and the API token is not that browser session.

Downloads outlive the PR that references them, so delete one only after nothing needs it. Viewers of a private repository need read access; anonymous requests get 401.
`;
}
