import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockOpenCodeLocal: vi.fn(),
}))

vi.mock('./opencodeLocal', async () => {
  const actual = await vi.importActual<typeof import('./opencodeLocal')>('./opencodeLocal')
  return {
    ...actual,
    opencodeLocal: mocks.mockOpenCodeLocal,
  }
})

import { ExitCodeError } from './opencodeLocal'
import { opencodeLocalLauncher } from './opencodeLocalLauncher'

describe('opencodeLocalLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  const makeSession = (queueSize = 0) => {
    let onMessage: ((message: string, mode: unknown) => void) | null = null
    const clientChangeCallbacks = new Set<(nextClient: unknown, previousClient: unknown) => void>()
    const initialRpcHandlerManager = makeRpcHandlerManager()
    let currentClient = {
      rpcHandlerManager: initialRpcHandlerManager,
    }
    const session = {
      path: '/repo',
      localCommand: 'opencode',
      localArgs: ['--foo'],
      queue: {
        size: vi.fn(() => queueSize),
        setOnMessage: vi.fn((handler: ((message: string, mode: unknown) => void) | null) => {
          onMessage = handler
        }),
      },
      client: currentClient,
      addClientChangeCallback: vi.fn((callback: (nextClient: unknown, previousClient: unknown) => void) => {
        clientChangeCallbacks.add(callback)
      }),
      removeClientChangeCallback: vi.fn((callback: (nextClient: unknown, previousClient: unknown) => void) => {
        clientChangeCallbacks.delete(callback)
      }),
      swapClient(nextClient: typeof currentClient) {
        const previousClient = currentClient
        currentClient = nextClient
        this.client = nextClient
        for (const callback of clientChangeCallbacks) {
          callback(nextClient, previousClient)
        }
      },
    }

    return {
      session,
      getOnMessage: () => onMessage,
      initialRpcHandlerManager,
    }
  }

  it('switches to remote when a mobile message arrives during local mode', async () => {
    const { session, getOnMessage, initialRpcHandlerManager } = makeSession()
    mocks.mockOpenCodeLocal.mockImplementation(({ abort }: { abort: AbortSignal }) => new Promise((_, reject) => {
      abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true })
    }))

    const launcherPromise = opencodeLocalLauncher(session as never)

    await vi.waitFor(() => expect(typeof getOnMessage()).toBe('function'))
    getOnMessage()?.('hello from mobile', {})

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
    expect(mocks.mockOpenCodeLocal).toHaveBeenCalledWith({
      command: 'opencode',
      args: ['--foo'],
      path: '/repo',
      abort: expect.any(AbortSignal),
    })
    expect(session.queue.setOnMessage).toHaveBeenLastCalledWith(null)
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
  })

  it('does not overwrite switch with ExitCodeError(143) from the local process', async () => {
    const { session, getOnMessage } = makeSession()
    let rejectLocal!: (error: Error) => void
    mocks.mockOpenCodeLocal.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectLocal = reject
      }),
    )

    const launcherPromise = opencodeLocalLauncher(session as never)

    await vi.waitFor(() => expect(typeof getOnMessage()).toBe('function'))
    getOnMessage()?.('switch now', {})
    rejectLocal(new ExitCodeError(143))

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
  })

  it('does not overwrite switch with other exit codes from the local process after abort', async () => {
    const { session, getOnMessage } = makeSession()
    let rejectLocal!: (error: Error) => void
    mocks.mockOpenCodeLocal.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectLocal = reject
      }),
    )

    const launcherPromise = opencodeLocalLauncher(session as never)

    await vi.waitFor(() => expect(typeof getOnMessage()).toBe('function'))
    getOnMessage()?.('switch now', {})
    rejectLocal(new ExitCodeError(130))

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
  })

  it('returns explicit exit when the native process exits normally', async () => {
    const { session } = makeSession()
    mocks.mockOpenCodeLocal.mockResolvedValue(undefined)

    await expect(opencodeLocalLauncher(session as never)).resolves.toEqual({ type: 'exit', code: 0 })
  })

  it('returns switch immediately when the queue already has messages', async () => {
    const { session } = makeSession(1)

    await expect(opencodeLocalLauncher(session as never)).resolves.toEqual({ type: 'switch' })
    expect(mocks.mockOpenCodeLocal).not.toHaveBeenCalled()
  })

  it('rebinds rpc handlers when the session client changes', async () => {
    const { session, initialRpcHandlerManager } = makeSession()
    let rejectLocal!: (error: Error) => void
    mocks.mockOpenCodeLocal.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectLocal = reject
      }),
    )

    const launcherPromise = opencodeLocalLauncher(session as never)
    const nextRpcHandlerManager = makeRpcHandlerManager()
    const nextClient = {
      rpcHandlerManager: nextRpcHandlerManager,
    }

    session.swapClient(nextClient)
    await nextRpcHandlerManager.handlers.get('switch')?.()
    rejectLocal(new ExitCodeError(143))

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' })
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(initialRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
    expect(nextRpcHandlerManager.registerHandler).toHaveBeenCalledWith('switch', expect.any(Function))
    expect(nextRpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(nextRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('switch')
    expect(nextRpcHandlerManager.unregisterHandler).toHaveBeenCalledWith('abort')
  })
})
