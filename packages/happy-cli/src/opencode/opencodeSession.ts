import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import type { MessageQueue2 } from '@/utils/MessageQueue2'

export type OpenCodeMode = 'local' | 'remote'
export type OpenCodeRecentContextEntry = {
  role: 'user' | 'assistant'
  content: string
}

export type OpenCodeRecentContext = {
  recentTimeline: OpenCodeRecentContextEntry[]
  recentUserMessages: string[]
  recentAssistantOutput: string[]
}

export class OpenCodeSession {
  readonly api: ApiClient
  client: ApiSessionClient
  readonly queue: MessageQueue2<unknown>
  readonly path: string
  readonly logPath: string
  readonly localCommand: string
  readonly localArgs: string[]
  readonly remoteCommand: string
  readonly remoteArgs: string[]
  readonly verbose: boolean

  mode: OpenCodeMode = 'local'
  thinking = false

  private readonly keepAliveInterval: NodeJS.Timeout
  private readonly recentUserMessages: string[] = []
  private readonly recentAssistantOutput: string[] = []
  private readonly recentTimeline: OpenCodeRecentContextEntry[] = []
  private readonly clientChangeCallbacks = new Set<
    (nextClient: ApiSessionClient, previousClient: ApiSessionClient) => void
  >()

  constructor(opts: {
    api: ApiClient
    client: ApiSessionClient
    queue: MessageQueue2<unknown>
    path: string
    logPath: string
    localCommand: string
    localArgs: string[]
    remoteCommand: string
    remoteArgs: string[]
    verbose: boolean
    startingMode?: OpenCodeMode
  }) {
    this.api = opts.api
    this.client = opts.client
    this.queue = opts.queue
    this.path = opts.path
    this.logPath = opts.logPath
    this.localCommand = opts.localCommand
    this.localArgs = opts.localArgs
    this.remoteCommand = opts.remoteCommand
    this.remoteArgs = opts.remoteArgs
    this.verbose = opts.verbose
    this.mode = opts.startingMode ?? 'local'

    this.client.keepAlive(this.thinking, this.mode)
    this.keepAliveInterval = setInterval(() => {
      this.client.keepAlive(this.thinking, this.mode)
    }, 2000)
    this.keepAliveInterval.unref?.()
  }

  onModeChange(mode: OpenCodeMode): void {
    this.mode = mode
    this.client.keepAlive(this.thinking, this.mode)
    this.client.sendSessionEvent({ type: 'switch', mode })
    this.client.updateAgentState((currentState) => ({
      ...currentState,
      controlledByUser: mode === 'local',
    }))
  }

  updateClient(client: ApiSessionClient): void {
    const previousClient = this.client
    this.client = client
    this.client.keepAlive(this.thinking, this.mode)
    for (const callback of this.clientChangeCallbacks) {
      callback(client, previousClient)
    }
  }

  addClientChangeCallback(
    callback: (nextClient: ApiSessionClient, previousClient: ApiSessionClient) => void,
  ): void {
    this.clientChangeCallbacks.add(callback)
  }

  recordUserMessage(message: string): void {
    this.recentUserMessages.push(message)
    this.recentTimeline.push({ role: 'user', content: message })
    if (this.recentUserMessages.length > 20) {
      this.recentUserMessages.shift()
      this.removeOldestRecentTimelineEntry('user')
    }
  }

  recordAssistantOutput(chunk: string): void {
    this.recentAssistantOutput.push(chunk)
    this.recentTimeline.push({ role: 'assistant', content: chunk })
    if (this.recentAssistantOutput.length > 40) {
      this.recentAssistantOutput.shift()
      this.removeOldestRecentTimelineEntry('assistant')
    }
  }

  buildRecentContext(): OpenCodeRecentContext {
    return {
      recentTimeline: this.recentTimeline.map((entry) => ({ ...entry })),
      recentUserMessages: [...this.recentUserMessages],
      recentAssistantOutput: [...this.recentAssistantOutput],
    }
  }

  private removeOldestRecentTimelineEntry(role: OpenCodeRecentContextEntry['role']): void {
    const index = this.recentTimeline.findIndex((entry) => entry.role === role)
    if (index >= 0) {
      this.recentTimeline.splice(index, 1)
    }
  }

  removeClientChangeCallback(
    callback: (nextClient: ApiSessionClient, previousClient: ApiSessionClient) => void,
  ): void {
    this.clientChangeCallbacks.delete(callback)
  }

  cleanup(): void {
    clearInterval(this.keepAliveInterval)
  }
}
