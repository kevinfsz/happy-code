import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const ABORT_KILL_TIMEOUT_MS = 1000

export class ExitCodeError extends Error {
  public readonly exitCode: number

  constructor(exitCode: number) {
    super(`Process exited with code: ${exitCode}`)
    this.name = 'ExitCodeError'
    this.exitCode = exitCode
  }
}

export async function opencodeLocal(opts: {
  abort: AbortSignal
  path: string
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.path,
    env: {
      ...process.env,
      ...opts.env,
    },
    stdio: 'inherit',
  })

  return await new Promise<void>((resolve, reject) => {
    let finished = false
    let abortKillTimeout: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (abortKillTimeout) {
        clearTimeout(abortKillTimeout)
        abortKillTimeout = null
      }
      opts.abort.removeEventListener('abort', onAbort)
    }

    const settle = (callback: () => void) => {
      if (finished) {
        return
      }

      finished = true
      cleanup()
      callback()
    }

    const onAbort = () => {
      child.kill('SIGTERM')
      if (!abortKillTimeout) {
        abortKillTimeout = setTimeout(() => {
          child.kill('SIGKILL')
        }, ABORT_KILL_TIMEOUT_MS)
        abortKillTimeout.unref?.()
      }
    }

    opts.abort.addEventListener('abort', onAbort)
    if (opts.abort.aborted) {
      onAbort()
    }

    child.on('error', (error) => {
      settle(() => reject(error))
    })

    child.on('exit', (code, signal) => {
      const signalCode = signal ? constants.signals[signal] : undefined
      const exitCode = signalCode ? 128 + signalCode : (code ?? 0)
      settle(() => {
        if (exitCode === 0) {
          resolve()
          return
        }

        reject(new ExitCodeError(exitCode))
      })
    })
  })
}
