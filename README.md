# bitbucket-axi

Agent-facing Bitbucket Cloud CLI with compact [TOON](https://toonformat.dev/) output, strict validation, explicit empty states, and useful next-command hints.

## Install

Requires Node.js 20 or newer.

```sh
npm install -g bitbucket-axi
# From a checkout:
npm install -g .
```

## Authenticate

`bitbucket-axi` stores your Bitbucket Cloud API token in your operating system credential manager (macOS Keychain, Windows Credential Manager, or libsecret on Linux). It never writes the token to a plaintext file and never accepts it as a command-line argument.

Create a [Bitbucket Cloud API token](https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/) with the `read:user:bitbucket` scope (used once by `config set` to verify the token belongs to your account) plus the repository, pull request, and pipeline scopes your commands need. Then run the interactive setup:

```sh
bitbucket-axi config set
```

Use the **Atlassian account email** that owns the token (not your Bitbucket username). You can supply it up front with `bitbucket-axi config set --email you@example.com`. The API token is prompted for without echo, validated against Bitbucket's current-user endpoint, and only then written to the keychain.

For non-interactive automation, pipe the token from your secret manager. The email remains explicit, and `--token-stdin` prevents prompting:

```sh
token-producing-command | bitbucket-axi config set --email you@example.com --token-stdin
```

Verify setup at any time:

```sh
bitbucket-axi config status   # shows the configured email and readiness, never the token
bitbucket-axi config clear    # removes the stored credential (idempotent)
```

Every network-backed command requires a stored credential. If none is configured, the command makes no API call and returns an auth-required result pointing at `bitbucket-axi config set`.

If macOS reports `The login keychain is locked, so the stored credential cannot be read`, the token is still stored and must not be re-entered. Unlock the keychain yourself in the terminal you are using, which works over SSH because it reads the password there without echoing it:

```sh
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

Do not add `-p` (it exposes the password in the process list) or `-u` (it asks for a GUI prompt, which an SSH session cannot show).

## Select a repository

Pass `-R/--repo <workspace/repo>` after the command:

```sh
bitbucket-axi pr list -R acme/widgets
```

When omitted, `bitbucket-axi` scans git remotes for a `bitbucket.org` repository. Running with no arguments shows a compact dashboard for the selected repository.

## Commands

| Command | Purpose |
| --- | --- |
| `config set [--email <email>]` | Interactively validate and store API credentials in the OS keychain |
| `config status` | Show the configured email and credential readiness (a locked keychain is reported as such, not as missing) |
| `config clear` | Remove the stored credential |
| `config git set --token-stdin` | Validate and store a separate Git HTTPS token for the credential helper |
| `config git status` | Show whether the Git HTTPS token is configured |
| `config git clear` | Remove the stored Git HTTPS token |
| `credential-helper` | Git credential helper supplying stored HTTPS credentials (invoked by `git`) |
| `repo view` | Show repository details |
| `pr list` | List pull requests |
| `pr view <id>` | Show one pull request; use `--full` for complete text |
| `pr create` | Create a pull request |
| `pipeline list` | List pipeline runs |
| `pipeline view <uuid>` | Show one pipeline run |
| `pipeline run` | Trigger a branch or custom pipeline, with optional variables |
| `api [method] <path>` | Call any Bitbucket Cloud REST API v2.0 path; `--file` sends a multipart upload |

Run `bitbucket-axi --help` or `bitbucket-axi <command> --help` for the complete, concise flag reference.

## Git over HTTPS (optional)

The default Git transport is SSH. For HTTPS clones, `bitbucket-axi` can act as a Git credential helper using a separate token stored in the OS keychain (distinct from the API token, so a dedicated app password can be used).

```sh
token-producing-command | bitbucket-axi config git set --token-stdin
bitbucket-axi config git status   # shows configured, never the token
git config --global credential.helper 'bitbucket-axi credential-helper'
```

The Git token is validated against the same Bitbucket account as the API token (reusing the configured account email as the git username) before it is stored. The helper is read-only and only responds to `bitbucket.org` requests; `git credential store`/`erase` are ignored. Remove it with `bitbucket-axi config git clear`.

## Examples

```sh
bitbucket-axi repo view
bitbucket-axi pr list --state open --fields source,destination
bitbucket-axi pr view 42 --full
bitbucket-axi pr create --title "Fix auth" --source fix/auth --destination main --body "Resolves token refresh"
bitbucket-axi pipeline list --fields commit,url
bitbucket-axi pipeline run --branch main
bitbucket-axi pipeline run --branch main --custom "Deploy production"
bitbucket-axi pipeline run --branch main --custom "Deploy production" --variable STAGE=staging --secured-variable DEPLOY_TOKEN=...
bitbucket-axi api /repositories/{workspace}/{repo}/refs/branches
bitbucket-axi api POST /repositories/{workspace}/{repo}/pipelines --field 'target={"type":"pipeline_ref_target","ref_type":"branch","ref_name":"main"}'
```

List commands default to compact fields. Add supported columns with `--fields`. Long descriptions and raw API string values are truncated by default; pass `--full` when complete content is needed.

## Images in pull request descriptions

Bitbucket Cloud's public REST API cannot upload images to a pull request: attachments exist only on Bitbucket's internal PR activity endpoint, and the request to expose them is still open ([BCLOUD-23909](https://jira.atlassian.com/browse/BCLOUD-23909), *Gathering Interest*; fetching them is [BCLOUD-22105](https://jira.atlassian.com/browse/BCLOUD-22105)). PR descriptions are Markdown, so the supported route is to upload the file to the repository's [Downloads](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-downloads/) and reference that URL:

```sh
# 1. upload (multipart form field `files`; needs write:repository:bitbucket)
bitbucket-axi api POST /repositories/{workspace}/{repo}/downloads --file files=./screenshot.png

# 2. read the current description, add your section to it, write the whole body back
bitbucket-axi pr view 42 --full
bitbucket-axi api PUT /repositories/{workspace}/{repo}/pullrequests/42 --field description="$(cat body.md)"

# 3. read the saved description back
bitbucket-axi pr view 42 --full
```

with this line inside `body.md`:

```md
![screenshot](https://bitbucket.org/<workspace>/<repo>/downloads/screenshot.png)
```

An upload never edits a pull request: until step 2 writes a description that references the file, the PR shows no image. Take the body you patch from a fresh `pr view <id> --full` read - a read without `--full` truncates long descriptions, and someone else may have edited the body since your last look. `"$(cat body.md)"` arrives as a single argument, so quotes, backticks and `$` in the body stay literal.

`--file` sends `multipart/form-data` with the file's bytes unchanged. The form field must be `files` for downloads, and a `GET`/`HEAD` request cannot carry files. Uploading a name that already exists replaces its bytes in place, so give every image a name unique to its pull request and revision. Reference the stable `https://bitbucket.org/...` URL: a Downloads request answers `302` to a short-lived signed storage URL, which must never end up in the Markdown.

Verifying an image is three claims, and each one needs its own evidence:

1. The file is uploaded and its bytes are what you sent. The upload replies with no body, so the CLI prints `http_status: 201` beside an empty `api_response`; a null body is not a failed write. Download the file and compare a checksum to prove the bytes. The CLI prints text, so it has no byte download of its own; use a client that follows the redirect without handing your API token to that storage host.
2. The saved description contains the references you meant - `pr view <id> --full` for the text, and `rendered.description.html` from `bitbucket-axi api GET /repositories/{workspace}/{repo}/pullrequests/<id>` for one `<img>` per reference.
3. A browser signed in with repository read access displays each image. Only this step shows what a viewer sees: the API token and the browser session are different credentials, so rendered `<img>` tags plus an anonymous `401` do not establish it.

Downloads need no pull-request permission, and they outlive the PR while the description keeps depending on them. Delete one with `bitbucket-axi api DELETE /repositories/{workspace}/{repo}/downloads/<name>` only once nothing references it; finishing or merging the PR is not on its own a reason to delete. Viewers of a private repository must be signed in with read access (an anonymous request is rejected with 401), while a public repository makes the image world-readable.

## Development

```sh
pnpm install
pnpm run check
pnpm run dev -- --help
```

The installable agent skill is generated from the CLI description and committed at
`skills/bitbucket-axi/SKILL.md`. Regenerate it after changing the CLI's agent-facing
description, and use the check mode in validation:

```sh
pnpm run build:skill
pnpm run build:skill -- --check
```

Install the skill with `npx skills add kitwon/bitbucket-axi --skill bitbucket-axi -g`.

Tests mock HTTP responses and the OS credential store; they require no live Bitbucket credentials and never touch the real keychain.

## Publishing

From a clean checkout, verify the packed file list with `npm pack --dry-run`. Maintainers publish the current version with:

```sh
npm publish
```

The publish lifecycle rebuilds the executable and runs the full project checks. Bump the version separately before publishing a release.
