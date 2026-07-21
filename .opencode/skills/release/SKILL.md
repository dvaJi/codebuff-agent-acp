---
name: release
description: Use when the user asks to cut, create, make, or publish a release of this package (e.g. "make a release", "publish v1.2.3", "cut a release", "bump and release", "ship a new version"). Runs the full release flow - infers or confirms the next semver from conventional commits, regenerates CHANGELOG.md from the git log, bumps package.json, commits, tags, and creates the GitHub Release that triggers the npm publish workflow. Do NOT use for dependency bumps or unrelated version edits.
---

# Release

This project releases via the **`Release` GitHub Actions workflow**
(`.github/workflows/release.yml`), which publishes to npm with provenance when a
**GitHub Release** is published. So "doing a release" means: prepare version +
changelog locally, then create a GitHub Release — never run `npm publish`
locally.

Pre-requisites that must already exist (if missing, stop and tell the user):
- a git repo with a `master` branch and a remote called `origin`
- `gh` CLI authenticated (`gh auth status`)
- the `NPM_TOKEN` repo secret set in GitHub (you cannot verify this locally;
  just remind the user once)

## Flow

Work through these steps in order. Use the **bash** tool for git/gh/npm, and the
**edit/write** tools for `package.json` / `CHANGELOG.md`.

### 1. Sanity-check the working copy

- `git rev-parse --abbrev-ref HEAD` → expect `master`. If not, ask the user
  whether to proceed.
- `git status --porcelain` → must be empty. If not, ask the user to commit or
  stash first; do not commit unrelated changes as part of the release.
- `npm run check && npm run build` → must pass. Stop and report if it fails.

### 2. Determine the previous version and the commit range

```bash
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
```

- If `PREV_TAG` is set, the range is `$PREV_TAG..HEAD`.
- If unset (first release), use the whole history: `git log` with no range.

### 3. Collect commits and infer the bump

```bash
git log ${PREV_TAG:+$PREV_TAG..HEAD} --pretty=format:"%h%x09%s"
```

Classify by [Conventional Commits](https://www.conventionalcommits.org/) prefix
(`type(scope): description`), ignoring merges and `chore(release): ...` commits
from prior releases:

| Bump level | Trigger |
| ---------- | ------- |
| **major** (`x.0.0`) | any commit body has `BREAKING CHANGE:` or the header uses `type!:` |
| **minor** (`0.x.0`) | any `feat:` / `feat(scope):` |
| **patch** (`0.0.x`) | any `fix:`, `perf:`, `refactor:`, `docs:`, `test:` |
| none | only `chore:`/`ci:`/`build:` → ask the user whether to force a patch |

Read the current version from `package.json` (`version`), apply the bump, and
present the proposed new version to the user. If the user gave an explicit
version (e.g. "release 1.2.3"), use that verbatim. **Confirm the version before
continuing.**

### 4. Generate CHANGELOG.md

Use the [Keep a Changelog](https://keepachangelog.com/) format. If
`CHANGELOG.md` does not exist, create it with this header:

```markdown
# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

```

Then insert a new section near the top (directly under the header block, above
any previous release), dated today (`date +%Y-%m-%d`):

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Breaking changes
- <commit subject> ([`<short hash>`](../../commit/<full hash>))

### Features
- ...

### Bug fixes
- ...

### Performance
- ...

### Other
- ...  (refactor / docs / test / chore grouped here)
```

Rules:
- Group commits under the headings above; **omit any empty heading**.
- Drop the conventional-commit prefix from the displayed subject
  (`feat(parser): add X` → `parser: add X`).
- One bullet per meaningful commit; collapse duplicate/noisy `chore:`/`ci:`
  commits into a single "Maintenance" line if there are several.
- Link each bullet to the commit (`../../commit/<hash>` works on GitHub).

### 5. Bump `package.json`

```bash
npm version <newversion> --no-git-tag-version
```

This updates `package.json` **and** `package-lock.json`. Do not also hand-edit
the version.

### 6. Show the user, then commit + tag

Before any destructive/remote step, print a summary: the new version, the
changelog section you wrote, and the exact commands you are about to run. Wait
for the user to confirm.

Then:

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin master --follow-tags
```

(If `--follow-tags` does not push the tag on the user's git version, also run
`git push origin vX.Y.Z`.) On `master`, `--follow-tags` pushes the tag with the branch.

### 7. Create the GitHub Release (this triggers the npm publish)

Capture **just this version's** changelog notes (the body under
`## [X.Y.Z] - YYYY-MM-DD`) into the release body — do not paste the whole file.

```bash
gh release create vX.Y.Z \
  --verify-tag \
  --title "vX.Y.Z" \
  --notes "$(the X.Y.Z changelog section text)"
```

Prefer your hand-written changelog over `--generate-notes`. You may pass
`--generate-notes` as well to let GitHub append contributor/PR links, but the
changelog section must be the primary body.

### 8. Verify

- `gh run list --workflow=release.yml --limit 1` → confirm the Release workflow
  started.
- Wait for it (`gh run watch`), or give the user the Actions URL.
- On success, confirm the version appears at
  `https://www.npmjs.com/package/codebuff-agent-acp` and that the published
  tarball shows the provenance badge.

## Edge cases

- **Workflow file missing or trigger changed**: if `.github/workflows/release.yml`
  no longer triggers on `release: published`, stop and reconcile with the
  actual workflow before creating the release.
- **Tag already exists**: if `vX.Y.Z` exists, do not overwrite it. Ask the user
  whether to delete the local+remote tag and retry, or pick a new version.
- **First release (no prior tag)**: include the full history in the changelog,
  grouped the same way.
- **Dry run**: if the user says "dry run" or "preview", do steps 2–6 up to (but
  not including) the commit, show the diff and changelog, and stop.
