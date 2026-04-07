import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockRunOpenCodeRemoteNative: vi.fn(),
  mockBuildRemoteNativePrompt: vi.fn(),
  mockBuildDirectReplyPrompt: vi.fn(),
}))

vi.mock('./opencodeRemoteNative', async () => {
  const actual =
    await vi.importActual<typeof import('./opencodeRemoteNative')>('./opencodeRemoteNative')
  return {
    ...actual,
    runOpenCodeRemoteNative: mocks.mockRunOpenCodeRemoteNative,
  }
})

vi.mock('./opencodeContext', () => ({
  buildRemoteNativePrompt: mocks.mockBuildRemoteNativePrompt,
  buildDirectReplyPrompt: mocks.mockBuildDirectReplyPrompt,
}))

import { ExitCodeError } from './opencodeLocal'
import { opencodeRemoteNativeLauncher } from './opencodeRemoteNativeLauncher'

describe('opencodeRemoteNativeLauncher', () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.mockRunOpenCodeRemoteNative.mockReset()
    mocks.mockBuildRemoteNativePrompt.mockReset()
    mocks.mockBuildDirectReplyPrompt.mockReset()
    mocks.mockBuildRemoteNativePrompt.mockReturnValue('reconstructed prompt')
    mocks.mockBuildDirectReplyPrompt.mockReturnValue('direct reply prompt')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    vi.useRealTimers()
  })

  const makeRpcHandlerManager = () => {
    const handlers = new Map<string, () => Promise<void> | void>()

    return {
      handlers,
      registerHandler: vi.fn((name: string, handler: () => Promise<void> | void) => {
        handlers.set(name, handler)
      }),
      unregisterHandler: vi.fn((name: string) => {
        handlers.delete(name)
      }),
    }
  }

  const makeSession = () => {
    const clientChangeCallbacks = new Set<(nextClient: unknown, previousClient: unknown) => void>()
    let currentClient = {
      rpcHandlerManager: makeRpcHandlerManager(),
      sendAgentMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
    }
    let onMessageHandler: ((message: string, mode: unknown) => void) | null = null

    return {
      session: {
        path: '/repo',
        remoteCommand: 'opencode',
        remoteArgs: ['--model', 'gpt-5'],
        buildRecentContext: vi.fn(() => ({
          recentTimeline: [
            { role: 'user' as const, content: 'user asked for help' },
            { role: 'assistant' as const, content: 'assistant reviewed files' },
          ],
          recentUserMessages: ['user asked for help'],
          recentAssistantOutput: ['assistant reviewed files'],
        })),
        queue: {
          waitForMessagesAndGetAsString: vi
            .fn()
            .mockResolvedValueOnce({
              message: 'continue',
              mode: {},
              isolate: false,
              hash: '',
            })
            .mockResolvedValue(null),
          setOnMessage: vi.fn((handler: ((message: string, mode: unknown) => void) | null) => {
            onMessageHandler = handler
          }),
        },
        client: currentClient,
        addClientChangeCallback: vi.fn((callback: (nextClient: unknown, previousClient: unknown) => void) => {
          clientChangeCallbacks.add(callback)
        }),
        removeClientChangeCallback: vi.fn((callback: (nextClient: unknown, previousClient: unknown) => void) => {
          clientChangeCallbacks.delete(callback)
        }),
        recordAssistantOutput: vi.fn(),
        swapClient(nextClient: typeof currentClient) {
          const previousClient = currentClient
          currentClient = nextClient
          this.client = nextClient
          for (const callback of clientChangeCallbacks) {
            callback(nextClient, previousClient)
          }
        },
      },
      getRpcHandlerManager: () => currentClient.rpcHandlerManager,
      getOnMessageHandler: () => onMessageHandler,
    }
  }

  it('starts remote native mode with reconstructed context and returns exit on success', async () => {
    const { session } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockResolvedValue(0)

    await expect(opencodeRemoteNativeLauncher(session as never)).resolves.toBe('exit')

    expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mocks.mockBuildRemoteNativePrompt).toHaveBeenCalledWith({
      recentTimeline: [
        { role: 'user', content: 'user asked for help' },
        { role: 'assistant', content: 'assistant reviewed files' },
      ],
      latestUserMessage: 'continue',
      workingDirectory: '/repo',
    })
    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'opencode',
        args: ['--model', 'gpt-5'],
        cwd: '/repo',
        initialPrompt: 'reconstructed prompt',
        abort: expect.any(AbortSignal),
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      }),
    )
  })

  it('falls back to a direct-reply prompt when the first remote run stalls without text output', async () => {
    const { session } = makeSession()
    mocks.mockRunOpenCodeRemoteNative
      .mockImplementationOnce(({ abort }: { abort: AbortSignal }) =>
        new Promise<number>((_, reject) => {
          abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true })
        }),
      )
      .mockImplementationOnce(({ onStdout }: { onStdout: (chunk: string) => void }) => {
        onStdout('direct fallback answer')
        return Promise.resolve(0)
      })

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)

    await vi.advanceTimersByTimeAsync(8000)

    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2))
    expect(mocks.mockRunOpenCodeRemoteNative.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        initialPrompt: 'reconstructed prompt',
      }),
    )
    expect(mocks.mockBuildDirectReplyPrompt).toHaveBeenCalledWith({
      latestUserMessage: 'continue',
      workingDirectory: '/repo',
    })
    expect(mocks.mockRunOpenCodeRemoteNative.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        initialPrompt: 'direct reply prompt',
      }),
    )

    await expect(launcherPromise).resolves.toBe('exit')
    expect(session.client.sendAgentMessage).toHaveBeenCalledWith('opencode', {
      type: 'message',
      message: 'direct fallback answer',
    })
  })

  it('forwards remote stdout/stderr through Happy-managed output and records assistant chunks', async () => {
    const { session } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(async ({ onStdout, onStderr }) => {
      onStdout('assistant chunk')
      onStderr('warning chunk')
      return 0
    })

    await expect(opencodeRemoteNativeLauncher(session as never)).resolves.toBe('exit')

    expect(session.recordAssistantOutput).toHaveBeenCalledWith('assistant chunk')
    expect(session.recordAssistantOutput).toHaveBeenCalledWith('warning chunk')
    expect(process.stdout.write).toHaveBeenCalledWith('assistant chunk')
    expect(process.stderr.write).toHaveBeenCalledWith('warning chunk')
  })

  it('streams remote-native text replies back through the opencode agent channel and marks the turn ready on completion', async () => {
    const { session } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(async ({ onStdout, onStderr }) => {
      onStdout('assistant chunk')
      onStderr(' warning chunk ')
      return 0
    })

    await expect(opencodeRemoteNativeLauncher(session as never)).resolves.toBe('exit')

    expect(session.client.sendAgentMessage).toHaveBeenCalledWith('opencode', {
      type: 'message',
      message: 'assistant chunk',
    })
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('sends streamed assistant text before the remote run finishes', async () => {
    const { session } = makeSession()
    let resolveRun: ((code: number) => void) | undefined
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(
      ({ onStdout }: { onStdout: (chunk: string) => void }) =>
        new Promise<number>((resolve) => {
          resolveRun = resolve
          onStdout('partial answer')
        }),
    )

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)

    await vi.waitFor(() =>
      expect(session.client.sendAgentMessage).toHaveBeenCalledWith('opencode', {
        type: 'message',
        message: 'partial answer',
      }),
    )
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })

    resolveRun?.(0)

    await expect(launcherPromise).resolves.toBe('exit')
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('returns switch when terminal-side switch is requested and unregisters rpc handlers', async () => {
    const { session, getRpcHandlerManager } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(
      ({ abort }: { abort: AbortSignal }) =>
        new Promise<number>((_, reject) => {
          abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true })
        }),
    )

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    const rpcHandlerManager = getRpcHandlerManager()

    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
    await rpcHandlerManager.handlers.get('switch')?.()

    await expect(launcherPromise).resolves.toBe('switch')
    expect(rpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(rpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
    expect(session.removeClientChangeCallback).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite switch with other interrupt exit codes after remote abort', async () => {
    const { session, getRpcHandlerManager } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(
      ({ abort }: { abort: AbortSignal }) =>
        new Promise<number>((_, reject) => {
          abort.addEventListener('abort', () => reject(new ExitCodeError(130)), { once: true })
        }),
    )

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    const rpcHandlerManager = getRpcHandlerManager()

    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
    await rpcHandlerManager.handlers.get('switch')?.()

    await expect(launcherPromise).resolves.toBe('switch')
  })

  it('rebinds rpc handlers when the session client changes during remote mode', async () => {
    const { session, getRpcHandlerManager } = makeSession()
    mocks.mockRunOpenCodeRemoteNative.mockImplementation(
      ({ abort }: { abort: AbortSignal }) =>
        new Promise<number>((_, reject) => {
          abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true })
        }),
    )

    const initialRpcHandlerManager = getRpcHandlerManager()
    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    const nextRpcHandlerManager = makeRpcHandlerManager()
    const nextClient = {
      rpcHandlerManager: nextRpcHandlerManager,
      sendAgentMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
    }

    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
    session.swapClient(nextClient)
    await nextRpcHandlerManager.handlers.get('switch')?.()

    await expect(launcherPromise).resolves.toBe('switch')
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
    expect(nextRpcHandlerManager.registerHandler).toHaveBeenCalledWith('switch', expect.any(Function))
    expect(nextRpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(nextRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(nextRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
  })

  it('starts a second native run when a later mobile message arrives after the first run completes', async () => {
    const { session } = makeSession()
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockResolvedValueOnce({ message: 'first mobile message', mode: {}, isolate: false, hash: 'one' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ message: 'second mobile message', mode: {}, isolate: false, hash: 'two' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0).mockResolvedValueOnce(0)

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

  it('aborts the active native run and restarts with newer mobile input', async () => {
    const { session } = makeSession()
    let resolveThirdWait:
      | ((value: { message: string; mode: {}; isolate: boolean; hash: string } | null) => void)
      | undefined
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ message: 'stale prompt', mode: {}, isolate: false, hash: 'one' }),
      )
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveThirdWait = resolve
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
    resolveThirdWait?.({
      message: 'fresh mobile message',
      mode: {},
      isolate: false,
      hash: 'two',
    })

    await expect(launcherPromise).resolves.toBe('exit')
    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2)
    expect(mocks.mockBuildRemoteNativePrompt.mock.calls[1]?.[0]).toMatchObject({
      latestUserMessage: 'fresh mobile message',
    })
  })

  it('coalesces bursty mobile messages into one native run', async () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockResolvedValueOnce({ message: 'line one', mode: {}, isolate: false, hash: 'one' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ message: 'line two', mode: {}, isolate: false, hash: 'one' })
            }, 100)
          }),
      )
      .mockResolvedValueOnce(null)
    mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0)

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))

    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1)
    expect(mocks.mockBuildRemoteNativePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        latestUserMessage: expect.stringContaining('line one'),
      }),
    )
    expect(mocks.mockBuildRemoteNativePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        latestUserMessage: expect.stringContaining('line one\nline two'),
      }),
    )
    await expect(launcherPromise).resolves.toBe('exit')
  })

  it('restarts after an interrupting kill exit when fresher mobile input arrives', async () => {
    const { session } = makeSession()
    let resolveThirdWait:
      | ((value: { message: string; mode: {}; isolate: boolean; hash: string } | null) => void)
      | undefined
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({ message: 'stale prompt', mode: {}, isolate: false, hash: 'one' }),
      )
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveThirdWait = resolve
      }))
      .mockImplementationOnce(() => Promise.resolve(null))

    mocks.mockRunOpenCodeRemoteNative.mockImplementationOnce(({ abort }: { abort: AbortSignal }) =>
      new Promise<number>((_, reject) => {
        abort.addEventListener('abort', () => reject(new ExitCodeError(137)), { once: true })
      }),
    )
    mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0)

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)

    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
    resolveThirdWait?.({
      message: 'fresh mobile message',
      mode: {},
      isolate: false,
      hash: 'two',
    })

    await expect(launcherPromise).resolves.toBe('exit')
    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2)
    expect(mocks.mockBuildRemoteNativePrompt.mock.calls[1]?.[0]).toMatchObject({
      latestUserMessage: 'fresh mobile message',
    })
  })

  it('does not merge an isolated batch into the current coalesced prompt', async () => {
    vi.useFakeTimers()
    const { session } = makeSession()
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockResolvedValueOnce({ message: 'line one', mode: {}, isolate: false, hash: 'one' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ message: 'isolated line', mode: {}, isolate: true, hash: 'one' })
            }, 100)
          }),
      )
      .mockResolvedValueOnce(null)
    mocks.mockRunOpenCodeRemoteNative.mockResolvedValueOnce(0).mockResolvedValueOnce(0)

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    await vi.advanceTimersByTimeAsync(100)

    await expect(launcherPromise).resolves.toBe('exit')
    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(2)
    expect(mocks.mockBuildRemoteNativePrompt.mock.calls[0]?.[0]).toMatchObject({
      latestUserMessage: 'line one',
    })
    expect(mocks.mockBuildRemoteNativePrompt.mock.calls[1]?.[0]).toMatchObject({
      latestUserMessage: 'isolated line',
    })
  })

  it('returns switch instead of restarting when terminal switch wins the race', async () => {
    const { session, getRpcHandlerManager, getOnMessageHandler } = makeSession()
    session.queue.waitForMessagesAndGetAsString = vi
      .fn()
      .mockResolvedValueOnce({ message: 'first turn', mode: {}, isolate: false, hash: 'one' })
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise(() => {}))
    mocks.mockRunOpenCodeRemoteNative.mockImplementationOnce(({ abort }: { abort: AbortSignal }) =>
      new Promise<number>((_, reject) => {
        abort.addEventListener(
          'abort',
          () => {
            reject(new ExitCodeError(143))
          },
          { once: true },
        )
      }),
    )

    const launcherPromise = opencodeRemoteNativeLauncher(session as never)
    await vi.waitFor(() => expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1))
    expect(typeof getOnMessageHandler()).toBe('function')
    getOnMessageHandler()?.('new mobile input', {})
    await getRpcHandlerManager().handlers.get('switch')?.()

    await expect(launcherPromise).resolves.toBe('switch')
    expect(mocks.mockRunOpenCodeRemoteNative).toHaveBeenCalledTimes(1)
  })
})
