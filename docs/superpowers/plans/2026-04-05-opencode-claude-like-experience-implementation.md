# OpenCode Claude-Like Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `happy opencode` feel much closer to Claude by adding native local mode, Happy-controlled remote mode, explicit mode switching, and reliable mobile-visible lifecycle state.

**Architecture:** Replace the current direct `happy opencode -> runAcp()` path with an OpenCode-specific top-level runner and `local | remote` loop. Local mode runs native `opencode` in the terminal, remote mode wraps the existing ACP path, and both modes share one Happy session plus unified mode/lifecycle metadata.

**Tech Stack:** TypeScript, Vitest, Ink, existing Happy API/session layer, existing ACP backend, native `opencode` CLI process management.

---

### Task 1: Route `happy opencode` Through a Dedicated Runner

**Files:**
- Modify: `packages/happy-cli/src/commands/opencodeCommand.ts`
- Modify: `packages/happy-cli/src/commands/opencodeCommand.test.ts`
- Create: `packages/happy-cli/src/opencode/runOpenCode.ts`
- Create: `packages/happy-cli/src/opencode/runOpenCode.test.ts`

- [ ] **Step 1: Write the failing command-routing tests**

```ts
it('routes happy opencode through runOpenCode instead of runAcp', async () => {
  await handleOpencodeCommand(['--started-by', 'terminal', '--verbose', '--foo'])

  expect(mockRunOpenCode).toHaveBeenCalledWith({
    credentials: { token: 'token' },
    startedBy: 'terminal',
    verbose: true,
    command: 'opencode',
    args: ['acp', '--foo'],
  })
  expect(mockRunAcp).not.toHaveBeenCalled()
})

it('keeps clearing generic proxy env before auth', async () => {
  process.env.HTTP_PROXY = 'http://127.0.0.1:10808'
  await handleOpencodeCommand([])
  expect(process.env.HTTP_PROXY).toBeUndefined()
})
```

- [ ] **Step 2: Run the command-routing tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/commands/opencodeCommand.test.ts`

Expected: FAIL because `handleOpencodeCommand()` still calls `runAcp()` directly and `runOpenCode()` does not exist yet.

- [ ] **Step 3: Add the new runner entry point and switch the command handler**

```ts
// packages/happy-cli/src/commands/opencodeCommand.ts
import { runOpenCode } from '@/opencode/runOpenCode'

export async function handleOpencodeCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined
  let verbose = false
  const acpArgs = ['opencode']

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal'
      continue
    }
    if (args[i] === '--verbose') {
      verbose = true
      continue
    }
    acpArgs.push(args[i])
  }

  const resolved = resolveAcpAgentConfig(acpArgs)
  clearGenericProxyEnv()
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runOpenCode({
    credentials,
    startedBy,
    verbose,
    command: resolved.command,
    args: resolved.args,
  })
}
```

```ts
// packages/happy-cli/src/opencode/runOpenCode.ts
export async function runOpenCode(opts: {
  credentials: Credentials
  startedBy?: 'daemon' | 'terminal'
  verbose?: boolean
  command: string
  args: string[]
}): Promise<void> {
  throw new Error('Not implemented')
}
```

- [ ] **Step 4: Add a minimal runner test**

```ts
it('fails fast when opencode CLI is unavailable', async () => {
  mockExecSync.mockImplementation(() => {
    throw new Error('missing')
  })

  await expect(runOpenCode({
    credentials,
    command: 'opencode',
    args: ['acp'],
  })).rejects.toThrow('OpenCode CLI is not installed')
})
```

- [ ] **Step 5: Run the command and runner tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/commands/opencodeCommand.test.ts src/opencode/runOpenCode.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/commands/opencodeCommand.ts packages/happy-cli/src/commands/opencodeCommand.test.ts packages/happy-cli/src/opencode/runOpenCode.ts packages/happy-cli/src/opencode/runOpenCode.test.ts
git commit -m "feat: route happy opencode through dedicated runner"
```

