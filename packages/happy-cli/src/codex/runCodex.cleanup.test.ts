import { describe, expect, it, vi } from 'vitest';

import { cleanupCodexResources } from './runCodex';

describe('cleanupCodexResources', () => {
    it('continues cleanup when session.flush never resolves', async () => {
        const session = {
            sendSessionDeath: vi.fn(),
            flush: vi.fn(() => new Promise<void>(() => {})),
            close: vi.fn(async () => {}),
            keepAlive: vi.fn(),
        };
        const client = {
            disconnect: vi.fn(async () => {}),
        };
        const happyServer = {
            stop: vi.fn(),
        };
        const messageBuffer = {
            clear: vi.fn(),
        };
        const interval = setInterval(() => {}, 1000);

        await cleanupCodexResources({
            session,
            client,
            happyServer,
            keepAliveInterval: interval,
            messageBuffer,
            hasTTY: false,
            cleanupTimeoutMs: 10,
            cleanupLogger: { debug: vi.fn() },
        });

        expect(session.sendSessionDeath).toHaveBeenCalledTimes(1);
        expect(session.keepAlive).toHaveBeenCalledWith(false, 'remote');
        expect(session.close).toHaveBeenCalledTimes(1);
        expect(client.disconnect).toHaveBeenCalledTimes(1);
        expect(happyServer.stop).toHaveBeenCalledTimes(1);
        expect(messageBuffer.clear).toHaveBeenCalledTimes(1);
    });
});
