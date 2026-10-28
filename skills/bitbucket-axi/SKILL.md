---
name: bitbucket-axi
description: "Use the bitbucket-axi CLI to inspect Bitbucket Cloud repositories, pull requests, and pipelines, call raw API endpoints, manage keychain credentials, or configure its optional Git HTTPS credential helper. Use whenever a task involves Bitbucket Cloud repository state or API operations."
user-invocable: false
author: Kit Chan
metadata:
  hermes:
    tags: [bitbucket, repositories, pull-requests, pipelines]
    category: developer-tools
---

# bitbucket-axi

Inspect repositories, pull requests, and pipelines in Bitbucket Cloud with agent-efficient output.

## When to use

Use bitbucket-axi whenever a task needs Bitbucket Cloud repository details, pull requests, pipeline runs, raw API access, or credential setup for those operations. It also provides an opt-in Git HTTPS credential helper; SSH remains the default Git transport.

Get every command, flag, and workflow from the live CLI - it is the single source of truth:

- `npx -y bitbucket-axi` - dashboard for the current repository
- `npx -y bitbucket-axi --help` - global usage
- `npx -y bitbucket-axi <command> --help` - per-command usage

API credentials are stored in the OS credential manager. If the CLI reports that credentials are missing, run `npx -y bitbucket-axi config set`; for automation, provide the account email and pipe the token to `npx -y bitbucket-axi config set --email <email> --token-stdin`. If it instead reports that the login keychain is locked, the stored credential is intact and must not be re-entered - the user has to unlock the keychain in their own terminal with `security unlock-keychain ~/Library/Keychains/login.keychain-db` (no `-p`/`-u`).

## Images in pull request descriptions

Bitbucket Cloud's public REST API cannot attach images to a pull request (BCLOUD-23909 is still open); PR descriptions are Markdown, so upload the file to the repository's Downloads and reference it:

- `npx -y bitbucket-axi api POST /repositories/{workspace}/{repo}/downloads --file files=./screenshot.png` (needs the `write:repository:bitbucket` scope)
- add `![screenshot](https://bitbucket.org/<workspace>/<repo>/downloads/screenshot.png)` to the description, for example `npx -y bitbucket-axi api PUT /repositories/{workspace}/{repo}/pullrequests/<id> --field description="$(cat body.md)"`
- re-uploading the same file name replaces its bytes, so use a distinct name per image; viewers of a private repository must be signed in with read access.