### Task 2: Introduce Shared OpenCode Session and Mode Loop

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeSession.ts`
- Create: `packages/happy-cli/src/opencode/loop.ts`
- Create: `packages/happy-cli/src/opencode/loop.test.ts`
- Modify: `packages/happy-cli/src/opencode/runOpenCode.ts`

- [ ] **Step 1: Write the failing loop tests**

```ts
it('starts in local mode and switches to remote when local launcher returns switch', async () => {
  mockLocalLauncher.mockResolvedValueOnce({ type: 'switch' })
  mockRemoteLauncher.mockResolvedValueOnce('exit')

  const exitCode = await loopOpenCode(baseOptions)

  expect(mockLocalLauncher).toHaveBeenCalledTimes(1)
  expect(mockRemoteLauncher).toHaveBeenCalledTimes(1)
  expect(mockOnModeChange).toHaveBeenCalledWith('remote')
  expect(exitCode).toBe(0)
})

it('switches from remote back to local when remote launcher returns switch', async () => {
  mockLocalLauncher
    .mockResolvedValueOnce({ type: 'switch' })
    .mockResolvedValueOnce({ type: 'exit', code: 0 })
  mockRemoteLauncher.mockResolvedValueOnce('switch')

  const exitCode = await loopOpenCode(baseOptions)

  expect(mockOnModeChange).toHaveBeenNthCalledWith(1, 'remote')
  expect(mockOnModeChange).toHaveBeenNthCalledWith(2, 'local')
  expect(exitCode).toBe(0)
})
```

- [ ] **Step 2: Run the loop tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/opencode/loop.test.ts`

Expected: FAIL because `loopOpenCode()` and `OpenCodeSession` do not exist yet.

- [ ] **Step 3: Implement the shared session class**

```ts
export class OpenCodeSession {
  readonly api: ApiClient
  readonly client: ApiSessionClient
  readonly queue: MessageQueue2<OpenCodeMode>
  readonly path: string
  readonly logPath: string
  readonly command: string
  readonly args: string[]
  readonly verbose: boolean

  mode: 'local' | 'remote' = 'local'
  thinking = false

  private keepAliveInterval: NodeJS.Timeout

  constructor(opts: OpenCodeSessionOptions) {
    Object.assign(this, opts)
    this.keepAliveInterval = setInterval(() => {
      this.client.keepAlive(this.thinking, this.mode)
    }, 2000)
    this.client.keepAlive(this.thinking, this.mode)
  }

  onModeChange = (mode: 'local' | 'remote') => {
    this.mode = mode
    this.client.keepAlive(this.thinking, mode)
    this.client.sendSessionEvent({ type: 'switch', mode })
    this.client.updateAgentState((current) => ({
      ...current,
      controlledByUser: mode === 'local',
    }))
  }

  cleanup = () => {
    clearInterval(this.keepAliveInterval)
  }
}
```

- [ ] **Step 4: Implement the loop**

```ts
export async function loopOpenCode(opts: LoopOpenCodeOptions): Promise<number> {
  const session = new OpenCodeSession(opts.sessionOptions)
  opts.onSessionReady?.(session)

  let mode: 'local' | 'remote' = opts.startingMode ?? 'local'
  while (true) {
    if (mode === 'local') {
      const result = await opencodeLocalLauncher(session)
      if (result.type === 'switch') {
        mode = 'remote'
        opts.onModeChange(mode)
        continue
      }
      return result.code
    }

    const reason = await opencodeRemoteLauncher(session)
    if (reason === 'switch') {
      mode = 'local'
      opts.onModeChange(mode)
      continue
    }
    return 0
  }
}
```

- [ ] **Step 5: Wire `runOpenCode()` to create the session metadata and call the loop**

```ts
const exitCode = await loopOpenCode({
  startingMode: opts.startedBy === 'daemon' ? 'remote' : 'local',
  onModeChange: (mode) => {
    session.updateAgentState((currentState) => ({
      ...currentState,
      controlledByUser: mode === 'local',
    }))
  },
  sessionOptions: {
    api,
    client: session,
    path: process.cwd(),
    logPath: logger.logFilePath,
    command: opts.command,
    args: opts.args,
    verbose: Boolean(opts.verbose),
    queue: messageQueue,
  },
})
```

