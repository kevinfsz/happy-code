import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { ExitCodeError } from './opencodeLocal'
import { runOpenCodeRemoteNative } from './opencodeRemoteNative'

describe('runOpenCodeRemoteNative', () => {
  let abort: AbortSignal
  const originalEnv = process.env
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    abort = new MockAbortSignal() as unknown as AbortSignal
    mocks.mockSpawn.mockReturnValue(child)
    child.on.mockImplementation(() => child)
    child.stdout.on.mockImplementation(() => child.stdout)
    child.stderr.on.mockImplementation(() => child.stderr)
    child.kill.mockReturnValue(true)
    process.env = {
      HAPPY_REMOTE_ONLY: 'from-process',
    } as NodeJS.ProcessEnv
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('spawns opencode run in json mode and forwards only assistant text events', async () => {
    const onStdout = vi.fn()
    const onStderr = vi.fn()

    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: ['--model', 'gpt-5'],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout,
      onStderr,
      abort,
    })

    const stdoutHandler = child.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined
    const stderrHandler = child.stderr.on.mock.calls.find(([event]) => event === 'data')?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined
    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null) => void)
      | undefined

    stdoutHandler?.(
      Buffer.from(
        [
          JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
          JSON.stringify({ type: 'tool_use', part: { type: 'tool' } }),
          JSON.stringify({ type: 'text', part: { type: 'text', text: 'assistant chunk' } }),
        ].join('\n') + '\n',
      ),
    )
    stderrHandler?.(Buffer.from('stderr chunk'))
    closeHandler?.(0)

    await expect(promise).resolves.toBe(0)
    expect(mocks.mockSpawn).toHaveBeenCalledWith(
      'opencode',
      [
        '--print-logs',
        '--log-level',
        'ERROR',
        'run',
        '--format',
        'json',
        '--model',
        'gpt-5',
        'Continue the task',
      ],
      expect.objectContaining({
        cwd: '/repo',
        stdio: 'pipe',
        env: expect.objectContaining({
          HAPPY_REMOTE_ONLY: 'from-process',
          CI: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
          OPENCODE_DISABLE_MODELS_FETCH: '1',
        }),
      }),
    )
    expect(child.stdin.write).not.toHaveBeenCalled()
    expect(child.stdin.end).not.toHaveBeenCalled()
    expect(onStdout).toHaveBeenCalledWith('assistant chunk')
    expect(onStderr).toHaveBeenCalledWith('stderr chunk')
  })

  it('rejects with ExitCodeError when the native process exits non-zero', async () => {
    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      abort,
    })

    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null) => void)
      | undefined
    closeHandler?.(7)

    await expect(promise).rejects.toBeInstanceOf(ExitCodeError)
    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 7',
      exitCode: 7,
    })
  })

  it('aborts with SIGTERM and escalates to SIGKILL if needed', async () => {
    const signalHandlers: Array<() => void> = []
    ;(abort.addEventListener as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, handler: () => void) => {
        signalHandlers.push(handler)
      },
    )

    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      abort,
    })

    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null, signal?: NodeJS.Signals | null) => void)
      | undefined

    signalHandlers[0]()
    vi.advanceTimersByTime(1000)
    closeHandler?.(null, 'SIGKILL')

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 137',
      exitCode: 137,
    })
  })

  it('does not try to stream the initial prompt through stdin when the signal is already aborted', async () => {
    const immediateAbort = new MockAbortSignal()
    immediateAbort.aborted = true

    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      abort: immediateAbort as unknown as AbortSignal,
    })

    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null, signal?: NodeJS.Signals | null) => void)
      | undefined

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.stdin.write).not.toHaveBeenCalled()
    expect(mocks.mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['--print-logs', '--log-level', 'ERROR', 'run', '--format', 'json', 'Continue the task'],
      expect.any(Object),
    )

    closeHandler?.(null, 'SIGTERM')

    await expect(promise).rejects.toMatchObject({
      message: 'Process exited with code: 143',
      exitCode: 143,
    })
  })

  it('waits for close before resolving so late json text events can drain', async () => {
    const onStdout = vi.fn()
    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout,
      onStderr: vi.fn(),
      abort,
    })

    let settled = false
    void promise.finally(() => {
      settled = true
    })

    const stdoutHandler = child.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined
    const exitHandler = child.on.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((code: number | null) => void)
      | undefined
    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null) => void)
      | undefined

    exitHandler?.(0)
    stdoutHandler?.(
      Buffer.from(`${JSON.stringify({ type: 'text', part: { type: 'text', text: 'tail chunk' } })}\n`),
    )
    await Promise.resolve()

    expect(settled).toBe(false)

    closeHandler?.(0)

    await expect(promise).resolves.toBe(0)
    expect(onStdout).toHaveBeenCalledWith('tail chunk')
  })

  it('buffers partial json lines until a full event arrives', async () => {
    const onStdout = vi.fn()

    const promise = runOpenCodeRemoteNative({
      command: 'opencode',
      args: [],
      cwd: '/repo',
      initialPrompt: 'Continue the task',
      onStdout,
      onStderr: vi.fn(),
      abort,
    })

    const stdoutHandler = child.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined
    const closeHandler = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as
      | ((code: number | null) => void)
      | undefined

    stdoutHandler?.(Buffer.from('{"type":"text","part":{"type":"text","text":"hel'))
    stdoutHandler?.(Buffer.from('lo"}}\n'))
    closeHandler?.(0)

    await expect(promise).resolves.toBe(0)
    expect(onStdout).toHaveBeenCalledWith('hello')
  })
})
