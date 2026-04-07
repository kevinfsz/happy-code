import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockRunAcp: vi.fn(),
  mockRunOpenCode: vi.fn(),
  mockAssertOpenCodeCliAvailable: vi.fn(),
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
}))

vi.mock('@/agent/acp', () => ({
  runAcp: mocks.mockRunAcp,
}))

vi.mock('@/opencode/runOpenCode', () => ({
  runOpenCode: mocks.mockRunOpenCode,
  assertOpenCodeCliAvailable: mocks.mockAssertOpenCodeCliAvailable,
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

import { handleOpencodeCommand } from './opencodeCommand'

describe('handleOpencodeCommand', () => {
  const originalProxyEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    for (const [key, value] of Object.entries(originalProxyEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockAssertOpenCodeCliAvailable.mockReturnValue(undefined)
    mocks.mockRunAcp.mockResolvedValue(undefined)
  })

  it('routes happy opencode through the OpenCode runner', async () => {
    await handleOpencodeCommand(['--started-by', 'terminal', '--verbose', '--foo'])

    expect(mocks.mockAssertOpenCodeCliAvailable).toHaveBeenCalledWith('opencode')
    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunOpenCode).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'terminal',
      verbose: true,
      localCommand: 'opencode',
      localArgs: ['--foo'],
      remoteCommand: 'opencode',
      remoteArgs: ['--foo'],
    })
    expect(
      mocks.mockAssertOpenCodeCliAvailable.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockAuthAndSetupMachineIfNeeded.mock.invocationCallOrder[0])
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunOpenCode.mock.invocationCallOrder[0])
    expect(mocks.mockRunAcp).not.toHaveBeenCalled()
  })

  it('fails before auth when the OpenCode CLI is unavailable', async () => {
    const error = new Error('OpenCode CLI is not installed')
    mocks.mockAssertOpenCodeCliAvailable.mockImplementation(() => {
      throw error
    })

    await expect(handleOpencodeCommand([])).rejects.toThrow(error)

    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
    expect(mocks.mockEnsureDaemonRunning).not.toHaveBeenCalled()
    expect(mocks.mockRunOpenCode).not.toHaveBeenCalled()
  })

  it('clears generic proxy env vars before auth and opencode startup', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:10808'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
    process.env.ALL_PROXY = 'http://127.0.0.1:10808'
    process.env.http_proxy = 'http://127.0.0.1:10808'
    process.env.https_proxy = 'http://127.0.0.1:10808'
    process.env.all_proxy = 'http://127.0.0.1:10808'

    let authSawProxyEnv: Record<string, string | undefined> | null = null
    mocks.mockAuthAndSetupMachineIfNeeded.mockImplementation(async () => {
      authSawProxyEnv = {
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        ALL_PROXY: process.env.ALL_PROXY,
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        all_proxy: process.env.all_proxy,
      }
      return { credentials: { token: 'token' } }
    })

    await handleOpencodeCommand([])

    expect(authSawProxyEnv).toEqual({
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
    })
    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    expect(process.env.ALL_PROXY).toBeUndefined()
    expect(process.env.http_proxy).toBeUndefined()
    expect(process.env.https_proxy).toBeUndefined()
    expect(process.env.all_proxy).toBeUndefined()
  })
})