- [ ] **Step 6: Run the loop and runner tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/opencode/loop.test.ts src/opencode/runOpenCode.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeSession.ts packages/happy-cli/src/opencode/loop.ts packages/happy-cli/src/opencode/loop.test.ts packages/happy-cli/src/opencode/runOpenCode.ts
git commit -m "feat: add opencode session loop"
```

### Task 3: Add Native Local OpenCode Process Wrapper

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeLocal.ts`
- Create: `packages/happy-cli/src/opencode/opencodeLocal.test.ts`

- [ ] **Step 1: Write the failing local process wrapper tests**

```ts
it('spawns the native opencode CLI with inherited tty stdio', async () => {
  await opencodeLocal({
    command: 'opencode',
    args: ['--help'],
    path: '/repo',
    abort: new AbortController().signal,
  })

  expect(mockSpawn).toHaveBeenCalledWith('opencode', ['--help'], expect.objectContaining({
    cwd: '/repo',
    stdio: 'inherit',
  }))
})

it('rejects with ExitCodeError when the native process exits non-zero', async () => {
  mockSpawnExit(143)
  await expect(opencodeLocal(baseOpts)).rejects.toMatchObject({ exitCode: 143 })
})
```

- [ ] **Step 2: Run the local process tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeLocal.test.ts`

Expected: FAIL because `opencodeLocal()` does not exist yet.

- [ ] **Step 3: Implement the native process wrapper**

```ts
export class ExitCodeError extends Error {
  constructor(readonly exitCode: number) {
    super(`OpenCode exited with code ${exitCode}`)
  }
}

export async function opencodeLocal(opts: {
  command: string
  args: string[]
  path: string
  abort: AbortSignal
  env?: Record<string, string>
}): Promise<void> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.path,
    env: { ...process.env, ...opts.env },
    stdio: 'inherit',
  })

  const abortListener = () => {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  opts.abort.addEventListener('abort', abortListener, { once: true })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 0))
  })

  opts.abort.removeEventListener('abort', abortListener)
  if (exitCode !== 0) {
    throw new ExitCodeError(exitCode)
  }
}
```

- [ ] **Step 4: Run the local process tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeLocal.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeLocal.ts packages/happy-cli/src/opencode/opencodeLocal.test.ts
git commit -m "feat: add native opencode local process wrapper"
```

### Task 4: Build the Local Launcher and Mobile Takeover Semantics

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeLocalLauncher.ts`
- Create: `packages/happy-cli/src/opencode/opencodeLocalLauncher.test.ts`
- Modify: `packages/happy-cli/src/opencode/loop.ts`

- [ ] **Step 1: Write the failing local launcher tests**

```ts
it('switches to remote when a mobile message arrives during local mode', async () => {
  const launcherPromise = opencodeLocalLauncher(session)

  await vi.waitFor(() => {
    expect(session.queue.setOnMessage).toHaveBeenCalled()
  })

  triggerQueueMessage('hello from mobile')

  await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
})

it('does not overwrite switch with ExitCodeError 143 from the local process', async () => {
  mockOpenCodeLocal.mockRejectedValueOnce(new ExitCodeError(143))
  const launcherPromise = opencodeLocalLauncher(session)
  triggerQueueMessage('take over')
  await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
})

it('returns explicit exit when the native process exits normally', async () => {
  mockOpenCodeLocal.mockResolvedValueOnce(undefined)
  await expect(opencodeLocalLauncher(session)).resolves.toEqual({ type: 'exit', code: 0 })
})
```

- [ ] **Step 2: Run the local launcher tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeLocalLauncher.test.ts`

Expected: FAIL because the launcher does not exist yet.

- [ ] **Step 3: Implement the launcher**

