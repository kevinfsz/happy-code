import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.useFakeTimers()

const makeClient = () => ({
  keepAlive: vi.fn(),
  sendSessionEvent: vi.fn(),
  updateAgentState: vi.fn(),
})

describe('loopOpenCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('starts in local mode and switches to remote when the local launcher returns switch', async () => {
    const localLauncher = vi.fn().mockResolvedValue({ type: 'switch' as const })
    const remoteLauncher = vi.fn().mockResolvedValue('exit' as const)
    const onModeChange = vi.fn()
    const onSessionReady = vi.fn()

    const { loopOpenCode } = await import('./loop')

    await expect(
      loopOpenCode({
        path: '/tmp/project',
        logPath: '/tmp/opencode.log',
        localCommand: 'opencode',
        localArgs: [],
        remoteCommand: 'opencode',
        remoteArgs: ['acp'],
        verbose: false,
        api: {} as never,
        client: { keepAlive: vi.fn(), sendSessionEvent: vi.fn(), updateAgentState: vi.fn() } as never,
        queue: { push: vi.fn() } as never,
        onModeChange,
        onSessionReady,
        launchers: {
          local: localLauncher,
          remote: remoteLauncher,
        },
      }),
    ).resolves.toBe(0)

    expect(onSessionReady).toHaveBeenCalledTimes(1)
    expect(localLauncher).toHaveBeenCalledTimes(1)
    expect(remoteLauncher).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenCalledWith('remote')
  })

  it('switches from remote back to local when the remote launcher returns switch', async () => {
    const localLauncher = vi.fn().mockResolvedValue({ type: 'exit' as const, code: 7 })
    const remoteLauncher = vi.fn().mockResolvedValue('switch' as const)
    const onModeChange = vi.fn()
    const onSessionReady = vi.fn()
    const client = makeClient()

    const { loopOpenCode } = await import('./loop')

    await expect(
      loopOpenCode({
        path: '/tmp/project',
        logPath: '/tmp/opencode.log',
        localCommand: 'opencode',
        localArgs: [],
        remoteCommand: 'opencode',
        remoteArgs: ['acp'],
        verbose: false,
        startingMode: 'remote',
        api: {} as never,
        client: client as never,
        queue: { push: vi.fn() } as never,
        onModeChange,
        onSessionReady,
        launchers: {
          local: localLauncher,
          remote: remoteLauncher,
        },
      }),
    ).resolves.toBe(7)

    expect(onSessionReady).toHaveBeenCalledTimes(1)
    expect(remoteLauncher).toHaveBeenCalledTimes(1)
    expect(localLauncher).toHaveBeenCalledTimes(1)
    expect(client.keepAlive.mock.calls[0]).toEqual([false, 'remote'])
    expect(onModeChange).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenCalledWith('local')
  })

  it('creates a shared OpenCode session with keepAlive and cleanup plumbing', async () => {
    const client = makeClient()
    const localLauncher = vi.fn().mockResolvedValue({ type: 'exit' as const, code: 0 })
    const onSessionReady = vi.fn()

    const { loopOpenCode } = await import('./loop')

    await loopOpenCode({
      path: '/tmp/project',
      logPath: '/tmp/opencode.log',
      localCommand: 'opencode',
      localArgs: ['--model', 'gpt-5'],
      remoteCommand: 'opencode',
      remoteArgs: ['acp', '--model', 'gpt-5'],
      verbose: true,
      api: {} as never,
      client: client as never,
      queue: { push: vi.fn() } as never,
      onModeChange: vi.fn(),
      onSessionReady,
      launchers: {
        local: localLauncher,
        remote: vi.fn(),
      },
    })

    expect(client.keepAlive).toHaveBeenCalledWith(false, 'local')
    expect(onSessionReady).toHaveBeenCalledTimes(1)
    expect(onSessionReady.mock.calls[0]?.[0]).toMatchObject({
      path: '/tmp/project',
      logPath: '/tmp/opencode.log',
      localCommand: 'opencode',
      localArgs: ['--model', 'gpt-5'],
      remoteCommand: 'opencode',
      remoteArgs: ['acp', '--model', 'gpt-5'],
      verbose: true,
      mode: 'local',
      thinking: false,
    })
  })

  it('uses the remote native launcher by default instead of the ACP launcher', async () => {
    const mockLocalLauncher = vi.fn().mockResolvedValue({ type: 'switch' as const })
    const mockRemoteNativeLauncher = vi.fn().mockResolvedValue('exit' as const)
    const mockRemoteAcpLauncher = vi.fn().mockImplementation(() => {
      throw new Error('ACP remote launcher should not be used')
    })

    vi.doMock('./opencodeLocalLauncher', () => ({
      opencodeLocalLauncher: mockLocalLauncher,
    }))
    vi.doMock('./opencodeRemoteNativeLauncher', () => ({
      opencodeRemoteNativeLauncher: mockRemoteNativeLauncher,
    }))
    vi.doMock('./opencodeRemoteLauncher', () => ({
      opencodeRemoteLauncher: mockRemoteAcpLauncher,
    }))

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
        api: {} as never,
        client: makeClient() as never,
        queue: { push: vi.fn() } as never,
      }),
    ).resolves.toBe(0)

    expect(mockLocalLauncher).toHaveBeenCalledTimes(1)
    expect(mockRemoteNativeLauncher).toHaveBeenCalledTimes(1)
    expect(mockRemoteAcpLauncher).not.toHaveBeenCalled()

    vi.doUnmock('./opencodeLocalLauncher')
    vi.doUnmock('./opencodeRemoteNativeLauncher')
    vi.doUnmock('./opencodeRemoteLauncher')
  })
})

