package com.zaremate.admin_panel;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

/** Worker-only reader for TSA 1.x report files, including versions with blocking APIs. */
final class TsaReports {
    private static final Pattern DETECTION = Pattern.compile("(?:^|,\\s*)(MOD|RESOURCE_PACK)\\s+(.+?)\\s+\\[([0-9a-fA-F]{64})\\]");
    private final Path directory;
    private Map<UUID, JsonObject> snapshot = Map.of();
    private long refreshedAt;
    TsaReports(Path directory) { this.directory = directory; }
    Map<UUID, JsonObject> read() throws java.io.IOException {
        long now = System.nanoTime();
        if (refreshedAt != 0 && now - refreshedAt < 1_000_000_000L) return snapshot;
        Map<UUID, JsonObject> records = new LinkedHashMap<>();
        if (Files.isDirectory(directory)) {
            try (var files = Files.list(directory)) {
                for (Path path : files.sorted().toList()) {
                    String name = path.getFileName().toString();
                    if (!name.endsWith(".txt")) continue;
                    UUID uuid;
                    try { uuid = UUID.fromString(name.substring(0, name.length() - 4)); }
                    catch (IllegalArgumentException ignored) { continue; }
                    try { records.put(uuid, parse(path)); }
                    catch (java.io.IOException error) {
                        org.slf4j.LoggerFactory.getLogger("admin_panel").warn("Could not read TSA report {}", path, error);
                        // A transient rewrite or unreadable report must not erase other players' detections.
                        if (snapshot.containsKey(uuid)) records.put(uuid, snapshot.get(uuid));
                    }
                }
            }
        }
        snapshot = Collections.unmodifiableMap(records);
        refreshedAt = System.nanoTime();
        return snapshot;
    }
    static JsonObject parse(Path path) throws java.io.IOException {
        long checks = 0, passes = 0, modified = 0, timeout = 0;
        String lastStatus = "", lastDate = "";
        JsonArray detections = new JsonArray();
        try (var reader = Files.newBufferedReader(path)) {
            String line;
            while ((line = reader.readLine()) != null) {
                String[] parts = line.split("\\|", 4);
                if (parts.length < 3) continue;
                String date = parts[0].trim(), kind = parts[1].trim();
                if (kind.equalsIgnoreCase("PACKET_CHECK")) {
                    checks++; lastStatus = parts[2].trim().toUpperCase(Locale.ROOT); lastDate = date;
                    switch (lastStatus) { case "PASS" -> passes++; case "MODIFIED" -> modified++; case "TIMEOUT" -> timeout++; }
                } else if (kind.equalsIgnoreCase("DETECTED")) {
                    String details = parts[2].trim() + (parts.length == 4 ? " | " + parts[3].trim() : "");
                    var match = DETECTION.matcher(details);
                    while (match.find()) detections.add(date + " | DETECTED | " + match.group(1) + " " + match.group(2).trim() + " [" + match.group(3) + "]");
                }
            }
        }
        JsonObject result = new JsonObject();
        result.addProperty("available", true);
        result.addProperty("packetChecks", checks); result.addProperty("packetPasses", passes);
        result.addProperty("packetModified", modified); result.addProperty("packetTimeout", timeout);
        result.addProperty("lastPacketStatus", lastStatus); result.addProperty("lastPacketDate", lastDate);
        result.add("detections", detections);
        return result;
    }
    static boolean detected(JsonObject record) {
        return record != null && (record.get("packetModified").getAsLong() > 0 || !record.getAsJsonArray("detections").isEmpty());
    }
}