```ts
export async function opencodeLocalLauncher(session: OpenCodeSession): Promise<{ type: 'switch' } | { type: 'exit', code: number }> {
  let exitReason: { type: 'switch' } | { type: 'exit', code: number } | null = null
  const abortController = new AbortController()

  const abort = async () => {
    if (!abortController.signal.aborted) {
      abortController.abort()
    }
  }

  const doSwitch = async () => {
    if (!exitReason) {
      exitReason = { type: 'switch' }
    }
    await abort()
  }

  session.client.rpcHandlerManager.registerHandler('switch', doSwitch)
  session.client.rpcHandlerManager.registerHandler('abort', doSwitch)
  session.queue.setOnMessage(() => {
    void doSwitch()
  })

  try {
    await opencodeLocal({
      command: session.command,
      args: session.localArgs(),
      path: session.path,
      abort: abortController.signal,
      env: session.localEnv(),
    })
    return exitReason ?? { type: 'exit', code: 0 }
  } catch (error) {
    if (error instanceof ExitCodeError && exitReason?.type === 'switch') {
      return exitReason
    }
    if (error instanceof ExitCodeError) {
      return { type: 'exit', code: error.exitCode }
    }
    throw error
  } finally {
    session.queue.setOnMessage(null)
    session.client.rpcHandlerManager.registerHandler('switch', async () => {})
    session.client.rpcHandlerManager.registerHandler('abort', async () => {})
  }
}
```

- [ ] **Step 4: Run the local launcher tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeLocalLauncher.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeLocalLauncher.ts packages/happy-cli/src/opencode/opencodeLocalLauncher.test.ts packages/happy-cli/src/opencode/loop.ts
git commit -m "feat: add opencode local launcher"
```

### Task 5: Wrap ACP Remote Mode in an OpenCode Remote Launcher

**Files:**
- Create: `packages/happy-cli/src/opencode/opencodeRemoteLauncher.ts`
- Create: `packages/happy-cli/src/opencode/opencodeRemoteLauncher.test.ts`
- Modify: `packages/happy-cli/src/agent/acp/runAcp.ts`
- Modify: `packages/happy-cli/src/opencode/loop.ts`

- [ ] **Step 1: Write the failing remote launcher tests**

```ts
it('returns switch when terminal requests switch back to local', async () => {
  mockRunAcpSession.mockResolvedValueOnce('switch')
  await expect(opencodeRemoteLauncher(session)).resolves.toBe('switch')
})

it('returns exit when remote mode exits normally', async () => {
  mockRunAcpSession.mockResolvedValueOnce('exit')
  await expect(opencodeRemoteLauncher(session)).resolves.toBe('exit')
})
```

- [ ] **Step 2: Run the remote launcher tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeRemoteLauncher.test.ts`

Expected: FAIL because the launcher and reusable ACP remote entry point do not exist yet.

- [ ] **Step 3: Refactor ACP into a reusable session-scoped entry point**

```ts
export async function runAcpSession(opts: {
  session: ApiSessionClient
  api: ApiClient
  startedBy?: 'daemon' | 'terminal'
  agentName: string
  command: string
  args: string[]
  verbose?: boolean
  path: string
  returnOnSwitch?: boolean
}): Promise<'switch' | 'exit'> {
  // move the existing body of runAcp() here
}

export async function runAcp(opts: RunAcpOptions): Promise<void> {
  await runAcpSession({
    ...opts,
    path: process.cwd(),
    returnOnSwitch: false,
  })
}
```

- [ ] **Step 4: Implement the OpenCode remote launcher on top of the reusable ACP runner**

```ts
export async function opencodeRemoteLauncher(session: OpenCodeSession): Promise<'switch' | 'exit'> {
  return runAcpSession({
    session: session.client,
    api: session.api,
    startedBy: session.startedBy,
    agentName: 'opencode',
    command: session.command,
    args: session.args,
    verbose: session.verbose,
    path: session.path,
    returnOnSwitch: true,
  })
}
```

- [ ] **Step 5: Add remote switch handling inside the ACP runner**

```ts
let exitReason: 'switch' | 'exit' = 'exit'

session.rpcHandlerManager.registerHandler('switch', async () => {
  exitReason = 'switch'
  await requestExit()
})

// ...

if (opts.returnOnSwitch && exitReason === 'switch') {
  return 'switch'
}
return 'exit'
```

- [ ] **Step 6: Run the remote launcher and ACP tests to verify they pass**

