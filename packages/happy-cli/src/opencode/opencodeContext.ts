import type { OpenCodeRecentContextEntry } from './opencodeSession'

function longestBacktickRun(content: string): number {
  const matches = content.match(/`+/g) ?? []
  return matches.reduce((longest, match) => Math.max(longest, match.length), 0)
}

function formatMessageBlock(content: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1))
  return `${fence}text\n${content}\n${fence}`
}

function formatRecentContext(entries: OpenCodeRecentContextEntry[]): string {
  if (entries.length === 0) {
    return '- (none)'
  }

  return entries
    .map((entry, index) => {
      const roleLabel = entry.role === 'user' ? 'User' : 'Assistant'
      return `${index + 1}. ${roleLabel}\n${formatMessageBlock(entry.content)}`
    })
    .join('\n')
}

export function buildRemoteNativePrompt(opts: {
  recentTimeline: OpenCodeRecentContextEntry[]
  latestUserMessage: string
  workingDirectory: string
}): string {
  return [
    'This session started in local OpenCode mode.',
    'Mobile takeover has occurred.',
    'Answer the latest user message first. Use the recent context only as background.',
    'If the latest user message can be answered directly, reply directly without running tools.',
    'Only continue the previous task when the latest user message explicitly asks you to continue it.',
    `Working directory: ${opts.workingDirectory}`,
    'Recent context:',
    formatRecentContext(opts.recentTimeline),
    'Latest user message to answer:',
    formatMessageBlock(opts.latestUserMessage),
  ].join('\n')
}

export function buildDirectReplyPrompt(opts: {
  latestUserMessage: string
  workingDirectory: string
}): string {
  return [
    'You are continuing a mobile-takeover OpenCode session.',
    'Answer the latest user message directly.',
    'Do not use tools unless the latest user message explicitly asks about code, files, commands, or project state.',
    `Working directory: ${opts.workingDirectory}`,
    'Latest user message to answer:',
    formatMessageBlock(opts.latestUserMessage),
  ].join('\n')
}
