import { describe, expect, it } from 'vitest'
import { buildDirectReplyPrompt, buildRemoteNativePrompt } from './opencodeContext'

describe('buildRemoteNativePrompt', () => {
  it('builds a continuation prompt from an ordered recent timeline', () => {
    const prompt = buildRemoteNativePrompt({
      recentTimeline: [
        { role: 'user', content: 'user asked for a refactor' },
        { role: 'assistant', content: 'assistant inspected src/opencode\nand found the loop' },
        { role: 'user', content: 'please preserve order ``` exactly' },
      ],
      latestUserMessage: 'continue and finish it\nwithout losing formatting',
      workingDirectory: '/repo',
    })

    expect(prompt).toContain('This session started in local OpenCode mode.')
    expect(prompt).toContain(
      'Answer the latest user message first. Use the recent context only as background.',
    )
    expect(prompt).toContain(
      "If the latest user message can be answered directly, reply directly without running tools.",
    )
    expect(prompt).toContain('1. User')
    expect(prompt).toContain('2. Assistant')
    expect(prompt).toContain('3. User')
    expect(prompt).toContain('```text\nuser asked for a refactor\n```')
    expect(prompt).toContain('```text\nassistant inspected src/opencode\nand found the loop\n```')
    expect(prompt).toContain('````text\nplease preserve order ``` exactly\n````')
    expect(prompt).toContain('```text\ncontinue and finish it\nwithout losing formatting\n```')
    expect(prompt).toContain('/repo')
  })

  it('falls back cleanly when no recent context exists', () => {
    const prompt = buildRemoteNativePrompt({
      recentTimeline: [],
      latestUserMessage: 'resume the task',
      workingDirectory: '/repo',
    })

    expect(prompt).toContain('Recent context:\n- (none)')
    expect(prompt).toContain(
      'Only continue the previous task when the latest user message explicitly asks you to continue it.',
    )
    expect(prompt).toContain('```text\nresume the task\n```')
  })
})

describe('buildDirectReplyPrompt', () => {
  it('builds a direct-reply fallback prompt for stalled remote takeovers', () => {
    const prompt = buildDirectReplyPrompt({
      latestUserMessage: '你好',
      workingDirectory: '/repo',
    })

    expect(prompt).toContain('Answer the latest user message directly.')
    expect(prompt).toContain(
      'Do not use tools unless the latest user message explicitly asks about code, files, commands, or project state.',
    )
    expect(prompt).toContain('Working directory: /repo')
    expect(prompt).toContain('```text\n你好\n```')
  })
})
