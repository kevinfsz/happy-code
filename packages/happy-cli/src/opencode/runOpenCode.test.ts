import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockApiCreate: vi.fn(),
  mockReadSettings: vi.fn(),
  mockCreateSessionMetadata: vi.fn(),
  mockSetupOfflineReconnection: vi.fn(),
  mockNotifyDaemonSessionStarted: vi.fn(),
  mockLoopOpenCode: vi.fn(),
  mockSetBackend: vi.fn(),
  mockMessageQueueCtor: vi.fn(),
  mockQueuePush: vi.fn(),
}))

const makeClient = () => ({
  keepAlive: vi.fn(),
  sendSessionEvent: vi.fn(),
  updateAgentState: vi.fn(),
})

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: mocks.mockExecFileSync,
  }
})

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}))

vi.mock('@/persistence', () => ({
  readSettings: mocks.mockReadSettings,
}))

vi.mock('@/utils/createSessionMetadata', () => ({
  createSessionMetadata: mocks.mockCreateSessionMetadata,
}))

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}))

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}))

vi.mock('./loop', () => ({
  loopOpenCode: mocks.mockLoopOpenCode,
}))

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    logFilePath: '/tmp/opencode.log',
  },
}))

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: { platform: 'test' },
}))

vi.mock('@/utils/MessageQueue2', () => ({
  MessageQueue2: vi.fn().mockImplementation(function MessageQueue2(
    this: { hasher?: (value: unknown) => string, push?: typeof mocks.mockQueuePush },
    hasher: (value: unknown) => string,
  ) {
    mocks.mockMessageQueueCtor(hasher)
    this.hasher = hasher
    this.push = mocks.mockQueuePush
  }),
}))

import { runOpenCode } from './runOpenCode'
import type { OpenCodeSession } from './opencodeSession'