Run: `./node_modules/.bin/vitest run src/opencode/opencodeRemoteLauncher.test.ts src/agent/acp/runAcp.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/opencode/opencodeRemoteLauncher.ts packages/happy-cli/src/opencode/opencodeRemoteLauncher.test.ts packages/happy-cli/src/agent/acp/runAcp.ts packages/happy-cli/src/opencode/loop.ts
git commit -m "feat: add opencode remote launcher"
```

### Task 6: Final Lifecycle and End-to-End Regression Coverage

**Files:**
- Modify: `packages/happy-cli/src/opencode/runOpenCode.ts`
- Modify: `packages/happy-cli/src/opencode/runOpenCode.test.ts`
- Modify: `packages/happy-cli/src/agent/acp/runAcp.test.ts`
- Modify: `packages/happy-cli/src/commands/opencodeCommand.test.ts`

- [ ] **Step 1: Write the failing lifecycle regression tests**

```ts
it('updates agent state when mode changes', async () => {
  await runOpenCode(baseOpts)
  expect(mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'remote' })
  expect(mockSession.updateAgentState).toHaveBeenCalled()
})

it('signals session end immediately when opencode exits', async () => {
  await runOpenCode(baseOpts)
  expect(mockSession.sendSessionDeath).toHaveBeenCalledTimes(1)
  expect(mockSession.close).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the lifecycle regression tests to verify they fail**

Run: `./node_modules/.bin/vitest run src/opencode/runOpenCode.test.ts src/agent/acp/runAcp.test.ts`

Expected: FAIL because the full top-level OpenCode cleanup and mode synchronization are not complete yet.

- [ ] **Step 3: Complete the top-level cleanup and session metadata wiring**

```ts
try {
  const exitCode = await loopOpenCode(loopOptions)
  process.exit(exitCode)
} finally {
  openCodeSession?.cleanup()
  session.sendSessionDeath()
  await session.flush()
  await session.close()
  happyServer.stop()
}
```

```ts
session.updateMetadata((currentMetadata) => ({
  ...currentMetadata,
  lifecycleState: 'archived',
  lifecycleStateSince: Date.now(),
  archivedBy: 'cli',
  archiveReason: 'Session ended',
}))
```

- [ ] **Step 4: Run the focused regression suite**

Run: `./node_modules/.bin/vitest run src/commands/opencodeCommand.test.ts src/opencode/runOpenCode.test.ts src/opencode/loop.test.ts src/opencode/opencodeLocal.test.ts src/opencode/opencodeLocalLauncher.test.ts src/opencode/opencodeRemoteLauncher.test.ts src/agent/acp/runAcp.test.ts`

Expected: PASS

- [ ] **Step 5: Run the broader safety regression suite**

Run: `./node_modules/.bin/vitest run src/commands/codexCommand.test.ts src/commands/opencodeCommand.test.ts src/claude/claudeLocalLauncher.test.ts src/codex/runCodex.exit.test.ts src/codex/runCodex.cleanup.test.ts src/daemon/sessionTracking.test.ts src/agent/acp/runAcp.test.ts`

Expected: PASS

- [ ] **Step 6: Manual verification**

Run:

```bash
DEBUG=1 happy opencode
```

Expected:

- terminal starts in native local OpenCode mode
- mobile prompt forces switch into remote mode
- terminal switch returns to local mode
- exit from either mode removes online session from mobile/daemon

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/opencode/runOpenCode.ts packages/happy-cli/src/opencode/runOpenCode.test.ts packages/happy-cli/src/agent/acp/runAcp.test.ts packages/happy-cli/src/commands/opencodeCommand.test.ts
git commit -m "feat: add claude-like opencode mode switching"
```

## Self-Review

- Spec coverage:
  - local native mode: Task 3 and Task 4
  - mobile takeover to remote: Task 4 and Task 5
  - remote back to local: Task 2 and Task 5
  - mobile-visible mode state: Task 2 and Task 6
  - exit/reconnect/lifecycle alignment: Task 5 and Task 6
- Placeholder scan:
  - no `TODO`, `TBD`, or unspecified “handle later” work in implementation tasks
- Type consistency:
  - loop launcher contracts use `{ type: 'switch' } | { type: 'exit', code: number }` for local and `'switch' | 'exit'` for remote throughout the plan

