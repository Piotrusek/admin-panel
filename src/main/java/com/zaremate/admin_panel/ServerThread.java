package com.zaremate.admin_panel;

import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

/** Only the worker waits; queued work is cancelled on timeout or shutdown interruption. */
final class ServerThread {
    private final Executor executor;
    private final BooleanSupplier current;
    private final long timeoutMillis;
    ServerThread(Executor executor, BooleanSupplier current) { this(executor, current, 15_000); }
    ServerThread(Executor executor, BooleanSupplier current, long timeoutMillis) {
        this.executor = executor; this.current = current; this.timeoutMillis = timeoutMillis;
    }
    <T> T call(Callable<T> work) throws Exception {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException("Panel bridge stopped");
        if (current.getAsBoolean()) return work.call();
        FutureTask<T> task = new FutureTask<>(work);
        executor.execute(task);
        try { return task.get(timeoutMillis, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) {
            task.cancel(false); Thread.currentThread().interrupt(); throw error;
        } catch (TimeoutException error) {
            task.cancel(false);
            throw new BridgeFailure(503, "Game server timed out. Execution may have started; inspect the player and audit trail before retrying.");
        } catch (ExecutionException error) {
            if (error.getCause() instanceof Exception cause) throw cause;
            throw error;
        }
    }
}
