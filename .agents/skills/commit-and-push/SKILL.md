---
name: commit-and-push
description: >-
  Stage every change in the working tree, write a scoped Conventional Commit
  message that follows repository commit and PR title conventions, commit, and
  push to the current branch. Use this whenever the user asks to "commit",
  "commit and push", "commit my changes", "push this up", "save my work to
  git", "ship it", or otherwise wants their working changes committed, even if
  they do not say the words "conventional commit".
---

# Commit and Push

Turn the current working-tree changes into one well-formed scoped Conventional
Commit and push it to the current branch. The goal is a commit message a
teammate can read in isolation and understand _what changed and why_, without
opening the diff.

## Commit and PR Conventions

### 1. Purpose

This specification defines repository-wide naming conventions for:

- commit messages
- pull request (PR) titles

The goal is consistent history, clear release notes, and searchable intent
across the monorepo.

#### 1.0 Normative Keywords (RFC 2119 style)

- Uppercase `MUST` = required
- Uppercase `MUST NOT` = prohibited
- Uppercase `SHOULD` = strongly recommended
- Uppercase `MAY` = optional
- Lowercase forms (`must`, `must not`, `should`, `may`) are explanatory and are
  not normative keywords.

### 2. Required Format

Commit subjects and PR titles MUST follow this format:

`<type>(<scope>): <description>`

### 3. Allowed Types

The `<type>` value MUST be one of:

- `feat`: new feature or functionality
- `fix`: bug fix
- `docs`: documentation or README changes
- `chore`: maintenance tasks, dependency updates, and repository upkeep
- `refactor`: code refactoring without behavior changes
- `test`: adding or updating tests

Types MUST be lowercase.

### 4. Scope Rules

- Scope MUST be included in all commit subjects and PR titles.
- Scope MUST be lowercase.
- Scope MUST be the package name without the npm scope prefix.
- If the package name is `@org/app-console`, the scope MUST be `app-console`.
- If the package name is `@org/lib-browser-feature-flags`, the scope MUST be
  `lib-browser-feature-flags`.
- Scope MUST match the package that is primarily affected by the change.
- For changes spanning multiple packages, scope SHOULD use the primary package
  for the change.
- For root-only changes, scope MUST use the root package name from the root
  `package.json`.

### 5. Commit Message Rules

- The first line (subject) MUST follow Section 2.
- Additional body/footer lines MAY be included after a blank line following the
  subject.
- The subject SHOULD describe intent/result, not implementation details.

### 6. Pull Request Title Rules

- PR titles MUST follow the same format and type rules as commit subjects.
- PR titles SHOULD reflect the primary change introduced by the PR.

### 7. Compliant Examples

- `docs(app-console): update contributing guidelines`
- `fix(app-console): resolve crash on startup`
- `feat(app-console): add dark mode support`
- `chore(lib-browser-feature-flags): bump dependency versions`
- `refactor(lib-shared-date): simplify date parsing utility`
- `test(service-api): add contract validation tests`

### 8. Non-compliant Examples

- `Add dark mode`
- `fixed bug`
- `feat: add dark mode`
- `feat(@org/app-console): add dark mode`
- `fix(apps/app-console): resolve crash on startup`
- `docs(specs): update docs`
- `Feature: dark mode`
- `feat add dark mode`
- `misc: update stuff`

## Workflow

Do these in order. Steps 1-2 are read-only investigation; do not skip them. The
quality of the message depends on understanding the diff first.

### 1. Read the current state

Run these together to understand what you are about to commit:

```bash
git status
git diff --stat
git diff                     # unstaged changes
git diff --staged            # already-staged changes
git branch --show-current
git log -n 5 --oneline       # understand existing history
```

Also read the root `package.json` and any affected workspace `package.json`
files so the commit scope can be derived from package names. Scope is not a
directory name, npm scope, or arbitrary area label.

Look at `git log` output to understand repository history, but do not copy older
non-compliant subjects. The convention in this file is authoritative.

