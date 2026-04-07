# OpenCode Multi-Turn Remote-Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `happy opencode` remote-native mode so mobile users can send multiple messages continuously, with short message coalescing and restart-on-newer-input semantics.

**Architecture:** Keep the existing `loop.ts` contract unchanged and implement multi-turn behavior entirely inside `opencodeRemoteNativeLauncher()`. Each remote-native turn is still one native `opencode` process, but the launcher now loops, coalesces queued mobile input, aborts stale runs when fresher input arrives, and restarts with reconstructed context from `OpenCodeSession`.

**Tech Stack:** TypeScript, Vitest, native `opencode` child-process wrapper, `MessageQueue2`, existing OpenCode session/context helpers

---

## File Structure

### Existing files to modify

- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`
  - Replace one-shot handoff with a multi-turn internal loop, restart handling, and coalescing.
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`
  - Add behavior coverage for sequential turns, in-flight restart, coalescing, and switch/exit priority.
- Modify: `packages/happy-cli/src/opencode/loop.test.ts`
  - Add or update one higher-level smoke test only if the launcher refactor requires it.
- Modify: `packages/happy-cli/src/opencode/runOpenCode.test.ts`
  - Add one higher-level smoke test only if needed to prove the remote-native path still fits the shared setup/cleanup flow.

### Existing files that may be modified if tests require it

- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNative.ts`
  - Only if the launcher needs a tiny helper-level change for restart semantics.

### No planned changes

- Do not modify: `packages/happy-cli/src/opencode/loop.ts`
- Do not modify: `packages/happy-cli/src/opencode/runOpenCode.ts`
- Do not modify: `packages/happy-cli/src/commands/opencodeCommand.ts`
- Do not modify: `packages/happy-cli/src/opencode/opencodeSession.ts`

---

### Task 1: Add Red Tests For Multi-Turn Remote-Native Behavior

**Files:**
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`

- [ ] **Step 1: Write the failing test for sequential multi-turn remote-native runs**

Add this test to `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`:

```ts
it('starts a second native run when a later mobile message arrives after the first run completes', async () => {
  const { session } = makeSession()
  let waitCallCount = 0
  session.queue.waitForMessagesAndGetAsString = vi.fn().mockImplementation(async () => {
    waitCallCount += 1
    if (waitCallCount === 1) {
      return { message: 'first mobile message', mode: {}, isolate: false, hash: 'one' }
    }
    if (waitCallCount === 2) {
      return { message: 'second mobile message', mode: {}, isolate: false, hash: 'two' }
    }
    return null
  })
  mocks.mockRunOpenCodeRemoteNative
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)

  const result = await opencodeRemoteNativeLauncher(session as never)

  expect(result).toBe('exit')
  expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2)
  expect(mocks.mockBuildRemoteNativePrompt.mock.calls[0]?.[0]).toMatchObject({
    latestUserMessage: 'first mobile message',
  })
  expect(mocks.mockBuildRemoteNativePrompt.mock.calls[1]?.[0]).toMatchObject({
    latestUserMessage: 'second mobile message',
  })
})
```

- [ ] **Step 2: Write the failing test for in-flight restart on newer input**

Add this test to `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`:

```ts
it('aborts the active native run and restarts with newer mobile input', async () => {
  const { session } = makeSession()
  let resolveFirstWait!: (value: { message: string, mode: {}, isolate: boolean, hash: string } | null) => void
  let resolveSecondWait!: (value: { message: string, mode: {}, isolate: boolean, hash: string } | null) => void
  session.queue.waitForMessagesAndGetAsString = vi
    .fn()
    .mockImplementationOnce(() => Promise.resolve({ message: 'stale prompt', mode: {}, isolate: false, hash: 'one' }))
    .mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstWait = resolve
    }))
    .mockImplementationOnce(() => new Promise((resolve) => {
      resolveSecondWait = resolve
    }))
    .mockImplementationOnce(() => Promise.resolve(null))

  mocks.mockRunOpenCodeRemoteNative.mockImplementationOnce(({ abort }: { abort: AbortSignal }) =>
    new Promise<number>((_, reject) => {
      abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true })
    }),
  )
  mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0)

  const launcherPromise = opencodeRemoteNativeLauncher(session as never)

  await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
  resolveFirstWait({ message: 'fresh mobile message', mode: {}, isolate: false, hash: 'two' })
  resolveSecondWait(null)

  await expect(launcherPromise).resolves.toBe('exit')
  expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2)
  expect(mocks.mockBuildRemoteNativePrompt.mock.calls[1]?.[0]).toMatchObject({
    latestUserMessage: 'fresh mobile message',
  })
})
```

- [ ] **Step 3: Write the failing test for coalescing window behavior**

Add this test to `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`:

```ts
it('coalesces bursty mobile messages into one native run', async () => {
  vi.useFakeTimers()
  const { session } = makeSession()
  session.queue.waitForMessagesAndGetAsString = vi
    .fn()
    .mockResolvedValueOnce({ message: 'line one', mode: {}, isolate: false, hash: 'one' })
    .mockResolvedValueOnce({ message: 'line two', mode: {}, isolate: false, hash: 'two' })
    .mockResolvedValueOnce(null)
  mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0)

  const launcherPromise = opencodeRemoteNativeLauncher(session as never)
  await vi.advanceTimersByTimeAsync(400)

  await expect(launcherPromise).resolves.toBe('exit')
  expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1)
  expect(mocks.mockBuildRemoteNativePrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      latestUserMessage: expect.stringContaining('line one'),
    }),
  )
})
```

- [ ] **Step 4: Write the failing test for switch priority over pending restart**

Add this test to `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`:

```ts
it('returns switch instead of restarting when terminal switch wins the race', async () => {
  const { session, getRpcHandlerManager } = makeSession()
  let waitResolver!: (value: { message: string, mode: {}, isolate: boolean, hash: string } | null) => void
  session.queue.waitForMessagesAndGetAsString = vi
    .fn()
    .mockResolvedValueOnce({ message: 'first turn', mode: {}, isolate: false, hash: 'one' })
    .mockImplementationOnce(() => new Promise((resolve) => {
      waitResolver = resolve
    }))
  mocks.mockRunOpenCodeRemoteNative.mockImplementation(({ abort }: { abort: AbortSignal }) =>
    new Promise<number>((_, reject) => {
      abort.addEventListener('abort', () => reject(new ExitCodeError(130)), { once: true })
    }),
  )

  const launcherPromise = opencodeRemoteNativeLauncher(session as never)
  await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
  waitResolver({ message: 'new mobile input', mode: {}, isolate: false, hash: 'two' })
  await getRpcHandlerManager().handlers.get('switch')?.()

  await expect(launcherPromise).resolves.toBe('switch')
  expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 5: Run the launcher test file to verify the new tests fail**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts
```

Expected: FAIL because the current launcher only supports a one-shot remote-native turn and has no coalescing/restart loop.

- [ ] **Step 6: Commit the failing-test baseline**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts
git commit -m "test: cover opencode multi-turn remote native behavior"
```

### Task 2: Implement Multi-Turn Remote-Native Loop With Restart And Coalescing

**Files:**
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`

- [ ] **Step 1: Add a small coalescing helper inside the launcher file**

Update `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts` with a helper like:

```ts
const REMOTE_MESSAGE_COALESCE_MS = 400

async function collectCoalescedBatch(
  session: OpenCodeSession,
  abort: AbortSignal,
  firstBatch: { message: string, mode: unknown, isolate: boolean, hash: string } | null,
): Promise<string | null> {
  if (!firstBatch) {
    return null
  }

  let combinedMessage = firstBatch.message
  const deadline = Date.now() + REMOTE_MESSAGE_COALESCE_MS

  while (!abort.aborted) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return combinedMessage
    }

    const nextBatch = await Promise.race([
      session.queue.waitForMessagesAndGetAsString(abort),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ])

    if (!nextBatch) {
      return combinedMessage
    }

    combinedMessage = `${combinedMessage}\n${nextBatch.message}`
  }

  return combinedMessage
}
```

- [ ] **Step 2: Replace the one-shot implementation with an internal loop**

Refactor the body of `opencodeRemoteNativeLauncher()` so it follows this shape:

```ts
let pendingBatch: { message: string, mode: unknown, isolate: boolean, hash: string } | null = null

while (true) {
  const firstBatch =
    pendingBatch ?? (await session.queue.waitForMessagesAndGetAsString(abortController.signal))
  pendingBatch = null

  if (!firstBatch || exitReason === 'exit') {
    return 'exit'
  }
  if (exitReason === 'switch') {
    return 'switch'
  }

  const latestUserMessage = await collectCoalescedBatch(session, abortController.signal, firstBatch)
  if (!latestUserMessage) {
    return exitReason ?? 'exit'
  }

  const recentContext = session.buildRecentContext()
  const initialPrompt = buildRemoteNativePrompt({
    recentTimeline: recentContext.recentTimeline,
    latestUserMessage,
    workingDirectory: session.path,
  })

  let pendingRestart = false
  let nextPendingBatch: { message: string, mode: unknown, isolate: boolean, hash: string } | null = null

  session.queue.setOnMessage((message, mode) => {
    nextPendingBatch = {
      message,
      mode,
      isolate: false,
      hash: '',
    }
    pendingRestart = true
    if (!abortController.signal.aborted) {
      abortController.abort()
    }
  })

  try {
    await runOpenCodeRemoteNative({ ... })
    if (!pendingRestart) {
      return exitReason ?? 'exit'
    }
  } catch (error) {
    if (!(error instanceof ExitCodeError && pendingRestart)) {
      if (error instanceof ExitCodeError && exitReason) {
        return exitReason
      }
      throw error
    }
  } finally {
    session.queue.setOnMessage(null)
  }

  if (exitReason === 'switch') {
    return 'switch'
  }
  if (exitReason === 'exit') {
    return 'exit'
  }

  pendingBatch = nextPendingBatch
}
```
```

- [ ] **Step 3: Preserve output and existing interrupt semantics**

Ensure the refactor keeps these lines or equivalent behavior:

```ts
onStdout: (chunk) => {
  session.recordAssistantOutput(chunk)
  process.stdout.write(chunk)
},
onStderr: (chunk) => {
  session.recordAssistantOutput(chunk)
  process.stderr.write(chunk)
},
```

and:

```ts
if (error instanceof ExitCodeError && exitReason) {
  return exitReason
}
```

so restart, switch, and exit interruptions are never surfaced as hard failures after commitment.

- [ ] **Step 4: Run the launcher test file to verify the new tests pass**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts
```

