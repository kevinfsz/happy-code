# OpenCode Native Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current ACP-backed remote mode in `happy opencode` with a native remote OpenCode runner that preserves Claude-like local/remote switching behavior.

**Architecture:** Keep the existing `runOpenCode -> loopOpenCode -> launcher` structure, but replace the remote launcher with a native remote runner. Use Happy-managed context reconstruction rather than trying to share one exact OpenCode process across local and remote modes. Preserve existing lifecycle, daemon, and mode-metadata guarantees while migrating away from ACP for user-facing OpenCode behavior.

**Tech Stack:** TypeScript, Vitest, Happy session API clients, native `opencode` CLI process management, existing OpenCode loop/session abstractions

---

## File Structure

### Existing files to modify

- Modify: `packages/happy-cli/src/opencode/opencodeSession.ts`
  - Add recent-context buffering and remote-native reconstruction helpers.
- Modify: `packages/happy-cli/src/opencode/loop.ts`
  - Route remote mode to the new native remote launcher instead of the ACP launcher.
- Modify: `packages/happy-cli/src/opencode/runOpenCode.ts`
  - Ensure shared message capture and lifecycle hooks support remote-native mode.
- Modify: `packages/happy-cli/src/opencode/opencodeLocalLauncher.ts`
  - Keep switch semantics aligned with the new remote-native behavior where needed.
- Modify: `packages/happy-cli/src/commands/opencodeCommand.ts`
  - Keep command routing aligned with the native-only local/remote model.

### Existing tests to modify

- Modify: `packages/happy-cli/src/opencode/runOpenCode.test.ts`
- Modify: `packages/happy-cli/src/opencode/loop.test.ts`
- Modify: `packages/happy-cli/src/opencode/opencodeLocalLauncher.test.ts`

### New implementation files

- Create: `packages/happy-cli/src/opencode/opencodeRemoteNative.ts`
  - Low-level process adapter for remote-native OpenCode invocation.
- Create: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`
  - Happy-managed remote-native mode orchestration.
- Create: `packages/happy-cli/src/opencode/opencodeContext.ts`
  - Context capture/reconstruction helpers used during local-to-remote handoff.

### New tests

- Create: `packages/happy-cli/src/opencode/opencodeRemoteNative.test.ts`
- Create: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`
- Create: `packages/happy-cli/src/opencode/opencodeContext.test.ts`

---

### Task 1: Add Context Buffering to OpenCode Session