### 2. Understand the change as a whole

Read the actual diff, not just the file names. Ask what one thing this change
accomplishes. The commit message describes intent and effect, not a file-by-file
inventory.

If the working tree contains clearly unrelated changes, such as a bug fix and an
unrelated dependency bump, note this to the user and ask whether they want
separate commits. Default to a single commit only when the user explicitly asks
to commit everything.

### 3. Format the working tree

Run the repository formatter before staging so commits do not rely on Git hooks
to clean up formatting:

```bash
pnpm fmt
```

Formatting may modify files. After it finishes, re-check the working tree before
staging:

```bash
git status
git diff --stat
git diff
```

If formatting introduced changes that are unrelated to the requested commit or
revealed files that should not be committed, pause and flag them to the user
before staging.

### 4. Stage everything

```bash
git add -A
```

This stages new, modified, and deleted files. If `git status` showed files you
suspect should not be committed, such as secrets, large binaries, `.env`, editor
cruft, or debug logging, pause and flag them to the user before staging rather
than committing them silently.

### 5. Write the Conventional Commit message

Format:

```text
<type>(<scope>): <description>

<body>

<footer>
```

- **type**: MUST be present, MUST be lowercase, and MUST be one of `feat`,
  `fix`, `docs`, `chore`, `refactor`, or `test`. Pick by the change's intent.
- **scope**: MUST be present, MUST be lowercase, and MUST be the primarily
  affected package name without the npm scope prefix. For root-only changes, use
  the root package name from the root `package.json`.
- **description**: MUST be present and SHOULD describe intent/result, not
  implementation details. Use imperative mood, a lowercase start, and no
  trailing period.
- **body**: MAY be included after a blank line. When included, the body MUST use
  `-` bullet points, one bullet per distinct change or reason. Phrase each
  bullet as what the change does and why. Wrap each bullet at about 72 chars.
- **footer**: MAY include issue references, such as `Closes #142`. If the change
  is backward-incompatible, the footer MUST include
  `BREAKING CHANGE: <description>`.

Do not use non-compliant subjects like `feat: add login`,
`feat(@org/app-console): add login`, `fix(apps/app-console): resolve crash`, or
`misc: update stuff`.

Write the message to a temp file and commit with it so multi-line bodies and
special characters are preserved exactly:

```bash
git commit -F /path/to/scratchpad/commit-msg.txt
```

Do **not** add a `Co-Authored-By` trailer.

Examples:

Input: added a new WorkOS SSO login route and its callback handler in
`@org/app-console`

Output:

```text
feat(app-console): add WorkOS SSO login routes

- add login route that redirects into the AuthKit flow
- add callback route that exchanges the code for a session
```

Input: fixed a crash when the events list is empty in `@org/app-console`, plus
a typo in a nearby comment

Output:

```text
fix(app-console): guard against empty event list

- return the empty state instead of dereferencing events[0],
  which threw on an empty timeline
- fix a typo in the nearby add() doc comment
```

Input: bumped a dependency in `@org/lib-browser-feature-flags` and updated the
lockfile

Output:

```text
chore(lib-browser-feature-flags): upgrade effect to v4 beta
```

The dependency bump is a single self-explanatory change, so it needs no body. Do
not invent bullets to pad a one-line commit.

### 6. Push to the current branch

```bash
git push
```

If the branch has no upstream yet, git will error asking you to set one. Push
with the tracking flag:

```bash
git push -u origin "$(git branch --show-current)"
```

Push to whatever branch is currently checked out, as-is. Do not create a new
branch and do not second-guess the target branch.

## After committing

Report back concisely: the commit hash and subject line, and confirmation that
the push succeeded and to which branch. If the push failed because it was
rejected, diverged, or hit a network error, surface the exact git error and
stop. Do not force-push or try to reconcile without asking.

## When there is nothing to commit

If `git status` shows a clean tree, say so and stop. Do not create an empty
commit.