Expected: PASS, including the new sequential-run, restart, coalescing, and switch-priority tests.

- [ ] **Step 5: Commit the launcher implementation**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts
git commit -m "feat: add opencode multi-turn remote native loop"
```

### Task 3: Add One Higher-Level Smoke Test And Run Focused Regressions

**Files:**
- Modify: `packages/happy-cli/src/opencode/loop.test.ts`
- Modify: `packages/happy-cli/src/opencode/runOpenCode.test.ts`

- [ ] **Step 1: Add one smoke test proving daemon-started remote mode still uses the native remote path**

Add this test to `packages/happy-cli/src/opencode/loop.test.ts` if no equivalent exists:

```ts
it('uses the remote native launcher by default when starting in remote mode', async () => {
  const localLauncher = vi.fn()
  const remoteLauncher = vi.fn().mockResolvedValue('exit' as const)

  const { loopOpenCode } = await import('./loop')

  await expect(
    loopOpenCode({
      path: '/tmp/project',
      logPath: '/tmp/opencode.log',
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: [],
      verbose: false,
      startingMode: 'remote',
      api: {} as never,
      client: makeClient() as never,
      queue: { push: vi.fn() } as never,
      launchers: {
        local: localLauncher,
        remote: remoteLauncher,
      },
    }),
  ).resolves.toBe(0)

  expect(localLauncher).not.toHaveBeenCalled()
  expect(remoteLauncher).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run focused tests to verify any new smoke test fails if it should**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/loop.test.ts src/opencode/runOpenCode.test.ts
```

Expected: PASS if the current wiring already supports the smoke path, otherwise FAIL and expose the missing wiring.

- [ ] **Step 3: Apply only the minimal fix if the smoke test exposes a gap**

If needed, update the relevant file with the smallest fix required, for example:

```ts
expect(mocks.mockLoopOpenCode).toHaveBeenCalledWith(
  expect.objectContaining({
    startingMode: 'remote',
    remoteCommand: 'opencode',
  }),
)
```

If no code change is needed, leave production files untouched and keep only the new smoke coverage.

- [ ] **Step 4: Re-run focused OpenCode regressions**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts src/opencode/loop.test.ts src/opencode/runOpenCode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the focused regression updates**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts packages/happy-cli/src/opencode/loop.test.ts packages/happy-cli/src/opencode/runOpenCode.test.ts
git commit -m "test: cover opencode remote native multi-turn wiring"
```

### Task 4: Run Full OpenCode Regression

**Files:**
- Verify only

- [ ] **Step 1: Run the full OpenCode regression suite**

Run:

```bash
./node_modules/.bin/vitest run src/commands/opencodeCommand.test.ts src/opencode/runOpenCode.test.ts src/opencode/loop.test.ts src/opencode/opencodeLocal.test.ts src/opencode/opencodeLocalLauncher.test.ts src/opencode/opencodeRemoteNative.test.ts src/opencode/opencodeRemoteNativeLauncher.test.ts src/opencode/opencodeContext.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the shared lifecycle regression suite**

Run:

```bash
./node_modules/.bin/vitest run src/commands/codexCommand.test.ts src/commands/opencodeCommand.test.ts src/claude/claudeLocalLauncher.test.ts src/codex/runCodex.exit.test.ts src/codex/runCodex.cleanup.test.ts src/daemon/sessionTracking.test.ts
```

Expected: PASS.

- [ ] **Step 3: Summarize remaining known risk explicitly**

Document in the implementation summary that the accepted remaining limitation is:

```txt
remote-native still uses one native process per turn and preserves interrupted partial output in the context timeline
```

- [ ] **Step 4: Commit the verified final state**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts packages/happy-cli/src/opencode/loop.test.ts packages/happy-cli/src/opencode/runOpenCode.test.ts
git commit -m "feat: support multi-turn opencode remote native sessions"
```

## Self-Review

### Spec coverage

- Multi-turn sequential behavior: Task 1 and Task 2
- Running-time restart behavior: Task 1 and Task 2
- Coalescing window behavior: Task 1 and Task 2
- Switch / exit priority: Task 1 and Task 2
- Cleanup/rebinding behavior: existing coverage kept and extended in Task 1 and Task 3

### Placeholder scan

- No `TODO`/`TBD`
- All test steps include concrete test code and commands
- All implementation steps name exact files and code shapes

### Type consistency

- Uses existing `OpenCodeSession`, `ExitCodeError`, `buildRemoteNativePrompt`, and `runOpenCodeRemoteNative`
- Keeps launcher return type as `'switch' | 'exit'`
- Uses `MessageQueue2.waitForMessagesAndGetAsString()` consistently with current codebase
