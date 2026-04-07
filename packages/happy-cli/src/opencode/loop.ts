import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { opencodeLocalLauncher, type OpenCodeLocalLauncherResult } from './opencodeLocalLauncher'
import { opencodeRemoteNativeLauncher } from './opencodeRemoteNativeLauncher'
import { OpenCodeSession, type OpenCodeMode } from './opencodeSession'

export type OpenCodeRemoteLauncherResult = 'switch' | 'exit'

export type OpenCodeLocalLauncher = (session: OpenCodeSession) => Promise<OpenCodeLocalLauncherResult>
export type OpenCodeRemoteLauncher = (session: OpenCodeSession) => Promise<OpenCodeRemoteLauncherResult>

export interface OpenCodeLoopLaunchers {
  local: OpenCodeLocalLauncher
  remote: OpenCodeRemoteLauncher
}

export interface LoopOptions {
  path: string
  logPath: string
  localCommand: string
  localArgs: string[]
  remoteCommand: string
  remoteArgs: string[]
  verbose: boolean
  startingMode?: OpenCodeMode
  onModeChange?: (mode: OpenCodeMode) => void
  onSessionReady?: (session: OpenCodeSession) => void
  api: ApiClient
  client: ApiSessionClient
  queue: MessageQueue2<unknown>
  launchers?: Partial<OpenCodeLoopLaunchers>
}

function resolveLaunchers(opts: LoopOptions): OpenCodeLoopLaunchers {
  return {
    local: opts.launchers?.local ?? opencodeLocalLauncher,
    remote: opts.launchers?.remote ?? opencodeRemoteNativeLauncher,
  }
}

function syncStartingMode(session: OpenCodeSession, startingMode: OpenCodeMode): void {
  session.client.updateAgentState((currentState) => ({
    ...currentState,
    controlledByUser: startingMode === 'local',
  }))
}

export async function loopOpenCode(opts: LoopOptions): Promise<number> {
  const startingMode = opts.startingMode ?? 'local'
  const session = new OpenCodeSession({
    api: opts.api,
    client: opts.client,
    queue: opts.queue,
    path: opts.path,
    logPath: opts.logPath,
    localCommand: opts.localCommand,
    localArgs: opts.localArgs,
    remoteCommand: opts.remoteCommand,
    remoteArgs: opts.remoteArgs,
    verbose: opts.verbose,
    startingMode,
  })

  opts.onSessionReady?.(session)

  syncStartingMode(session, startingMode)

  const launchers = resolveLaunchers(opts)

  try {
    let mode = startingMode

    while (true) {
      if (mode === 'local') {
        const result = await launchers.local(session)
        if (result.type === 'switch') {
          mode = 'remote'
          session.onModeChange(mode)
          opts.onModeChange?.(mode)
          continue
        }

        return result.code
      }

      const result = await launchers.remote(session)
      if (result === 'switch') {
        mode = 'local'
        session.onModeChange(mode)
        opts.onModeChange?.(mode)
        continue
      }

      return 0
    }
  } finally {
    session.cleanup()
  }
}
