import { ExitCodeError, opencodeLocal } from './opencodeLocal'
import { OpenCodeSession } from './opencodeSession'

export type OpenCodeLocalLauncherResult = { type: 'switch' } | { type: 'exit', code: number }

function isSwitchReason(reason: OpenCodeLocalLauncherResult | null): reason is { type: 'switch' } {
  return reason?.type === 'switch'
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

export async function opencodeLocalLauncher(session: OpenCodeSession): Promise<OpenCodeLocalLauncherResult> {
  let exitReason: OpenCodeLocalLauncherResult | null = null
  const abortController = new AbortController()
  let activeClient = session.client

  const registerHandlers = (client: OpenCodeSession['client']) => {
    client.rpcHandlerManager.registerHandler('switch', doSwitch)
    client.rpcHandlerManager.registerHandler('abort', doSwitch)
  }

  const unregisterHandlers = (client: OpenCodeSession['client']) => {
    clearRpcHandler(client.rpcHandlerManager, 'switch')
    clearRpcHandler(client.rpcHandlerManager, 'abort')
  }

  const doSwitch = async (): Promise<void> => {
    if (!exitReason) {
      exitReason = { type: 'switch' }
    }

    if (!abortController.signal.aborted) {
      abortController.abort()
    }
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
    session.queue.setOnMessage(() => {
      void doSwitch()
    })

    if (session.queue.size() > 0) {
      return { type: 'switch' }
    }

    try {
      await opencodeLocal({
        command: session.localCommand,
        args: session.localArgs,
        path: session.path,
        abort: abortController.signal,
      })

      return exitReason ?? { type: 'exit', code: 0 }
    } catch (error) {
      if (error instanceof ExitCodeError) {
        if (isSwitchReason(exitReason)) {
          return exitReason
        }

        return { type: 'exit', code: error.exitCode }
      }

      throw error
    }
  } finally {
    session.queue.setOnMessage(null)
    session.removeClientChangeCallback(handleClientChange)
    unregisterHandlers(activeClient)
  }
}
