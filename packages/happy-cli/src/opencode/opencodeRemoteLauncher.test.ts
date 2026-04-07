import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockRunAcpSession: vi.fn(),
}))

vi.mock('@/agent/acp/runAcp', async () => {
  const actual = await vi.importActual<typeof import('@/agent/acp/runAcp')>('@/agent/acp/runAcp')
  return {
    ...actual,
    runAcpSession: mocks.mockRunAcpSession,
  }
})

import { opencodeRemoteLauncher } from './opencodeRemoteLauncher'

describe('opencodeRemoteLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const makeSession = () => ({
    client: { id: 'client' },
    api: { id: 'api' },
    remoteCommand: 'opencode',
    remoteArgs: ['acp'],
    verbose: true,
    path: '/repo',
  })

  it('returns switch when terminal requests switch back to local', async () => {
    mocks.mockRunAcpSession.mockResolvedValue('switch')

    await expect(opencodeRemoteLauncher(makeSession() as never)).resolves.toBe('switch')

    expect(mocks.mockRunAcpSession).toHaveBeenCalledWith({
      api: { id: 'api' },
      client: { id: 'client' },
      command: 'opencode',
      args: ['acp'],
      verbose: true,
      path: '/repo',
      agentName: 'opencode',
      returnOnSwitch: true,
      onClientSwap: expect.any(Function),
    })
  })

  it('returns exit when remote mode exits normally', async () => {
    mocks.mockRunAcpSession.mockResolvedValue('exit')

    await expect(opencodeRemoteLauncher(makeSession() as never)).resolves.toBe('exit')
  })

  it('unregisters the client swap handler after completion', async () => {
    let registeredHandler:
      | ((nextClient: { id: string }, previousClient: { id: string }) => void)
      | undefined
    const forwardedHandler = vi.fn()
    const session = {
      ...makeSession(),
      addClientChangeCallback: vi.fn((handler) => {
        registeredHandler = handler
      }),
      removeClientChangeCallback: vi.fn(),
    }

    mocks.mockRunAcpSession.mockImplementation(async ({ onClientSwap }) => {
      onClientSwap?.(forwardedHandler)
      registeredHandler?.({ id: 'next-client' }, { id: 'previous-client' })
      return 'exit'
    })

    await expect(opencodeRemoteLauncher(session as never)).resolves.toBe('exit')

    expect(forwardedHandler).toHaveBeenCalledWith({ id: 'next-client' })
    expect(session.addClientChangeCallback).toHaveBeenCalledTimes(1)
    expect(session.removeClientChangeCallback).toHaveBeenCalledTimes(1)
    expect(session.removeClientChangeCallback).toHaveBeenCalledWith(registeredHandler)
  })

  it('unregisters the client swap handler after errors', async () => {
    let registeredHandler:
      | ((nextClient: { id: string }, previousClient: { id: string }) => void)
      | undefined
    const session = {
      ...makeSession(),
      addClientChangeCallback: vi.fn((handler) => {
        registeredHandler = handler
      }),
      removeClientChangeCallback: vi.fn(),
    }

    mocks.mockRunAcpSession.mockImplementation(async ({ onClientSwap }) => {
      onClientSwap?.(vi.fn())
      throw new Error('runner failed')
    })

    await expect(opencodeRemoteLauncher(session as never)).rejects.toThrow('runner failed')

    expect(session.addClientChangeCallback).toHaveBeenCalledTimes(1)
    expect(session.removeClientChangeCallback).toHaveBeenCalledTimes(1)
    expect(session.removeClientChangeCallback).toHaveBeenCalledWith(registeredHandler)
  })
})
