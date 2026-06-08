# Phase 0 result

**Date:** 2026-06-06
**bun --compile smoke for pi-agent-core 0.78.1:** PASS

## Evidence
- `apps/agent/scripts/smoke-pi-bundle.ts` runs as plain Bun: PASS (prints `smoke ok`, exit 0)
- `bun build --compile --target=bun-windows-x64` produces an exe: PASS (2078 modules bundled, ~840 ms total, ~120 MB exe at `/tmp/smoke-pi.exe`)
- The exe runs and prints `smoke ok`: PASS (exit 0)

## Decision
Packaging strategy: **A** (single-file `bun --compile` sidecar exe; current v0.3 model continues).

## Setup note
The script as written in the plan imports `Type` from `typebox`. `typebox` is a transitive dep of `pi-agent-core` and is not directly resolvable in the Bun workspace by default. Added it as an exact-pinned root devDependency:

```
bun add -d -E typebox@1.1.38
```

This is committed as a separate `deps: add typebox` commit. Subsequent phases (3b/3c) that author AgentTools will need this at the workspace root anyway.

## Commands re-run by reviewer
```
bun run apps/agent/scripts/smoke-pi-bundle.ts
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/smoke-pi.exe scripts/smoke-pi-bundle.ts && /tmp/smoke-pi.exe
```
