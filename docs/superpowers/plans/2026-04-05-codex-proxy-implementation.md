# Codex Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-only proxy environment override controlled by `HAPPY_CODEX_PROXY` without affecting Happy's own network flow.

**Architecture:** Keep the proxy logic inside the Codex app-server spawn path. Build and validate the optional proxy URL once per connect, inject it only into the spawned child process environment, and leave the parent Happy process unchanged.

**Tech Stack:** TypeScript, Vitest, Node.js child process environment handling

---

### Task 1: Add failing tests for Codex proxy injection

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`
- Test: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`

- [ ] **Step 1: Write the failing tests**

Add coverage for:
- valid `HAPPY_CODEX_PROXY` injecting uppercase and lowercase proxy env vars
- unset `HAPPY_CODEX_PROXY` leaving proxy vars untouched
- invalid `HAPPY_CODEX_PROXY` logging a warning and skipping injection

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace happy test src/codex/codexAppServerClient.test.ts`
Expected: FAIL because the current implementation does not read `HAPPY_CODEX_PROXY`

### Task 2: Implement Codex-only proxy env injection

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Test: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`

- [ ] **Step 1: Write minimal implementation**

Add a helper that:
- reads `process.env.HAPPY_CODEX_PROXY`
- validates the value as a supported URL
- returns proxy env overrides for the Codex child process only
- logs a warning and returns no overrides for invalid values

- [ ] **Step 2: Run test to verify it passes**

Run: `yarn workspace happy test src/codex/codexAppServerClient.test.ts`
Expected: PASS

### Task 3: Verify no regression in targeted behavior

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`

- [ ] **Step 1: Re-run the targeted test file**

Run: `yarn workspace happy test src/codex/codexAppServerClient.test.ts`
Expected: PASS with the sandbox integration tests still green
