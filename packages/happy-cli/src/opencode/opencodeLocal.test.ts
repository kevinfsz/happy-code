import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.useFakeTimers()

const mocks = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: mocks.mockSpawn,
}))

class MockAbortSignal {
  public aborted = false
  public readonly addEventListener = vi.fn()
  public readonly removeEventListener = vi.fn()
}

import { ExitCodeError, opencodeLocal } from './opencodeLocal'

describe('opencodeLocal', () => {
  let abort: AbortSignal
  const child = {
    on: vi.fn(),
    kill: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    abort = new MockAbortSignal() as unknown as AbortSignal
    mocks.mockSpawn.mockReturnValue(child)
    child.on.mockImplementation(() => child)
    child.kill.mockReturnValue(true)
    process.env = {
      HAPPY_TEST_ENV: 'from-process',
      HAPPY_PROCESS_ONLY: 'process-only',
    } as NodeJS.ProcessEnv
  })

  it('spawns the native opencode CLI with inherited TTY stdio', async () => {
    const promise = opencodeLocal({
      abort,
      path: '/repo',
      command: 'opencode',
      args: ['acp', '--foo'],
      env: {
        HAPPY_TEST_ENV: 'from-opts',
        OPENCODE_FLAG: '1',
      },
    })

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null) => void)
      | undefined
    expect(exitHandler).toBeTypeOf('function')

    exitHandler?.(0)
    await expect(promise).resolves.toBeUndefined()

    expect(mocks.mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['acp', '--foo'],
      expect.objectContaining({
        cwd: '/repo',
        stdio: 'inherit',
        env: expect.objectContaining({
          HAPPY_PROCESS_ONLY: 'process-only',
          HAPPY_TEST_ENV: 'from-opts',
          OPENCODE_FLAG: '1',
        }),
      }),
    )
    expect(abort.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(abort.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('rejects with ExitCodeError when the native process exits non-zero', async () => {
    const promise = opencodeLocal({
      abort,
      path: '/repo',
      command: 'opencode',
      args: [],
    })

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null) => void)
      | undefined
    exitHandler?.(2)

    await expect(promise).rejects.toBeInstanceOf(ExitCodeError)
    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 2',
      exitCode: 2,
    })
  })

  it('rejects with ExitCodeError when aborted via SIGTERM', async () => {
    const signalHandlers: Array<() => void> = []
    ;(abort.addEventListener as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, handler: () => void) => {
        signalHandlers.push(handler)
      },
    )

    const promise = opencodeLocal({
      abort,
      path: '/repo',
      command: 'opencode',
      args: [],
    })

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null, signal?: NodeJS.Signals | null) => void)
      | undefined

    expect(signalHandlers).toHaveLength(1)
    signalHandlers[0]()
    exitHandler?.(null, 'SIGTERM')

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 143',
      exitCode: 143,
    })
  })

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const signalHandlers: Array<() => void> = []
    ;(abort.addEventListener as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, handler: () => void) => {
        signalHandlers.push(handler)
      },
    )

    const promise = opencodeLocal({
      abort,
      path: '/repo',
      command: 'opencode',
      args: [],
    })

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null, signal?: NodeJS.Signals | null) => void)
      | undefined

    signalHandlers[0]()
    vi.advanceTimersByTime(1000)
    exitHandler?.(null, 'SIGKILL')

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 137',
      exitCode: 137,
    })
  })

  it('aborts immediately when the signal is already aborted', async () => {
    const immediateAbort = new MockAbortSignal()
    immediateAbort.aborted = true

    const promise = opencodeLocal({
      abort: immediateAbort as unknown as AbortSignal,
      path: '/repo',
      command: 'opencode',
      args: [],
    })

    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null, signal?: NodeJS.Signals | null) => void)
      | undefined

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    exitHandler?.(null, 'SIGTERM')

    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 143',
      exitCode: 143,
    })
  })
})
