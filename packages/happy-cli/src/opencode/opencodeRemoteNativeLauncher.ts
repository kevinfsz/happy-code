import { buildDirectReplyPrompt, buildRemoteNativePrompt } from './opencodeContext'
import { ExitCodeError, runOpenCodeRemoteNative } from './opencodeRemoteNative'
import type { OpenCodeSession } from './opencodeSession'
import { logger } from '@/ui/logger'

const REMOTE_MESSAGE_COALESCE_MS = 400
const REMOTE_FIRST_TEXT_TIMEOUT_MS = 30000
const RESTARTABLE_INTERRUPT_EXIT_CODES = new Set([130, 137, 143])

type QueuedMessageBatch = {
  message: string
  mode: unknown
  isolate: boolean
  hash: string
}

type CoalescedBatch = {
  message: string
  deferredBatch: QueuedMessageBatch | null
}

function clearRpcHandler(
  rpcHandlerManager: {
    unregisterHandler?: (method: string) => void
    registerHandler: (method: string, handler: () => Promise<void>) => void
  },
  method: string,
): void {
  if (typeof rpcHandlerManager.unregisterHandler === 'function') {
    rpcHandlerManager.unregisterHandler(method)
    return
  }

  rpcHandlerManager.registerHandler(method, async () => {})
}

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) {
    controller.abort()
    return () => {}
  }

  const onAbort = () => {
    controller.abort()
  }

  signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    signal.removeEventListener('abort', onAbort)
  }
}

function abortController(controller: AbortController | null): void {
  controller?.abort()
}

async function collectCoalescedBatch(
  session: OpenCodeSession,
  abort: AbortSignal,
  firstBatch: QueuedMessageBatch | null,
): Promise<CoalescedBatch | null> {
  if (!firstBatch) {
    return null
  }

  if (firstBatch.isolate) {
    return {
      message: firstBatch.message,
      deferredBatch: null,
    }
  }

  let combinedMessage = firstBatch.message
  const deadline = Date.now() + REMOTE_MESSAGE_COALESCE_MS

  while (!abort.aborted) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return {
        message: combinedMessage,
        deferredBatch: null,
      }
    }

    const waitAbortController = new AbortController()
    const unlinkAbort = linkAbortSignal(abort, waitAbortController)
    const timer = setTimeout(() => {
      waitAbortController.abort()
    }, remaining)
    timer.unref?.()

    try {
      const nextBatch = await session.queue.waitForMessagesAndGetAsString(waitAbortController.signal)
      if (!nextBatch) {
        return {
          message: combinedMessage,
          deferredBatch: null,
        }
      }

      if (nextBatch.isolate || nextBatch.hash !== firstBatch.hash) {
        return {
          message: combinedMessage,
          deferredBatch: nextBatch,
        }
      }

      combinedMessage = `${combinedMessage}\n${nextBatch.message}`
    } finally {
      clearTimeout(timer)
      unlinkAbort()
    }
  }

  return {
    message: combinedMessage,
    deferredBatch: null,
  }
}

