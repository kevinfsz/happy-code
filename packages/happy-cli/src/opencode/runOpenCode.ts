import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import { initialMachineMetadata } from '@/daemon/run'
import { connectionState } from '@/utils/serverConnectionErrors'
import { logger } from '@/ui/logger'
import { Credentials, readSettings } from '@/persistence'
import { createSessionMetadata } from '@/utils/createSessionMetadata'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection'
import { notifyDaemonSessionStarted } from '@/daemon/controlClient'
import { loopOpenCode } from './loop'
import type { OpenCodeSession } from './opencodeSession'

export function assertOpenCodeCliAvailable(command: string): void {
  try {
    execFileSync(command, ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException
    if (maybeErr.code === 'ENOENT') {
      throw new Error('OpenCode CLI is not installed')
    }

    throw error
  }
}

export async function runOpenCode(opts: {
  credentials: Credentials
  startedBy?: 'daemon' | 'terminal'
  verbose?: boolean
  localCommand: string
  localArgs: string[]
  remoteCommand: string
  remoteArgs: string[]
}): Promise<number> {
  assertOpenCodeCliAvailable(opts.localCommand)
  const startingMode = opts.startedBy === 'daemon' ? 'remote' : 'local'

  const verbose = opts.verbose === true
  const log = (message: string) => {
    logger.debug(`[opencode] ${message}`)
    if (verbose) {
      console.log(`[opencode] ${message}`)
    }
  }

  connectionState.setBackend('opencode')

  const sessionTag = randomUUID()
  const api = await ApiClient.create(opts.credentials)
  const settings = await readSettings()
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings')
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  })

  const { state, metadata } = createSessionMetadata({
    flavor: 'opencode',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  })
  state.controlledByUser = startingMode === 'local'
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state })
  if (response) {
    log(`Happy Session ID: ${response.id}`)
  }

  let activeSessionClient: ApiSessionClient
  let currentSession: OpenCodeSession | null = null
  const queue = new MessageQueue2<unknown>(() => '')
  const handleUserMessage = (message: { content: { text?: string } }) => {
    if (!message.content.text) {
      return
    }

    currentSession?.recordUserMessage(message.content.text)
    queue.push(message.content.text, {})
  }
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      activeSessionClient = newSession
      activeSessionClient.onUserMessage(handleUserMessage)
      currentSession?.updateClient(newSession)
    },
  })
  activeSessionClient = initialSession
  activeSessionClient.onUserMessage(handleUserMessage)

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata)
    } catch (error) {
      logger.debug('[opencode] Failed to report session to daemon:', error)
    }
  }

  const exitCode = await loopOpenCode({
    path: process.cwd(),
    logPath: logger.logFilePath,
    localCommand: opts.localCommand,
    localArgs: opts.localArgs,
    remoteCommand: opts.remoteCommand,
    remoteArgs: opts.remoteArgs,
    verbose,
    startingMode,
    api,
    client: activeSessionClient,
    queue,
    onModeChange: () => undefined,
    onSessionReady: (sessionInstance) => {
      currentSession = sessionInstance
      if (sessionInstance.client !== activeSessionClient) {
        sessionInstance.updateClient(activeSessionClient)
      }
    },
  })

  try {
    activeSessionClient.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
      archivedBy: 'cli',
      archiveReason: 'Session ended',
    }))
    activeSessionClient.sendSessionDeath()
    await activeSessionClient.flush()
    await activeSessionClient.close()
  } catch (error) {
    logger.debug('[opencode] Session close failed:', error)
  } finally {
    reconnectionHandle?.cancel()
  }

  return exitCode
}
