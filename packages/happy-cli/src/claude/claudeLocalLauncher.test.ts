import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let queueMessageHandler: ((message: string, mode: unknown) => void) | null = null;

  return {
    getQueueMessageHandler: () => queueMessageHandler,
    setQueueMessageHandler: (handler: ((message: string, mode: unknown) => void) | null) => {
      queueMessageHandler = handler;
    },
    mockClaudeLocal: vi.fn(),
    mockScannerCleanup: vi.fn(),
    mockScannerOnNewSession: vi.fn(),
  };
});

vi.mock('./claudeLocal', async () => {
  const actual = await vi.importActual<typeof import('./claudeLocal')>('./claudeLocal');
  return {
    ...actual,
    claudeLocal: mocks.mockClaudeLocal,
  };
});

vi.mock('./utils/sessionScanner', () => ({
  createSessionScanner: vi.fn(async () => ({
    onNewSession: mocks.mockScannerOnNewSession,
    cleanup: mocks.mockScannerCleanup,
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('claudeLocalLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setQueueMessageHandler(null);
  });

  it('returns switch when a remote message aborts local Claude with exit code 143', async () => {
    const { ExitCodeError } = await import('./claudeLocal');
    mocks.mockClaudeLocal.mockImplementation(async ({ abort }: { abort: AbortSignal }) => {
      await new Promise<void>((_, reject) => {
        abort.addEventListener('abort', () => reject(new ExitCodeError(143)), { once: true });
      });
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');

    const session = {
      sessionId: null,
      path: '/tmp/project',
      claudeEnvVars: undefined,
      claudeArgs: undefined,
      mcpServers: {},
      allowedTools: [],
      hookSettingsPath: '/tmp/hooks.json',
      sandboxConfig: undefined,
      onThinkingChange: vi.fn(),
      onSessionFound: vi.fn(),
      addSessionFoundCallback: vi.fn(),
      removeSessionFoundCallback: vi.fn(),
      queue: {
        size: vi.fn(() => 0),
        reset: vi.fn(),
        setOnMessage: vi.fn((handler: ((message: string, mode: unknown) => void) | null) => {
          mocks.setQueueMessageHandler(handler);
        }),
      },
      client: {
        sendClaudeSessionMessage: vi.fn(),
        closeClaudeSessionTurn: vi.fn(),
        sendSessionEvent: vi.fn(),
        rpcHandlerManager: {
          registerHandler: vi.fn(),
        },
      },
    };

    const launcherPromise = claudeLocalLauncher(session as any);
    await vi.waitFor(() => expect(typeof mocks.getQueueMessageHandler()).toBe('function'));
    mocks.getQueueMessageHandler()?.('hello from ios', {});

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
    expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');
  });
});