export async function opencodeRemoteNativeLauncher(
  session: OpenCodeSession,
): Promise<'switch' | 'exit'> {
  let exitReason: 'switch' | 'exit' | null = null
  const launcherAbortController = new AbortController()
  let runAbortController: AbortController | null = null
  let activeClient = session.client

  const abortActiveRun = () => {
    if (runAbortController && !runAbortController.signal.aborted) {
      runAbortController.abort()
    }
  }

  const setExitReason = (reason: 'switch' | 'exit') => {
    if (reason === 'switch' || exitReason === null) {
      exitReason = reason
    }
  }

  const registerHandlers = (client: OpenCodeSession['client']) => {
    client.rpcHandlerManager.registerHandler('switch', async () => {
      setExitReason('switch')
      if (!launcherAbortController.signal.aborted) {
        launcherAbortController.abort()
      }
      abortActiveRun()
    })
    client.rpcHandlerManager.registerHandler('abort', async () => {
      setExitReason('exit')
      if (!launcherAbortController.signal.aborted) {
        launcherAbortController.abort()
      }
      abortActiveRun()
    })
  }

  const unregisterHandlers = (client: OpenCodeSession['client']) => {
    clearRpcHandler(client.rpcHandlerManager, 'switch')
    clearRpcHandler(client.rpcHandlerManager, 'abort')
  }

  const handleClientChange = (
    nextClient: OpenCodeSession['client'],
    previousClient: OpenCodeSession['client'],
  ) => {
    unregisterHandlers(previousClient)
    activeClient = nextClient
    registerHandlers(nextClient)
  }

  try {
    session.addClientChangeCallback(handleClientChange)
    registerHandlers(activeClient)

    let pendingBatch: QueuedMessageBatch | null = null

    while (true) {
      const firstBatch =
        pendingBatch ?? (
          await session.queue.waitForMessagesAndGetAsString(launcherAbortController.signal)
        )
      pendingBatch = null

      if (!firstBatch || exitReason === 'exit') {
        return 'exit'
      }
      if (exitReason === 'switch') {
        return 'switch'
      }

      const coalescedBatch = await collectCoalescedBatch(
        session,
        launcherAbortController.signal,
        firstBatch,
      )
      if (!coalescedBatch || exitReason === 'exit') {
        return 'exit'
      }
      if (exitReason === 'switch') {
        return 'switch'
      }
      pendingBatch = coalescedBatch.deferredBatch
      const latestUserMessage = coalescedBatch.message

      const recentContext = session.buildRecentContext()
      let useDirectReplyFallback = false

      while (true) {
        const initialPrompt = useDirectReplyFallback
          ? buildDirectReplyPrompt({
              latestUserMessage,
              workingDirectory: session.path,
            })
          : buildRemoteNativePrompt({
              recentTimeline: recentContext.recentTimeline,
              latestUserMessage,
              workingDirectory: session.path,
            })

        let pendingRestart = false
        let emittedAssistantText = false
        let retryWithDirectReply = false
        let firstTextTimeout: NodeJS.Timeout | null = null
        runAbortController = new AbortController()
        const unlinkRunAbort = linkAbortSignal(launcherAbortController.signal, runAbortController)
        const pendingBatchWaitAbortController = new AbortController()
        const unlinkPendingBatchAbort = linkAbortSignal(
          launcherAbortController.signal,
          pendingBatchWaitAbortController,
        )
        const nextPendingBatchPromise = Promise.resolve(
          session.queue.waitForMessagesAndGetAsString(pendingBatchWaitAbortController.signal),
        ).then((batch) => {
          const nextBatch = batch ?? null
          if (nextBatch) {
            pendingBatch = nextBatch
            pendingRestart = true
            abortActiveRun()
          }
          return nextBatch
        })

        if (!useDirectReplyFallback) {
          firstTextTimeout = setTimeout(() => {
            if (emittedAssistantText || exitReason || runAbortController?.signal.aborted) {
              return
            }
            retryWithDirectReply = true
            abortActiveRun()
          }, REMOTE_FIRST_TEXT_TIMEOUT_MS)
          firstTextTimeout.unref?.()
        }

        const runPromise = runOpenCodeRemoteNative({
          command: session.remoteCommand,
          args: session.remoteArgs,
          cwd: session.path,
          initialPrompt,
          abort: runAbortController.signal,
          onRawStdout: () => {
            emittedAssistantText = true
            if (firstTextTimeout) {
              clearTimeout(firstTextTimeout)
              firstTextTimeout = null
            }
          },
          onStdout: (chunk) => {
            session.recordAssistantOutput(chunk)
            session.client.sendAgentMessage('opencode', {
              type: 'message',
              message: chunk,
            })
            process.stdout.write(chunk)
          },
          onStderr: (chunk) => {
            logger.debug(`[opencode-remote-launcher] stderr: ${chunk.substring(0, 500)}`)
            session.recordAssistantOutput(chunk)
            process.stderr.write(chunk)
          },
        })

        session.queue.setOnMessage(() => {
          pendingRestart = true
          abortActiveRun()
        })

        let rerunWithDirectReply = false

        try {
          await runPromise
          session.client.sendSessionEvent({ type: 'ready' })
        } catch (error) {
          if (error instanceof ExitCodeError && exitReason) {
            return exitReason
          }
          if (
            error instanceof ExitCodeError
            && retryWithDirectReply
            && RESTARTABLE_INTERRUPT_EXIT_CODES.has(error.exitCode)
          ) {
            rerunWithDirectReply = true
          } else if (
            !(
              error instanceof ExitCodeError
              && pendingRestart
              && RESTARTABLE_INTERRUPT_EXIT_CODES.has(error.exitCode)
            )
          ) {
            throw error
          }
        } finally {
          if (firstTextTimeout) {
            clearTimeout(firstTextTimeout)
          }
          runAbortController = null
          session.queue.setOnMessage(null)
          abortController(pendingBatchWaitAbortController)
          unlinkPendingBatchAbort()
          unlinkRunAbort()
        }

        pendingBatch = (await nextPendingBatchPromise) ?? pendingBatch

        if (rerunWithDirectReply && !pendingRestart && !useDirectReplyFallback) {
          useDirectReplyFallback = true
          continue
        }

        break
      }

      if (exitReason === 'switch') {
        return 'switch'
      }
      if (exitReason === 'exit') {
        return 'exit'
      }
    }
  } finally {
    session.queue.setOnMessage(null)
    session.removeClientChangeCallback(handleClientChange)
    unregisterHandlers(activeClient)
  }
}
