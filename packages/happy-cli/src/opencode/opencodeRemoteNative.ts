import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { logger } from '@/ui/logger'
import { ExitCodeError } from './opencodeLocal'

const ABORT_KILL_TIMEOUT_MS = 1000

export { ExitCodeError }

function buildRemoteNativeArgs(args: string[], initialPrompt: string): string[] {
  return ['--print-logs', '--log-level', 'ERROR', 'run', '--format', 'json', ...args, initialPrompt]
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[mGKHJ]/g, '')
}

function emitJsonTextEvents(chunk: string, buffered: string, onText: (text: string) => void): string {
  const combined = buffered + chunk
  const lines = combined.split('\n')
  const nextBuffered = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const cleanLine = stripAnsi(trimmed)
    try {
      const parsed = JSON.parse(cleanLine) as {
        type?: string
        part?: { type?: string; text?: string }
      }
      if (parsed.type === 'text' && parsed.part?.type === 'text' && parsed.part.text) {
        onText(parsed.part.text)
      } else {
        logger.debug(`[opencode-remote] Unrecognized JSON event: ${cleanLine.substring(0, 200)}`)
      }
    } catch {
      onText(`${cleanLine}\n`)
    }
  }

  return nextBuffered
}

export async function runOpenCodeRemoteNative(opts: {
  abort: AbortSignal
  cwd: string
  command: string
  args: string[]
  initialPrompt: string
  onStdout: (chunk: string) => void
  onStderr: (chunk: string) => void
  onRawStdout?: () => void
  env?: NodeJS.ProcessEnv
}): Promise<number> {
  const opencodeArgs = buildRemoteNativeArgs(opts.args, opts.initialPrompt)

  // Write a shell wrapper script so we avoid shell escaping issues with the prompt
  const shellCommand = [opts.command, ...opencodeArgs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  const wrapperPath = join(tmpdir(), `happy-opencode-${Date.now()}.sh`)
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${shellCommand}\n`)
  chmodSync(wrapperPath, 0o755)

  // Write an expect script that spawns the wrapper in a real PTY
  // log_user 0 suppresses expect's own "spawn ..." echo
  // then we immediately re-enable for child output
  const expectPath = join(tmpdir(), `happy-expect-${Date.now()}.exp`)
  writeFileSync(expectPath, [
    'set timeout -1',
    'log_user 0',
    `spawn sh ${wrapperPath}`,
    'log_user 1',
    'expect eof',
    'catch wait result',
    'if {[lindex $result 2] eq "CHILDKILLED"} {',
    '    exit [expr {128 + [lindex $result 3]}]',
    '}',
    'exit [lindex $result 3]',
  ].join('\n'))

  logger.debug(`[opencode-remote] Spawning via expect PTY: sh ${wrapperPath}`)

  const child = spawn('expect', [expectPath], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Cleanup temp files on exit
  const cleanupFiles = () => {
    try { unlinkSync(wrapperPath) } catch { /* ignore */ }
    try { unlinkSync(expectPath) } catch { /* ignore */ }
  }

  let stdoutBuffer = ''
  let expectSpawnEchoEmitted = false
  child.stdout?.on('data', (chunk) => {
    let raw = chunk.toString()
    // Skip the expect's "spawn ..." echo line (only once at the beginning)
    if (!expectSpawnEchoEmitted) {
        const spawnMatch = raw.match(/^spawn sh [^\n]+\n?/)
        if (spawnMatch) {
            expectSpawnEchoEmitted = true
            raw = raw.slice(spawnMatch[0].length)
            if (!raw.trim()) {
                return
            }
        }
    }
    opts.onRawStdout?.()
    logger.debug(`[opencode-remote] stdout raw: ${raw.substring(0, 300)}`)
    stdoutBuffer = emitJsonTextEvents(raw, stdoutBuffer, opts.onStdout)
  })
  child.stderr?.on('data', (chunk) => {
    const stderrText = chunk.toString()
    logger.debug(`[opencode-remote] stderr: ${stderrText.substring(0, 500)}`)
    opts.onStderr(stderrText)
  })

  return await new Promise<number>((resolve, reject) => {
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
      cleanupFiles()
      settle(() => reject(error))
    })

    child.on('close', (code, signal) => {
      cleanupFiles()
      logger.debug(`[opencode-remote] Process exited with code: ${code}, signal: ${signal}`)
      const signalCode = signal ? constants.signals[signal] : undefined
      const exitCode = signalCode ? 128 + signalCode : (code ?? 0)
      settle(() => {
        if (stdoutBuffer.trim().length > 0) {
          const clean = stripAnsi(stdoutBuffer.trim())
          try {
            const parsed = JSON.parse(clean) as {
              type?: string
              part?: { type?: string; text?: string }
            }
            if (parsed.type === 'text' && parsed.part?.type === 'text' && parsed.part.text) {
              opts.onStdout(parsed.part.text)
            } else {
              opts.onStdout(`${clean}\n`)
            }
          } catch {
            opts.onStdout(`${clean}\n`)
          }
        }
        if (exitCode === 0) {
          resolve(exitCode)
          return
        }

        reject(new ExitCodeError(exitCode))
      })
    })
  })
}