describe('runOpenCode', () => {
  const mockResponse = { id: 'session-123' }
  const mockReconnectionHandle = { cancel: vi.fn() }
  const mockSessionClient = {
    keepAlive: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateAgentState: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    onUserMessage: vi.fn(),
  }
  const mockApiClient = {
    getOrCreateMachine: vi.fn(),
    getOrCreateSession: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mocks.mockExecFileSync.mockReturnValue('opencode 1.0.0')
    mocks.mockReadSettings.mockResolvedValue({ machineId: 'machine-123' })
    mocks.mockCreateSessionMetadata.mockImplementation(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/repo', flavor: 'opencode' },
    }))
    mocks.mockApiCreate.mockResolvedValue(mockApiClient)
    mockApiClient.getOrCreateMachine.mockResolvedValue(undefined)
    mockApiClient.getOrCreateSession.mockResolvedValue(mockResponse)
    mocks.mockSetupOfflineReconnection.mockReturnValue({
      session: mockSessionClient,
      reconnectionHandle: mockReconnectionHandle,
    })
    mocks.mockNotifyDaemonSessionStarted.mockResolvedValue(undefined)
    mocks.mockLoopOpenCode.mockResolvedValue(0)
    mockSessionClient.updateMetadata.mockReturnValue(undefined)
    mockSessionClient.keepAlive.mockReturnValue(undefined)
    mockSessionClient.sendSessionEvent.mockReturnValue(undefined)
    mockSessionClient.updateAgentState.mockReturnValue(undefined)
    mockSessionClient.sendSessionDeath.mockReturnValue(undefined)
    mockSessionClient.flush.mockResolvedValue(undefined)
    mockSessionClient.close.mockResolvedValue(undefined)
    mockSessionClient.onUserMessage.mockReturnValue(undefined)
    mockReconnectionHandle.cancel.mockReturnValue(undefined)
  })

  it('fails fast when the OpenCode CLI is unavailable', async () => {
    const error = new Error('spawn opencode ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    mocks.mockExecFileSync.mockImplementation(() => {
      throw error
    })

    await expect(
      runOpenCode({
        credentials: {
          token: 'token',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array(),
          },
        },
        localCommand: 'opencode',
        localArgs: [],
        remoteCommand: 'opencode',
        remoteArgs: ['acp'],
      }),
    ).rejects.toThrow('OpenCode CLI is not installed')
    expect(mocks.mockApiCreate).not.toHaveBeenCalled()
  })

  it('rethrows non-ENOENT startup errors unchanged', async () => {
    const error = new Error('spawn opencode EACCES') as NodeJS.ErrnoException
    error.code = 'EACCES'
    mocks.mockExecFileSync.mockImplementation(() => {
      throw error
    })

    await expect(
      runOpenCode({
        credentials: {
          token: 'token',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array(),
          },
        },
        localCommand: 'opencode',
        localArgs: [],
        remoteCommand: 'opencode',
        remoteArgs: ['acp'],
      }),
    ).rejects.toThrow(error)
    expect(mocks.mockApiCreate).not.toHaveBeenCalled()
  })

  it('creates a shared local-mode session and runs the OpenCode loop for terminal starts', async () => {
    const exitCode = await runOpenCode({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
      verbose: true,
      localCommand: 'opencode',
      localArgs: ['--foo'],
      remoteCommand: 'opencode',
      remoteArgs: ['acp', '--foo'],
    })

    expect(exitCode).toBe(0)
    expect(mocks.mockSetBackend).toHaveBeenCalledWith('opencode')
    expect(mocks.mockApiCreate).toHaveBeenCalledTimes(1)
    expect(mockApiClient.getOrCreateMachine).toHaveBeenCalledWith({
      machineId: 'machine-123',
      metadata: { platform: 'test' },
    })
    expect(mocks.mockCreateSessionMetadata).toHaveBeenCalledWith({
      flavor: 'opencode',
      machineId: 'machine-123',
      startedBy: undefined,
    })
    expect(mockApiClient.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { path: '/repo', flavor: 'opencode' },
        state: { controlledByUser: true },
      }),
    )
    expect(mocks.mockNotifyDaemonSessionStarted).toHaveBeenCalledWith('session-123', {
      path: '/repo',
      flavor: 'opencode',
    })
    expect(mocks.mockLoopOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        path: process.cwd(),
        logPath: '/tmp/opencode.log',
        localCommand: 'opencode',
        localArgs: ['--foo'],
        remoteCommand: 'opencode',
        remoteArgs: ['acp', '--foo'],
        verbose: true,
        startingMode: 'local',
        api: mockApiClient,
        client: mockSessionClient,
        queue: expect.any(Object),
      }),
    )
    expect(mockSessionClient.updateMetadata).toHaveBeenCalledTimes(1)
    expect(mockSessionClient.sendSessionDeath).toHaveBeenCalledTimes(1)
    expect(mockSessionClient.flush).toHaveBeenCalledTimes(1)
    expect(mockSessionClient.close).toHaveBeenCalledTimes(1)
    expect(mockReconnectionHandle.cancel).toHaveBeenCalledTimes(1)
  })

  it('starts the shared session in remote mode when launched by the daemon', async () => {
    await runOpenCode({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
      startedBy: 'daemon',
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: ['acp'],
    })

    expect(mockApiClient.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { controlledByUser: false },
      }),
    )
    expect(mocks.mockLoopOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        startingMode: 'remote',
      }),
    )
  })

  it('updates the shared OpenCode session when offline reconnection swaps the session client', async () => {
    const swappedSessionClient = {
      updateMetadata: vi.fn(),
      sendSessionDeath: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onUserMessage: vi.fn(),
    }
    let onSessionSwap: ((client: unknown) => void) | null = null
    mocks.mockSetupOfflineReconnection.mockImplementation((opts: { onSessionSwap: (client: unknown) => void }) => {
      onSessionSwap = opts.onSessionSwap
      return {
        session: mockSessionClient,
        reconnectionHandle: mockReconnectionHandle,
      }
    })
    mocks.mockLoopOpenCode.mockImplementation(async (opts: {
      onSessionReady?: (session: { client: unknown; updateClient: (client: unknown) => void }) => void
    }) => {
      const sessionInstance = {
        client: mockSessionClient,
        updateClient: vi.fn(),
      }
      opts.onSessionReady?.(sessionInstance)
      onSessionSwap?.(swappedSessionClient)

      expect(sessionInstance.updateClient).toHaveBeenCalledWith(swappedSessionClient)
      return 0
    })

    await runOpenCode({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: ['acp'],
    })

    expect(swappedSessionClient.onUserMessage).toHaveBeenCalledTimes(1)
    expect(swappedSessionClient.updateMetadata).toHaveBeenCalledTimes(1)
    expect(swappedSessionClient.sendSessionDeath).toHaveBeenCalledTimes(1)
    expect(swappedSessionClient.flush).toHaveBeenCalledTimes(1)
    expect(swappedSessionClient.close).toHaveBeenCalledTimes(1)
  })

  it('forwards user messages into the shared queue', async () => {
    type UserMessageHandler = (message: { content: { text?: string } }) => void

    let onUserMessage: UserMessageHandler | null = null
    mockSessionClient.onUserMessage.mockImplementation((handler: UserMessageHandler) => {
      onUserMessage = handler
    })

    await runOpenCode({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: ['acp'],
    })

    expect(onUserMessage).not.toBeNull()
    if (!onUserMessage) {
      throw new Error('expected onUserMessage handler to be registered')
    }

    const handler: UserMessageHandler = onUserMessage
    handler({ content: { text: 'hello from mobile' } })
    handler({ content: {} })

    expect(mockSessionClient.onUserMessage).toHaveBeenCalledTimes(1)
    expect(mocks.mockQueuePush).toHaveBeenCalledTimes(1)
    expect(mocks.mockQueuePush).toHaveBeenCalledWith('hello from mobile', {})
  })

  it('records forwarded mobile messages in the shared OpenCode session context', async () => {
    type UserMessageHandler = (message: { content: { text?: string } }) => void

    let onUserMessage: UserMessageHandler | null = null
    let sessionContext: OpenCodeSession | null = null

    mockSessionClient.onUserMessage.mockImplementation((handler: UserMessageHandler) => {
      onUserMessage = handler
    })

    mocks.mockLoopOpenCode.mockImplementation(async ({ onSessionReady }) => {
      const { OpenCodeSession } = await import('./opencodeSession')
      const session = new OpenCodeSession({
        api: {} as never,
        client: mockSessionClient as never,
        queue: { push: mocks.mockQueuePush } as never,
        path: '/repo',
        logPath: '/tmp/opencode.log',
        localCommand: 'opencode',
        localArgs: [],
        remoteCommand: 'opencode',
        remoteArgs: [],
        verbose: false,
      })
      onSessionReady?.(session)
      sessionContext = session
      return 0
    })

    await runOpenCode({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
      localCommand: 'opencode',
      localArgs: [],
      remoteCommand: 'opencode',
      remoteArgs: [],
    })

    if (!onUserMessage || !sessionContext) {
      throw new Error('expected mobile message handler and session context')
    }

    const handler = onUserMessage as UserMessageHandler
    handler({ content: { text: 'hello from mobile' } })

    expect((sessionContext as OpenCodeSession).buildRecentContext()).toMatchObject({
      recentTimeline: [{ role: 'user', content: 'hello from mobile' }],
      recentUserMessages: ['hello from mobile'],
    })
  })
})

describe('OpenCodeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records recent user messages for later remote reconstruction', async () => {
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

    expect(session.buildRecentContext()).toEqual({
      recentTimeline: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'partial answer' },
      ],
      recentUserMessages: ['first prompt'],
      recentAssistantOutput: ['partial answer'],
    })

    session.cleanup()
  })
})
