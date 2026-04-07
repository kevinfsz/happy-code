import { runAcpSession } from '@/agent/acp/runAcp'
import type { OpenCodeSession } from './opencodeSession'

export async function opencodeRemoteLauncher(session: OpenCodeSession): Promise<'switch' | 'exit'> {
  let clientChangeCallback:
    | ((nextClient: typeof session.client, previousClient: typeof session.client) => void)
    | null = null

  try {
    return await runAcpSession({
      api: session.api,
      client: session.client,
      command: session.remoteCommand,
      args: session.remoteArgs,
      verbose: session.verbose,
      path: session.path,
      agentName: 'opencode',
      returnOnSwitch: true,
      onClientSwap: (handler) => {
        clientChangeCallback = (nextClient) => {
          handler(nextClient)
        }
        session.addClientChangeCallback(clientChangeCallback)
        return () => {
          if (clientChangeCallback) {
            session.removeClientChangeCallback(clientChangeCallback)
            clientChangeCallback = null
          }
        }
      },
    })
  } finally {
    if (clientChangeCallback) {
      session.removeClientChangeCallback(clientChangeCallback)
    }
  }
}
