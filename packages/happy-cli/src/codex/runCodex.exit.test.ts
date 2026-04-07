import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestCodexExit } from './runCodex';

describe('requestCodexExit', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('forces disconnect when abort does not settle before timeout', async () => {
        vi.useFakeTimers();

        const beginExit = vi.fn(() => true);
        const handleAbort = vi.fn(() => new Promise<void>(() => {}));
        const forceDisconnect = vi.fn(async () => {});
        const onForceDisconnect = vi.fn();
        const exitLogger = { debug: vi.fn(), warn: vi.fn() };

        requestCodexExit({
            beginExit,
            handleAbort,
            forceDisconnect,
            exitTimeoutMs: 50,
            exitLogger,
            onForceDisconnect,
        });

        expect(beginExit).toHaveBeenCalledTimes(1);
        expect(handleAbort).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);

        expect(onForceDisconnect).toHaveBeenCalledTimes(1);
        expect(forceDisconnect).toHaveBeenCalledTimes(1);
        expect(exitLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('does not force disconnect when abort finishes in time', async () => {
        vi.useFakeTimers();

        const beginExit = vi.fn(() => true);
        const handleAbort = vi.fn(async () => {});
        const forceDisconnect = vi.fn(async () => {});
        const exitLogger = { debug: vi.fn(), warn: vi.fn() };

        requestCodexExit({
            beginExit,
            handleAbort,
            forceDisconnect,
            exitTimeoutMs: 50,
            exitLogger,
        });

        await vi.runAllTimersAsync();

        expect(forceDisconnect).not.toHaveBeenCalled();
        expect(exitLogger.warn).not.toHaveBeenCalled();
    });
});
