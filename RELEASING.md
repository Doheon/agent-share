# Release Process

## Prerequisites

GitHub repository secrets (Settings → Secrets and variables → Actions → Repository secrets):

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm Granular Access Token with publish permission |
| `TAP_TOKEN` | GitHub PAT with `repo` write access to `Doheon/homebrew-tap` |

## Files to bump on every release

Two files must always be updated together:

| File | Field |
|------|-------|
| `package.json` | `version` |
| `shared/protocol.ts` | `CLIENT_VERSION` |

Changing model pricing in `shared/policy.ts` also requires a version bump in both files above.

## Release steps

```bash
# 1. Update versions
#    - package.json → "version": "X.Y.Z"
#    - shared/protocol.ts → CLIENT_VERSION = "X.Y.Z"

# 2. Commit and push
git add package.json shared/protocol.ts
git commit -m "chore: bump version to X.Y.Z"
git push

# 3. Tag — this triggers the automated release workflow
git tag vX.Y.Z
git push origin vX.Y.Z
```

## What the workflow does automatically

On tag push (`v*.*.*`), `.github/workflows/release.yml`:

1. Installs dependencies and runs the full test suite
2. Verifies the tag matches both `package.json` and `CLIENT_VERSION`
3. Runs `npm pack` and computes the SHA256 of the tarball
4. Publishes to npm (`@doheon/ash`)
5. Creates a GitHub Release with auto-generated notes
6. Updates `Doheon/homebrew-tap` — bumps `url` and `sha256` in `Formula/ash.rb`

## Dry run (test without publishing)

Actions → Release → Run workflow → leave `dry_run` checked.

Runs steps 1–3 only. Safe to trigger on `main` at any time.

## Version bump rules

| Change type | Version bump |
|-------------|-------------|
| Bug fix, minor UX tweak | patch (`0.1.x`) |
| New feature, model pricing change, new wire field | minor (`0.x.0`) |
| Breaking wire protocol change (bump `PROTOCOL_VERSION`) | major (`x.0.0`) |

When `PROTOCOL_VERSION` is bumped, old and new clients cannot connect to each other.