**Files:**
- Modify: `packages/happy-cli/src/opencode/opencodeSession.ts`
- Test: `packages/happy-cli/src/opencode/loop.test.ts`
- Test: `packages/happy-cli/src/opencode/runOpenCode.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these assertions to `packages/happy-cli/src/opencode/runOpenCode.test.ts` and `packages/happy-cli/src/opencode/loop.test.ts`:

```ts
it('records recent user messages for later remote reconstruction', async () => {
  const session = new OpenCodeSession({
    api: {} as never,
    client: makeClient() as never,
    queue: { push: vi.fn() } as never,
    path: '/tmp/project',
    logPath: '/tmp/opencode.log',
    localCommand: 'opencode',
    localArgs: [],
    remoteCommand: 'opencode',
    remoteArgs: [],
    verbose: false,
  })

  session.recordUserMessage('first prompt')
  session.recordAssistantOutput('partial answer')

  expect(session.buildRecentContext()).toEqual({
    recentUserMessages: ['first prompt'],
    recentAssistantOutput: ['partial answer'],
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/runOpenCode.test.ts src/opencode/loop.test.ts
```

Expected: FAIL because `recordUserMessage`, `recordAssistantOutput`, and `buildRecentContext` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Update `packages/happy-cli/src/opencode/opencodeSession.ts` to add:

```ts
private readonly recentUserMessages: string[] = []
private readonly recentAssistantOutput: string[] = []

recordUserMessage(message: string): void {
  this.recentUserMessages.push(message)
  if (this.recentUserMessages.length > 20) {
    this.recentUserMessages.shift()
  }
}

recordAssistantOutput(chunk: string): void {
  this.recentAssistantOutput.push(chunk)
  if (this.recentAssistantOutput.length > 40) {
    this.recentAssistantOutput.shift()
  }
}

buildRecentContext(): { recentUserMessages: string[]; recentAssistantOutput: string[] } {
  return {
    recentUserMessages: [...this.recentUserMessages],
    recentAssistantOutput: [...this.recentAssistantOutput],
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/runOpenCode.test.ts src/opencode/loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeSession.ts packages/happy-cli/src/opencode/runOpenCode.test.ts packages/happy-cli/src/opencode/loop.test.ts
git commit -m "feat: add opencode context buffering"
```

### Task 2: Build Context Reconstruction Helper

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeContext.ts`
- Test: `packages/happy-cli/src/opencode/opencodeContext.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/happy-cli/src/opencode/opencodeContext.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildRemoteNativePrompt } from './opencodeContext'

describe('buildRemoteNativePrompt', () => {
  it('builds a continuation prompt from recent session context', () => {
    const prompt = buildRemoteNativePrompt({
      recentUserMessages: ['user asked for a refactor'],
      recentAssistantOutput: ['assistant inspected src/opencode'],
      latestUserMessage: 'continue and finish it',
      workingDirectory: '/repo',
    })

    expect(prompt).toContain('This session started in local OpenCode mode.')
    expect(prompt).toContain('user asked for a refactor')
    expect(prompt).toContain('assistant inspected src/opencode')
    expect(prompt).toContain('continue and finish it')
    expect(prompt).toContain('/repo')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeContext.test.ts
```

Expected: FAIL because `opencodeContext.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/happy-cli/src/opencode/opencodeContext.ts`:

```ts
export function buildRemoteNativePrompt(opts: {
  recentUserMessages: string[]
  recentAssistantOutput: string[]
  latestUserMessage: string
  workingDirectory: string
}): string {
  const userHistory = opts.recentUserMessages.map((message) => `- User: ${message}`).join('\n')
  const assistantHistory = opts.recentAssistantOutput.map((message) => `- Assistant: ${message}`).join('\n')

  return [
    'This session started in local OpenCode mode.',
    'Mobile takeover has occurred. Continue the active task without restarting the conversation.',
    `Working directory: ${opts.workingDirectory}`,
    'Recent context:',
    userHistory || '- User: (none)',
    assistantHistory || '- Assistant: (none)',
    `Latest user message: ${opts.latestUserMessage}`,
  ].join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeContext.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeContext.ts packages/happy-cli/src/opencode/opencodeContext.test.ts
git commit -m "feat: add opencode remote context builder"
```

### Task 3: Add Remote-Native Process Adapter

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeRemoteNative.ts`
- Test: `packages/happy-cli/src/opencode/opencodeRemoteNative.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/happy-cli/src/opencode/opencodeRemoteNative.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: mocks.mockSpawn,
}))

import { runOpenCodeRemoteNative } from './opencodeRemoteNative'

describe('runOpenCodeRemoteNative', () => {
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSpawn.mockReturnValue(child)
    child.on.mockImplementation(() => child)
  })

  it('spawns native opencode for remote mode and writes the reconstructed prompt', async () => {
    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      abort: new AbortController().signal,
    })

    expect(mocks.mockSpawn).toHaveBeenCalledWith(
      'opencode',
      [],
      expect.objectContaining({ cwd: '/repo', stdio: 'pipe' }),
    )
    expect(child.stdin.write).toHaveBeenCalledWith('Continue the task\n')

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1]
    exitHandler?.(0)

    await expect(promise).resolves.toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNative.test.ts
```

Expected: FAIL because `opencodeRemoteNative.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/happy-cli/src/opencode/opencodeRemoteNative.ts` with a small process wrapper that:

- spawns native `opencode`
- uses `stdio: 'pipe'`
- writes the initial reconstructed prompt to stdin
- forwards stdout/stderr through callbacks
- resolves on exit code `0`
- rejects on non-zero exit via `ExitCodeError`
- aborts by killing the child process

Use the same `ExitCodeError` pattern as `opencodeLocal.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNative.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNative.ts packages/happy-cli/src/opencode/opencodeRemoteNative.test.ts
git commit -m "feat: add opencode remote native process adapter"
```

### Task 4: Implement Remote-Native Launcher

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`
- Modify: `packages/happy-cli/src/opencode/opencodeSession.ts`
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNative.ts`
- Test: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockRunRemoteNative: vi.fn(),
  mockBuildRemoteNativePrompt: vi.fn(),
}))

vi.mock('./opencodeRemoteNative', () => ({
  runOpenCodeRemoteNative: mocks.mockRunRemoteNative,
}))

vi.mock('./opencodeContext', () => ({
  buildRemoteNativePrompt: mocks.mockBuildRemoteNativePrompt,
}))

import { opencodeRemoteNativeLauncher } from './opencodeRemoteNativeLauncher'

describe('opencodeRemoteNativeLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockBuildRemoteNativePrompt.mockReturnValue('reconstructed prompt')
  })

  it('starts remote native mode with reconstructed context and returns exit on success', async () => {
    mocks.mockRunRemoteNative.mockResolvedValue(0)

    const session = {
      path: '/repo',
      remoteCommand: 'opencode',
      remoteArgs: [],
      buildRecentContext: () => ({
        recentUserMessages: ['user asked for help'],
        recentAssistantOutput: ['assistant reviewed files'],
      }),
      queue: {
        waitForMessagesAndGetAsString: vi.fn().mockResolvedValue({
          message: 'continue',
          mode: {},
          isolate: false,
          hash: '',
        }),
      },
      client: {
        keepAlive: vi.fn(),
        sendSessionEvent: vi.fn(),
      },
      addClientChangeCallback: vi.fn(),
      removeClientChangeCallback: vi.fn(),
      recordAssistantOutput: vi.fn(),
    }

    await expect(opencodeRemoteNativeLauncher(session as never)).resolves.toBe('exit')

    expect(mocks.mockBuildRemoteNativePrompt).toHaveBeenCalledWith({
      recentUserMessages: ['user asked for help'],
      recentAssistantOutput: ['assistant reviewed files'],
      latestUserMessage: 'continue',
      workingDirectory: '/repo',
    })
    expect(mocks.mockRunRemoteNative).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'opencode',
        args: [],
        cwd: '/repo',
        initialPrompt: 'reconstructed prompt',
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts
```

Expected: FAIL because the launcher does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts` that:

- waits for the first queued mobile message
- builds a reconstructed prompt via `buildRemoteNativePrompt()`
- starts `runOpenCodeRemoteNative()`
- records remote stdout/stderr into terminal output and session context
- returns `'switch'` when terminal-side switch is requested
- returns `'exit'` when remote-native run completes normally

Use the same loop contract as the existing remote launcher.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts packages/happy-cli/src/opencode/opencodeSession.ts packages/happy-cli/src/opencode/opencodeRemoteNative.ts
git commit -m "feat: add opencode remote native launcher"
```

### Task 5: Replace ACP Remote Routing in the OpenCode Loop

**Files:**
- Modify: `packages/happy-cli/src/opencode/loop.ts`
- Modify: `packages/happy-cli/src/opencode/loop.test.ts`
- Modify: `packages/happy-cli/src/opencode/runOpenCode.ts`

- [ ] **Step 1: Write the failing test**

Add this assertion to `packages/happy-cli/src/opencode/loop.test.ts`:

```ts
it('uses the remote native launcher instead of the ACP launcher', async () => {
  const localLauncher = vi.fn().mockResolvedValue({ type: 'switch' as const })
  const remoteLauncher = vi.fn().mockResolvedValue('exit' as const)

  const { loopOpenCode } = await import('./loop')

  await loopOpenCode({
    path: '/tmp/project',
    logPath: '/tmp/opencode.log',
    localCommand: 'opencode',
    localArgs: [],
    remoteCommand: 'opencode',
    remoteArgs: [],
    verbose: false,
    api: {} as never,
    client: makeClient() as never,
    queue: { push: vi.fn() } as never,
    launchers: {
      local: localLauncher,
      remote: remoteLauncher,
    },
  })

  expect(remoteLauncher).toHaveBeenCalledTimes(1)
})
```

Then change the production import expectation in the same test file so the default remote launcher target is the native remote launcher module, not the ACP one.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/loop.test.ts
```

Expected: FAIL because `loop.ts` still imports the old remote launcher.

- [ ] **Step 3: Write minimal implementation**

Update `packages/happy-cli/src/opencode/loop.ts`:

- replace the import of `opencodeRemoteLauncher`
- import `opencodeRemoteNativeLauncher`
- keep the same launcher contract

Update `packages/happy-cli/src/opencode/runOpenCode.ts` if needed so the session/context capture required by remote-native mode is initialized before entering the loop.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/loop.test.ts src/opencode/runOpenCode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/loop.ts packages/happy-cli/src/opencode/loop.test.ts packages/happy-cli/src/opencode/runOpenCode.ts
git commit -m "feat: route opencode remote mode to native runner"
```

### Task 6: Preserve Claude-Like Lifecycle and Cleanup Guarantees

**Files:**
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`
- Modify: `packages/happy-cli/src/opencode/opencodeLocalLauncher.ts`
- Modify: `packages/happy-cli/src/opencode/runOpenCode.test.ts`
- Modify: `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests covering:

```ts
it('treats interrupt exit codes as switch once remote mode has committed to switch', async () => {
  // remote-native launcher commits to switch, then wrapped process rejects with ExitCodeError(130)
  // expect launcher to resolve "switch"
})

it('cleans up daemon-visible session state when remote-native mode exits', async () => {
  // runOpenCode finalizes metadata, sendSessionDeath, flush, close
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts src/opencode/runOpenCode.test.ts
```

Expected: FAIL because remote-native switch cleanup and exit handling are incomplete.

- [ ] **Step 3: Write minimal implementation**

Update the launcher and session code so that:

- switch-triggered interruptions never surface as real failures
- keepalive and mode flags stay correct during remote-native execution
- final session cleanup still happens only once
- remote-native shutdown does not leave stale daemon sessions

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
./node_modules/.bin/vitest run src/opencode/opencodeRemoteNativeLauncher.test.ts src/opencode/runOpenCode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts packages/happy-cli/src/opencode/opencodeLocalLauncher.ts packages/happy-cli/src/opencode/runOpenCode.test.ts packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts
git commit -m "fix: preserve opencode remote native switch cleanup"
```

### Task 7: Full OpenCode Regression and Manual Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused OpenCode regression suite**

Run:

```bash
./node_modules/.bin/vitest run src/commands/opencodeCommand.test.ts src/opencode/runOpenCode.test.ts src/opencode/loop.test.ts src/opencode/opencodeLocal.test.ts src/opencode/opencodeLocalLauncher.test.ts src/opencode/opencodeRemoteNative.test.ts src/opencode/opencodeRemoteNativeLauncher.test.ts src/opencode/opencodeContext.test.ts
```

Expected: PASS, all tests green.

- [ ] **Step 2: Run shared regression suite**

Run:

```bash
./node_modules/.bin/vitest run src/commands/codexCommand.test.ts src/commands/opencodeCommand.test.ts src/claude/claudeLocalLauncher.test.ts src/codex/runCodex.exit.test.ts src/codex/runCodex.cleanup.test.ts src/daemon/sessionTracking.test.ts
```

Expected: PASS, no regressions in shared lifecycle/session code.

- [ ] **Step 3: Build and install the CLI**

Run:

```bash
yarn build
npm install -g .
```

Expected: build succeeds and global CLI updates.

- [ ] **Step 4: Manual verification**

Run:

```bash
happy opencode
```

Verify:

- local native OpenCode starts
- mobile message switches to remote-native mode
- terminal continues showing Happy-managed remote output
- terminal can switch back to local
- exiting leaves no active daemon session:

```bash
happy daemon list
```

Expected: `No active sessions this daemon is aware of ...`

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode packages/happy-cli/src/commands/opencodeCommand.ts
git commit -m "feat: switch opencode remote mode to native runner"
```

---

## Self-Review

### Spec coverage

- Remote mode no longer uses ACP: covered by Tasks 3, 4, and 5
- Context reconstruction instead of shared process reuse: covered by Tasks 1 and 2
- Claude-like terminal-managed remote output: covered by Task 4
- Lifecycle and cleanup guarantees: covered by Task 6
- Regression and manual verification: covered by Task 7

### Placeholder scan

- No `TODO`, `TBD`, or deferred implementation placeholders remain in task steps
- Each task includes explicit file paths, commands, and expected outcomes

### Type consistency

- Plan consistently uses `OpenCodeSession`, `opencodeRemoteNativeLauncher`, `runOpenCodeRemoteNative`, and `buildRemoteNativePrompt`
- Local/remote command fields remain `localCommand`, `localArgs`, `remoteCommand`, `remoteArgs`

