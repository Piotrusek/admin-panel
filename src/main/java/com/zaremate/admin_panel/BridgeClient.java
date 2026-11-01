package com.zaremate.admin_panel;

import com.google.gson.*;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Outbound connection only. Requests are never replayed after reconnect. */
final class BridgeClient implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger("admin_panel");
    private final BridgeConfig config;
    private final Backend backend;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ScheduledExecutorService reconnect = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(32), runnable -> {
                Thread thread = new Thread(runnable, "admin-panel-worker");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());
    private final Map<String, Watch> watches = new HashMap<>();
    private final java.util.concurrent.atomic.AtomicBoolean sampling = new java.util.concurrent.atomic.AtomicBoolean();
    private record Watch(String operation, UUID player, StaffActor actor, String previous) {}
    private volatile boolean closed;
    private volatile WebSocket socket;
    private volatile Listener listener;
    BridgeClient(BridgeConfig config, Backend backend) { this.config = config; this.backend = backend; }
    void start() {
        reconnect.execute(this::connect);
        reconnect.scheduleWithFixedDelay(this::requestPublish, 0, 1, TimeUnit.SECONDS);
    }
    void requestPublish() {
        if (closed || socket == null || !sampling.compareAndSet(false, true)) return;
        try { worker.execute(() -> { try { publish(); } finally { sampling.set(false); } }); }
        catch (RejectedExecutionException busy) { sampling.set(false); }
    }
    private void connect() {
        if (closed) return;
        LOG.info("Connecting panel bridge to {}", config.url());
        http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer " + config.token()).buildAsync(config.url(), new Listener())
            .whenComplete((ws, error) -> {
                if (error != null) {
                    LOG.warn("Panel bridge connection to {} failed: {}", config.url(), error.toString());
                    retry();
                }
            });
    }
    private void retry() {
        if (!closed) {
            LOG.info("Panel bridge disconnected; retrying in 5 seconds");
            try { reconnect.schedule(this::connect, 5, TimeUnit.SECONDS); } catch (RejectedExecutionException ignored) {}
        }
    }
    private final class Listener implements WebSocket.Listener {
        private final StringBuilder text = new StringBuilder();
        private boolean ended;
        public void onOpen(WebSocket ws) {
            if (closed) { ws.abort(); return; }
            listener = this; socket = ws;
            try { worker.execute(watches::clear); ws.request(1); }
            catch (RejectedExecutionException busy) { ws.abort(); end(ws); }
            LOG.info("Panel bridge connected to {}", config.url());
        }
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            if (text.length() + data.length() > 65536) { ws.abort(); end(ws); return null; }
            text.append(data);
            if (last) {
                String request = text.toString(); text.setLength(0);
                try { worker.execute(() -> respond(ws, request)); }
                catch (RejectedExecutionException busy) { ws.abort(); end(ws); }
            }
            ws.request(1); return null;
        }
        public CompletionStage<?> onClose(WebSocket ws, int status, String reason) {
            LOG.warn("Panel bridge closed (code {}, reason: {})", status, reason);
            end(ws); return null;
        }
        public void onError(WebSocket ws, Throwable error) {
            LOG.warn("Panel bridge WebSocket error: {}", error.toString());
            end(ws);
        }
        private synchronized void end(WebSocket ws) {
            if (ended) return; ended = true;
            if (socket == ws) socket = null;
            retry();
        }
    }
    private void respond(WebSocket ws, String text) {
        if (closed || socket != ws || ws.isOutputClosed()) return;
        JsonObject response = new JsonObject();
        boolean publishAfter = false;
        try {
            JsonObject request = JsonParser.parseString(text).getAsJsonObject();
            response.addProperty("id", request.get("id").getAsString());
            if (request.get("version").getAsInt() != 1) throw new IllegalArgumentException("Unsupported bridge protocol");
            if (request.get("deadline").getAsLong() < System.currentTimeMillis()) throw new BridgeFailure(504, "Request expired before execution");
            String operation = request.get("operation").getAsString();
            JsonElement result;
            if (operation.equals("unwatch")) {
                watches.remove(request.get("watchId").getAsString()); result = new JsonObject();
            } else if (operation.equals("watch")) {
                String key = RequestFields.string(request, "watchId", 80);
                if (!watches.containsKey(key) && watches.size() >= 32) throw new BridgeFailure(503, "Live subscription capacity reached");
                String target = request.get("target").getAsString();
                if (!Set.of("players", "player").contains(target)) throw new IllegalArgumentException("Unknown watch target");
                boolean list = target.equals("players");
                watches.put(key, new Watch(list ? "players" : "player", list ? null : UUID.fromString(request.get("player").getAsString()), list ? null : actor(request.getAsJsonObject("actor")), null));
                result = new JsonObject(); publishAfter = true;
            } else if (operation.equals("players")) result = backend.players();
            else {
                UUID id = UUID.fromString(request.get("player").getAsString());
                StaffActor user = actor(request.getAsJsonObject("actor"));
                if (operation.equals("player")) result = Permissions.detail(backend.player(id, user), user);
                else if (operation.equals("mutate")) {
                    String action = request.get("action").getAsString();
                    JsonObject body = request.getAsJsonObject("body");
                    Permissions.mutation(user, action, body);
                    result = backend.mutate(id, user, action, body); publishAfter = true;
                } else throw new IllegalArgumentException("Unknown operation");
            }
            response.add("result", result);
        } catch (Exception error) {
            response.addProperty("status", error instanceof BridgeFailure f ? f.status : error instanceof IllegalArgumentException ? 400 : 500);
            response.addProperty("error", error.getMessage() == null ? "Game request failed" : error.getMessage());
        }
        String message = response.toString();
        if (message.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > BridgeBatches.MAX_BYTES) {
            response.remove("result"); response.addProperty("status", 413); response.addProperty("error", "Game response exceeds 32 MiB transfer limit");
            message = response.toString();
        }
        try { send(ws, message); if (publishAfter) requestPublish(); }
        catch (Exception failure) { ws.abort(); Listener active = listener; if (active != null && socket == ws) active.end(ws); }
    }
    private void send(WebSocket ws, String message) throws Exception {
        // Worker serialization keeps transfers ordered; await each write for backpressure.
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
        for(String frame:BridgeBatches.frames(message)) {
            long remaining=deadline-System.nanoTime();
            if(remaining<=0)throw new TimeoutException("Batch transfer timed out");
            if(closed || socket!=ws)throw new IllegalStateException("Bridge disconnected");
            ws.sendText(frame,true).get(remaining,TimeUnit.NANOSECONDS);
        }
    }
    private static StaffActor actor(JsonObject actor) {
        return new StaffActor(RequestFields.string(actor, "name", 256), UUID.fromString(RequestFields.string(actor, "uuid", 36)), RequestFields.string(actor, "rank", 32), Permissions.parse(actor.getAsJsonArray("permissions")));
    }
    // Volatile capture timestamps alone must not generate another full snapshot.
    private static void normalize(JsonElement value) {
        if (value.isJsonObject()) {
            value.getAsJsonObject().remove("updatedAt"); value.getAsJsonObject().remove("capturedAt");
            value.getAsJsonObject().entrySet().forEach(e -> normalize(e.getValue()));
        } else if (value.isJsonArray()) value.getAsJsonArray().forEach(BridgeClient::normalize);
    }
    private void publish() {
        WebSocket ws = socket;
        if (ws == null || closed) return;
        for (var entry : watches.entrySet()) {
            if (ws != socket || closed) return;
            Watch watch = entry.getValue();
            JsonObject event = new JsonObject(); event.addProperty("event", "snapshot"); event.addProperty("watchId", entry.getKey());
            try {
                JsonObject data = watch.operation().equals("players") ? backend.players() : Permissions.detail(backend.player(watch.player(), watch.actor()), watch.actor());
                JsonObject comparable = data.deepCopy(); normalize(comparable);
                String fingerprint = comparable.toString();
                if (fingerprint.equals(watch.previous())) continue;
                event.add("data", data);
                String message = event.toString();
                if (message.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > BridgeBatches.MAX_BYTES) throw new IllegalArgumentException("Live snapshot exceeds 32 MiB transfer limit");
                try { send(ws, message); }
                catch (Exception failed) { ws.abort(); Listener active=listener; if(active!=null && socket==ws)active.end(ws); return; }
                entry.setValue(new Watch(watch.operation(), watch.player(), watch.actor(), fingerprint));
            } catch (Exception error) {
                entry.setValue(new Watch(watch.operation(), watch.player(), watch.actor(), null));
                event.remove("data"); event.addProperty("error", "Live snapshot unavailable; refresh to retry");
                try { send(ws, event.toString()); }
                catch (Exception disconnected) { ws.abort(); Listener active = listener; if (active != null && socket == ws) active.end(ws); return; }
            }
        }
    }
    public void close() {
        closed = true; reconnect.shutdownNow();
        WebSocket ws = socket; socket = null; if (ws != null) ws.abort();
        worker.shutdownNow(); http.shutdownNow();
    }
}