describe('OpenCodeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends keepAlive immediately, repeats on interval, updates mode state, and stops after cleanup', async () => {
    const client = makeClient()
    const { OpenCodeSession } = await import('./opencodeSession')

    const session = new OpenCodeSession({
      api: {} as never,
      client: client as never,
      queue: { push: vi.fn() } as never,
      path: '/tmp/project',
      logPath: '/tmp/opencode.log',
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: ['acp'],
      verbose: true,
    })

    expect(client.keepAlive).toHaveBeenCalledTimes(1)
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'local')

    vi.advanceTimersByTime(2000)
    expect(client.keepAlive).toHaveBeenCalledTimes(2)
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'local')

    session.onModeChange('remote')
    expect(client.keepAlive).toHaveBeenCalledTimes(3)
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'remote')
    expect(client.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'remote' })

    const remoteStateUpdater = client.updateAgentState.mock.calls[0]?.[0]
    expect(remoteStateUpdater({ controlledByUser: true, other: 'value' })).toEqual({
      controlledByUser: false,
      other: 'value',
    })

    session.onModeChange('local')
    expect(client.keepAlive).toHaveBeenCalledTimes(4)
    expect(client.keepAlive).toHaveBeenLastCalledWith(false, 'local')
    expect(client.sendSessionEvent).toHaveBeenLastCalledWith({ type: 'switch', mode: 'local' })

    const localStateUpdater = client.updateAgentState.mock.calls[1]?.[0]
    expect(localStateUpdater({ controlledByUser: false, other: 'value' })).toEqual({
      controlledByUser: true,
      other: 'value',
    })

    session.cleanup()
    vi.advanceTimersByTime(4000)
    expect(client.keepAlive).toHaveBeenCalledTimes(4)
  })

  it('switches subsequent keepAlive traffic to a reconnected client', async () => {
    const initialClient = makeClient()
    const reconnectedClient = makeClient()
    const { OpenCodeSession } = await import('./opencodeSession')

    const session = new OpenCodeSession({
      api: {} as never,
      client: initialClient as never,
      queue: { push: vi.fn() } as never,
      path: '/tmp/project',
      logPath: '/tmp/opencode.log',
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: ['acp'],
      verbose: false,
    })

    session.updateClient(reconnectedClient as never)
    session.onModeChange('remote')

    expect(reconnectedClient.keepAlive).toHaveBeenNthCalledWith(1, false, 'local')
    expect(reconnectedClient.keepAlive).toHaveBeenNthCalledWith(2, false, 'remote')
    expect(reconnectedClient.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'remote' })
    expect(initialClient.sendSessionEvent).not.toHaveBeenCalled()

    session.cleanup()
  })

  it('records recent user and assistant messages in their original order', async () => {
    const { OpenCodeSession } = await import('./opencodeSession')
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
    session.recordUserMessage('follow-up question')
    session.recordAssistantOutput('second answer')

    expect(session.buildRecentContext()).toEqual({
      recentTimeline: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'partial answer' },
        { role: 'user', content: 'follow-up question' },
        { role: 'assistant', content: 'second answer' },
      ],
      recentUserMessages: ['first prompt', 'follow-up question'],
      recentAssistantOutput: ['partial answer', 'second answer'],
    })

    session.cleanup()
  })

  it('truncates buffered context to the configured caps while preserving the timeline order', async () => {
    const { OpenCodeSession } = await import('./opencodeSession')
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

    for (let i = 0; i < 45; i++) {
      session.recordUserMessage(`user-${i}`)
      session.recordAssistantOutput(`assistant-${i}`)
    }

    const recentContext = session.buildRecentContext()

    expect(recentContext.recentUserMessages).toEqual(
      Array.from({ length: 20 }, (_, offset) => `user-${offset + 25}`),
    )
    expect(recentContext.recentAssistantOutput).toEqual(
      Array.from({ length: 40 }, (_, offset) => `assistant-${offset + 5}`),
    )
    expect(recentContext.recentTimeline).toHaveLength(60)
    expect(recentContext.recentTimeline[0]).toEqual({ role: 'assistant', content: 'assistant-5' })
    expect(recentContext.recentTimeline[1]).toEqual({ role: 'assistant', content: 'assistant-6' })
    expect(recentContext.recentTimeline[19]).toEqual({ role: 'assistant', content: 'assistant-24' })
    expect(recentContext.recentTimeline[20]).toEqual({ role: 'user', content: 'user-25' })
    expect(recentContext.recentTimeline[21]).toEqual({ role: 'assistant', content: 'assistant-25' })
    expect(recentContext.recentTimeline.at(-1)).toEqual({ role: 'assistant', content: 'assistant-44' })

    session.cleanup()
  })
})
