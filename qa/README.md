# TripCut unattended QA

This directory contains reproducible evidence from the unattended commercial-readiness campaign.

## Rules

- Every run binds to one absolute app path and one DMG SHA-256.
- UI success is not sufficient: a case also needs its database/file oracle and restart-persistence check.
- Source media is read-only and hashed before and after each mutating workflow.
- Missing tools, skipped media tests, unhandled promises, new crash reports, and incomplete evidence are failures.
- Real user projects, provider credentials, and the user's Jianying library are outside the unattended test boundary.
- Packaged-app runs set `TRIPCUT_APP_SUPPORT_DIR` to a disposable absolute directory; production behavior is unchanged when the variable is absent.

## Phase 0 preflight

```sh
node scripts/qa/preflight.mjs \
  --app "/absolute/path/旅剪工作台.app" \
  --dmg "/absolute/path/旅剪工作台.dmg"
```

The command writes `manifest.json` and `gate.json` under `qa/runs/` and exits non-zero when the candidate or environment is ambiguous.

## Fast gates

```sh
node scripts/qa/fast-gates.mjs
```

The runner preserves every command's real exit code and treats Vitest unhandled errors as failures even when Vitest exits zero.
It also discovers Homebrew's keg-only Rustup installation without modifying the user's shell profile.

## DMG identity and dependency audit

```sh
node scripts/qa/audit-dmg.mjs --dmg "/absolute/path/旅剪工作台.dmg"
```

The audit mounts the DMG read-only, inventories every nested Mach-O by UUID and SHA-256, checks the recursive runtime links, verifies the app signature, and fails on build-machine paths, prohibited libraries, ad-hoc signing, or missing license material.

## Isolated Computer Use candidate

```sh
node scripts/qa/prepare-cua-candidate.mjs --app "/absolute/path/旅剪工作台.app"
```

This creates a uniquely identified, ad-hoc-signed QA copy in a disposable directory, gives it disposable application-support and Jianying draft directories, disables real LLM providers, removes Homebrew/user CLI directories from `PATH`, and launches it through macOS LaunchServices. Directly executing `Contents/MacOS/tripcut-studio` is forbidden because it does not reproduce Finder/DMG startup and can yield a blank WebKit window.
The runner fails before launch when the macOS desktop is locked because a locked session cannot provide valid Computer Use window or accessibility evidence.

After quitting the candidate, compare native crash reports with the captured baseline:

```sh
node scripts/qa/crash-diff.mjs \
  --baseline "/absolute/path/cua-candidate/manifest.json" \
  --out "/absolute/path/cua-candidate"
```

Generated run directories are local evidence and should not be used as source-controlled golden baselines.
