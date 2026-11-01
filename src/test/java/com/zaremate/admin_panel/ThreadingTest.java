package com.zaremate.admin_panel;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

final class ThreadingTest {
    static int run() throws Exception {
        int checks = 0;
        try (var game = Executors.newSingleThreadExecutor(r -> new Thread(r, "test-server"))) {
            ServerThread main = new ServerThread(game, () -> Thread.currentThread().getName().equals("test-server"));
            if (!main.call(() -> Thread.currentThread().getName()).equals("test-server")) throw new AssertionError("Wrong capture thread"); checks++;
            if (game.submit(() -> main.call(() -> 42)).get(5, TimeUnit.SECONDS) != 42) throw new AssertionError("Nested capture deadlocked"); checks++;
            try { main.call(() -> { throw new IllegalArgumentException("expected"); }); throw new AssertionError("Failure lost"); }
            catch (IllegalArgumentException expected) { checks++; }
        }
        List<Runnable> queue = new CopyOnWriteArrayList<>();
        AtomicBoolean ran = new AtomicBoolean();
        ServerThread stalled = new ServerThread(queue::add, () -> false, 10);
        try { stalled.call(() -> { ran.set(true); return null; }); throw new AssertionError("Missing timeout"); }
        catch (BridgeFailure expected) { if (expected.status != 503) throw expected; checks++; }
        queue.forEach(Runnable::run);
        if (ran.get()) throw new AssertionError("Timed out action executed later"); checks++;
        queue.clear();
        CountDownLatch submitted = new CountDownLatch(1);
        ServerThread interrupted = new ServerThread(task -> { queue.add(task); submitted.countDown(); }, () -> false);
        AtomicBoolean interruptPreserved = new AtomicBoolean();
        Thread waiter = new Thread(() -> {
            try { interrupted.call(() -> { ran.set(true); return null; }); }
            catch (InterruptedException expected) { interruptPreserved.set(Thread.currentThread().isInterrupted()); }
            catch (Exception error) { throw new AssertionError(error); }
        });
        waiter.start();
        if (!submitted.await(5, TimeUnit.SECONDS)) throw new AssertionError("No queued capture");
        waiter.interrupt(); waiter.join(5000);
        queue.forEach(Runnable::run);
        if (waiter.isAlive() || ran.get() || !interruptPreserved.get()) throw new AssertionError("Shutdown did not cancel pending action"); checks++;

        Thread.currentThread().interrupt();
        try {
            interrupted.call(() -> { ran.set(true); return null; });
            throw new AssertionError("Interrupted bridge queued more work");
        } catch (InterruptedException expected) { checks++; }
        finally { Thread.interrupted(); }
        if (ran.get()) throw new AssertionError("Interrupted action ran");

        Path directory = Files.createTempDirectory("panel-tsa-");
        try {
            UUID id = UUID.randomUUID(); String hash = "a".repeat(64);
            Path report = directory.resolve(id + ".txt");
            Files.writeString(report, "2026-10-28 | PACKET_CHECK | PASS | ok\n"
                    + "2026-10-28 | PACKET_CHECK | MODIFIED | bad\n"
                    + "2026-10-28 | PACKET_CHECK | TIMEOUT | late\n"
                    + "2026-10-28 | DETECTED | MOD Xray.jar [" + hash + "], RESOURCE_PACK pack.zip [" + hash + "]\nmalformed\n");
            Files.writeString(directory.resolve("blacklisted_hashes.txt"), hash);
            Files.write(directory.resolve(UUID.randomUUID() + ".txt"), new byte[]{(byte) 0xC3, (byte) 0x28});
            TsaReports reader = new TsaReports(directory);
            var records = reader.read(); var record = records.get(id);
            if (records.size() != 1 || record.get("packetChecks").getAsInt() != 3
                    || record.get("packetPasses").getAsInt() != 1 || record.get("packetTimeout").getAsInt() != 1
                    || record.getAsJsonArray("detections").size() != 2 || !TsaReports.detected(record)) throw new AssertionError("TSA history changed"); checks++;
            Files.writeString(report, "2026-10-28 | PACKET_CHECK | PASS | ok\n");
            if (reader.read() != records) throw new AssertionError("Repeated polls should reuse the snapshot"); checks++;
            if (TsaReports.detected(new TsaReports(directory).read().get(id))) throw new AssertionError("Refresh must observe cleared detections"); checks++;
            if (!new TsaReports(directory.resolve("missing")).read().isEmpty()) throw new AssertionError("Absent reports"); checks++;
        } finally { try (var paths = Files.walk(directory)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path); } }
        return checks;
    }
}
