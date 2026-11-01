package com.zaremate.admin_panel;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.*;

/** Panel-owned adapter: live integrations are captured on the server thread;
 * file reads and response assembly belong to the bridge worker. */
final class PanelData {
    private final ServerThread main;
    private final java.nio.file.Path profiles;
    private final TsaReports tsaReports;
    private Map<UUID, String> names = Map.of();
    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger("admin_panel");
    PanelData(ServerThread main, java.nio.file.Path profiles, java.nio.file.Path tsaDirectory) {
        this.main = main; this.profiles = profiles; this.tsaReports = new TsaReports(tsaDirectory);
    }

    public JsonObject buildPlayerList(MinecraftServer server) throws Exception {
        names = collectPlayers(server);
        Set<UUID> online = main.call(() -> server.getPlayerList().getPlayers().stream()
                .map(ServerPlayer::getUUID).collect(java.util.stream.Collectors.toSet()));
        Set<UUID> assDetected = main.call(() -> {
            Set<UUID> result = new HashSet<>();
            try {
                Object rows = Class.forName("com.zaremate.airport_security_system.AirportSecuritySystemAPI")
                        .getMethod("getPlayerOffenses").invoke(null);
                if (rows instanceof Iterable<?> records) for (Object record : records) {
                    if (recordLong(record, "detectedChecks") > 0) result.add((UUID) recordAccessor(record, "playerUuid"));
                }
            } catch (ReflectiveOperationException | LinkageError ignored) {}
            return result;
        });
        Map<UUID, JsonObject> tsa = tsaRecords();
        JsonArray players = new JsonArray();
        names.entrySet().stream().sorted(Comparator
                .<Map.Entry<UUID, String>, Boolean>comparing(e -> !online.contains(e.getKey()))
                .thenComparing(Map.Entry::getValue, String.CASE_INSENSITIVE_ORDER)).forEach(e -> {
            JsonObject row = new JsonObject();
            row.addProperty("uuid", e.getKey().toString()); row.addProperty("name", e.getValue());
            row.addProperty("online", online.contains(e.getKey()));
            row.addProperty("hasDetections", assDetected.contains(e.getKey()) || TsaReports.detected(tsa.get(e.getKey())));
            players.add(row);
        });
        JsonObject result = new JsonObject(); result.add("players", players);
        result.addProperty("serverPlayers", online.size()); return result;
    }

    public String buildPlayerDetail(
            MinecraftServer server,
            UUID uuid,
            UUID viewerUuid
    ) throws Exception {
        names = collectPlayers(server);
        JsonObject root = new JsonObject();
        root.addProperty("uuid", uuid.toString());

        boolean online = main.call(() -> server.getPlayerList().getPlayer(uuid) != null);
        String name = resolveName(server, uuid);
        root.addProperty("name", name);
        root.addProperty("online", online);

        JsonObject identity = new JsonObject();
        identity.addProperty("uuid", uuid.toString());
        identity.addProperty("name", name);
        identity.addProperty("online", online);
        root.add("identity", identity);

        JsonObject debug = new JsonObject();
        debug.addProperty("tsa.classPresent", classPresent("com.zaremate.tsa_anticheat.api.TsaAnticheatAPI"));
        debug.addProperty("ass.classPresent", classPresent("com.zaremate.airport_security_system.AirportSecuritySystemAPI"));
        debug.addProperty("teams.classPresent", classPresent("com.zaremate.ftb_teams_util.FTBTeamsUtilAPI"));
        debug.addProperty("discord.classPresent", classPresent("com.zaremate.discordlink.DiscordLinkAPI"));
        debug.addProperty("clockin.classPresent", classPresent("com.zaremate.clockin.ClockInMod"));
        debug.addProperty("punish.classPresent", classPresent("com.zaremate.punish.api.PunishApi"));

        root.add("tsa", tsa(uuid, debug));
        root.add("ass", main.call(() -> ass(uuid, debug)));
        root.addProperty("notesAvailable", classAvailable("com.zaremate.admin_notes.AdminNotesAPI"));
        root.add("notes", noteSnapshot(uuid, viewerUuid));
        root.add("teams", main.call(() -> teams(uuid, debug)));
        root.add("discord", main.call(() -> discord(uuid, debug)));
        root.add("clockin", main.call(() -> clockin(uuid, debug)));
        root.add("punish", main.call(() -> punish(uuid, server, debug)));

        LOG.debug("Detail diagnostics for {}: {}", uuid, debug);
        return root.toString();
    }

    private Map<UUID, JsonObject> tsaRecords() {
        if (!classPresent("com.zaremate.tsa_anticheat.api.TsaAnticheatAPI")) return Map.of();
        try { return tsaReports.read(); }
        catch (java.io.IOException error) { LOG.warn("Could not read TSA reports", error); return Map.of(); }
    }

    private Map<UUID, String> collectPlayers(MinecraftServer server) throws Exception {
        Map<UUID, String> result = new LinkedHashMap<>();
        // Read usercache directly: GameProfileCache.load() does disk I/O too.
        try (var reader = java.nio.file.Files.newBufferedReader(profiles)) {
            for (var entry : com.google.gson.JsonParser.parseReader(reader).getAsJsonArray()) {
                try {
                    var row = entry.getAsJsonObject();
                    result.put(UUID.fromString(row.get("uuid").getAsString()), row.get("name").getAsString());
                } catch (RuntimeException ignored) {}
            }
        } catch (java.io.IOException | RuntimeException ignored) {}
        Map<UUID, String> live = main.call(() -> {
            Map<UUID, String> values = new LinkedHashMap<>();
            for (var player : server.getPlayerList().getPlayers()) values.put(player.getUUID(), player.getGameProfile().getName());
            try {
                Object rows = Class.forName("com.zaremate.airport_security_system.AirportSecuritySystemAPI")
                        .getMethod("getPlayerOffenses").invoke(null);
                if (rows instanceof Iterable<?> records) for (Object record : records) {
                    Object rawId = recordAccessor(record, "playerUuid");
                    String name = recordString(record, "playerName");
                    if (rawId instanceof UUID id) values.putIfAbsent(id, name.isBlank() ? id.toString() : name);
                }
            } catch (ReflectiveOperationException | LinkageError ignored) {}
            for (UUID uuid : clockinPlayers()) values.putIfAbsent(uuid, uuid.toString());
            return values;
        });
        live.forEach((id, name) -> { if (!name.equals(id.toString())) result.put(id, name); else result.putIfAbsent(id, name); });
        for (UUID id : reflectedUuids("com.zaremate.admin_notes.AdminNotesAPI", "getPlayers")) result.putIfAbsent(id, id.toString());
        for (UUID id : tsaRecords().keySet()) result.putIfAbsent(id, id.toString());
        return result;
    }

    private String resolveName(MinecraftServer server, UUID uuid) {
        return names.getOrDefault(uuid, uuid.toString());
    }

    private JsonObject tsa(UUID uuid, JsonObject debug) {
        JsonObject record = tsaRecords().get(uuid);
        if (record == null) return new JsonObject();
        JsonObject result = record.deepCopy();
        result.addProperty("playerName", names.getOrDefault(uuid, uuid.toString()));
        return result;
    }

    private JsonObject ass(UUID uuid, JsonObject debug) {
        JsonObject o = new JsonObject();
        try {
            Class<?> c = Class.forName("com.zaremate.airport_security_system.AirportSecuritySystemAPI");
            debug.addProperty("ass.class", c.getName());
            Object value = c.getMethod("getPlayerOffense", UUID.class).invoke(null, uuid);
            debug.addProperty("ass.getPlayerOffense", value == null ? "null" : value.getClass().getName());

            if (!(value instanceof Optional<?> opt)) {
                debug.addProperty("ass.result", "not Optional");
                return o;
            }
            if (opt.isEmpty()) {
                debug.addProperty("ass.result", "empty");
                return o;
            }

            Object r = opt.get();
            debug.addProperty("ass.result", "record " + r.getClass().getName());
            debug.addProperty("ass.record", String.valueOf(r));
            o.addProperty("playerName", recordString(r, "playerName"));
            o.addProperty("status", recordString(r, "status"));
            o.addProperty("clearedDate", recordString(r, "clearedDate"));
            o.addProperty("totalChecks", recordLong(r, "totalChecks"));
            o.addProperty("cleanChecks", recordLong(r, "cleanChecks"));
            o.addProperty("detectedChecks", recordLong(r, "detectedChecks"));
            o.addProperty("inconclusiveChecks", recordLong(r, "inconclusiveChecks"));
            o.add("detectionDates", mapToJson(recordAccessor(r, "detectionDates")));
            o.add("detectionCounts", mapToJson(recordAccessor(r, "detectionCounts")));
            o.addProperty("available", true);
        } catch (Throwable ex) {
            Throwable cause = rootCause(ex);
            String msg = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage());
            debug.addProperty("ass.error", msg);
            LOG.warn("Admin GUI ASS API failed for {}", uuid, cause);
        }
        return o;
    }


    private JsonObject punish(UUID uuid, MinecraftServer server, JsonObject debug) {
        JsonObject o = new JsonObject();
        JsonArray offenses = new JsonArray();
        JsonArray history = new JsonArray();

        try {
            Class<?> api = Class.forName("com.zaremate.punish.api.PunishApi");
            debug.addProperty("punish.class", api.getName());

            Object rawOffenses = api.getMethod("getOffenses", MinecraftServer.class).invoke(null, server);
            if (rawOffenses instanceof Iterable<?> it) {
                for (Object offense : it) {
                    JsonObject value = new JsonObject();
                    value.addProperty("id", recordString(offense, "id"));
                    value.addProperty("group", recordString(offense, "group"));
                    value.addProperty("name", recordString(offense, "name"));
                    value.add("steps", stringListJson(recordAccessor(offense, "steps")));
                    value.add("aliases", stringListJson(recordAccessor(offense, "aliases")));
                    offenses.add(value);
                }
            }

            Object rawHistory = api.getMethod("getRecordedOffenses", MinecraftServer.class, UUID.class)
                    .invoke(null, server, uuid);
            if (rawHistory instanceof Iterable<?> it) {
                for (Object punishment : it) {
                    JsonObject value = new JsonObject();
                    value.addProperty("id", recordLong(punishment, "id"));
                    value.addProperty("offense", recordString(punishment, "offense"));
                    value.addProperty("offenseNumber", recordLong(punishment, "offenseNumber"));
                    value.addProperty("type", enumName(recordAccessor(punishment, "type")));
                    value.addProperty("reason", recordString(punishment, "reason"));
                    value.addProperty("by", recordString(punishment, "by"));
                    value.addProperty("at", recordLong(punishment, "at"));
                    value.addProperty("until", recordLong(punishment, "until"));
                    value.addProperty("active", Boolean.TRUE.equals(recordAccessor(punishment, "active")));
                    history.add(value);
                }
            }

            o.addProperty("available", true);
            o.add("offenses", offenses);
            o.add("history", history);
            return o;
        } catch (Throwable ex) {
            Throwable cause = rootCause(ex);
            String msg = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage());
            debug.addProperty("punish.error", msg);
            LOG.warn("Admin GUI Punish API failed for {}", uuid, cause);
            o.addProperty("available", false);
            o.add("offenses", offenses);
            o.add("history", history);
            return o;
        }
    }

    private JsonArray stringListJson(Object value) {
        JsonArray array = new JsonArray();
        if (value instanceof Iterable<?> it) {
            for (Object element : it) array.add(String.valueOf(element));
        }
        return array;
    }

    private String enumName(Object value) {
        if (value instanceof Enum<?> e) return e.name();
        return value == null ? "" : String.valueOf(value);
    }

    private boolean classPresent(String name) {
        try {
            Class.forName(name);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean classAvailable(String name) {
        try { Class.forName(name); return true; } catch (Throwable ignored) { return false; }
    }

    JsonArray noteSnapshot(UUID uuid, UUID viewerUuid) {
        JsonArray result = new JsonArray();
        try {
            Class<?> c = Class.forName("com.zaremate.admin_notes.AdminNotesAPI");
            Method m = c.getMethod("getNotes", UUID.class);
            Object value = m.invoke(null, uuid);
            if (value instanceof Iterable<?> it) {
                for (Object note : it) {
                    JsonObject n = new JsonObject();
                    n.addProperty("id", recordString(note, "id"));
                    String authorUuid = recordString(note, "authorUuid");
                    n.addProperty("authorUuid", authorUuid);
                    n.addProperty("author", recordString(note, "author"));
                    n.addProperty(
                            "canEdit",
                            viewerUuid != null
                                    && viewerUuid.toString().equalsIgnoreCase(authorUuid)
                                    && !Boolean.TRUE.equals(recordAccessor(note, "isSystem"))
                    );
                    n.addProperty("text", recordString(note, "text"));
                    n.addProperty("createdAt", recordLong(note, "createdAt"));
                    n.addProperty("system", Boolean.TRUE.equals(recordAccessor(note, "isSystem")));
                    result.add(n);
                }
            }
        } catch (Throwable ignored) {}
        return result;
    }

    private JsonObject teams(UUID uuid, JsonObject debug) {
        JsonObject o = new JsonObject();
        try {
            Class<?> c = Class.forName("com.zaremate.ftb_teams_util.FTBTeamsUtilAPI");
            debug.addProperty("teams.class", c.getName());
            Object value = c.getMethod("getTeam", UUID.class).invoke(null, uuid);
            debug.addProperty("teams.getTeam", value == null ? "null" : value.getClass().getName());

            if (!(value instanceof Optional<?> opt)) {
                debug.addProperty("teams.result", "not Optional");
                return o;
            }
            if (opt.isEmpty()) {
                debug.addProperty("teams.result", "empty");
                return o;
            }

            Object team = opt.get();
            debug.addProperty("teams.result", "team " + team.getClass().getName());
            debug.addProperty("teams.record", String.valueOf(team));
            o.addProperty("available", true);
            o.addProperty("id", firstString(team, "getTeamId", "getId", "getTeamID"));
            o.addProperty("name", firstString(team, "getName", "getTeamName"));

            JsonArray members = new JsonArray();
            Object raw = firstObject(team, "getMembers");
            debug.addProperty("teams.membersType", raw == null ? "null" : raw.getClass().getName());

            if (raw instanceof Iterable<?> it) {
                for (Object valueMember : it) {
                    if (!(valueMember instanceof UUID memberUuid)) continue;

                    JsonObject member = new JsonObject();
                    member.addProperty("uuid", memberUuid.toString());
                    String memberName = names.getOrDefault(memberUuid, memberUuid.toString());
                    member.addProperty("name", memberName);

                    Object rank = firstObjectWithArgs(
                            team, new Class<?>[]{UUID.class}, new Object[]{memberUuid},
                            "getRankForPlayer"
                    );
                    String rankName = rank == null ? "NONE" : String.valueOf(rank);
                    String rankDisplay = rankName;

                    if (rank != null) {
                        Object display = firstObject(rank, "getDisplayName");
                        if (display instanceof net.minecraft.network.chat.Component component) {
                            rankDisplay = component.getString();
                        }
                    }

                    member.addProperty("rank", rankName);
                    member.addProperty("rankDisplay", rankDisplay);
                    members.add(member);
                }
            }
            o.add("members", members);
            debug.addProperty("teams.memberCount", members.size());
        } catch (Throwable ex) {
            Throwable cause = rootCause(ex);
            String msg = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage());
            debug.addProperty("teams.error", msg);
            LOG.warn("Admin GUI FTB Teams API failed for {}", uuid, cause);
        }
        return o;
    }


    private JsonObject discord(UUID uuid, JsonObject debug) {
        JsonObject o = new JsonObject();
        try {
            Class<?> c = Class.forName("com.zaremate.discordlink.DiscordLinkAPI");
            debug.addProperty("discord.class", c.getName());
            Object value = c.getMethod("getPlayerLink", UUID.class).invoke(null, uuid);
            debug.addProperty("discord.getPlayerLink", value == null ? "null" : value.getClass().getName());

            if (!(value instanceof Optional<?> opt)) {
                debug.addProperty("discord.result", "not Optional");
                return o;
            }
            if (opt.isEmpty()) {
                debug.addProperty("discord.result", "empty");
                return o;
            }

            Object r = opt.get();
            debug.addProperty("discord.result", "record " + r.getClass().getName());
            debug.addProperty("discord.record", String.valueOf(r));
            o.addProperty("available", true);
            o.addProperty("discordId", recordString(r, "discordId"));
            o.addProperty("discordTag", recordString(r, "discordTag"));
            o.addProperty("displayName", recordString(r, "displayName"));
            o.addProperty("linkedAt", recordLong(r, "linkedAt"));
            Object rewarded = recordAccessor(r, "rewarded");
            o.addProperty("rewarded", rewarded instanceof Boolean b && b);
        } catch (Throwable ex) {
            Throwable cause = rootCause(ex);
            String msg = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage());
            debug.addProperty("discord.error", msg);
            LOG.warn("Admin GUI Discord API failed for {}", uuid, cause);
        }
        return o;
    }


    private JsonObject clockin(UUID uuid, JsonObject debug) {
        JsonObject o = new JsonObject();
        try {
            Class<?> c = Class.forName("com.zaremate.clockin.ClockInMod");
            debug.addProperty("clockin.class", c.getName());

            Field f = c.getDeclaredField("PLAYERS");
            f.setAccessible(true);
            Object map = f.get(null);
            debug.addProperty("clockin.PLAYERS", map == null ? "null" : map.getClass().getName());

            if (!(map instanceof Map<?, ?> players)) {
                debug.addProperty("clockin.result", "PLAYERS is not Map");
                return o;
            }

            Object data = players.get(uuid);
            if (data == null) {
                debug.addProperty("clockin.result", "no player entry");
                return o;
            }

            debug.addProperty("clockin.result", "record " + data.getClass().getName());
            debug.addProperty("clockin.record", String.valueOf(data));
            o.addProperty("available", true);
            o.addProperty("name", fieldString(data, "name"));
            o.addProperty("clockedIn", fieldBoolean(data, "clockedIn"));
            long total = fieldLong(data, "totalSeconds");
            if (fieldBoolean(data, "clockedIn")) {
                long at = fieldLong(data, "clockInAt");
                total += Math.max(0L, (System.currentTimeMillis() - at) / 1000L);
            }
            o.addProperty("totalSeconds", total);
        } catch (Throwable ex) {
            Throwable cause = rootCause(ex);
            String msg = cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage());
            debug.addProperty("clockin.error", msg);
            LOG.warn("Admin GUI ClockIn API/reflection failed for {}", uuid, cause);
        }
        return o;
    }


    private Set<UUID> clockinPlayers() {
        Set<UUID> result = new HashSet<>();
        try {
            Class<?> c = Class.forName("com.zaremate.clockin.ClockInMod");
            Field f = c.getDeclaredField("PLAYERS");
            f.setAccessible(true);
            Object map = f.get(null);
            if (map instanceof Map<?, ?> m) for (Object k : m.keySet()) if (k instanceof UUID u) result.add(u);
        } catch (Throwable ignored) {}
        return result;
    }

    private Set<UUID> reflectedUuids(String className, String methodName) {
        Set<UUID> result = new HashSet<>();
        try {
            Class<?> c = Class.forName(className);
            Object value = c.getMethod(methodName).invoke(null);
            if (value instanceof Iterable<?> it) {
                for (Object x : it) if (x instanceof UUID u) result.add(u);
            } else if (value instanceof Map<?, ?> m) {
                for (Object x : m.keySet()) if (x instanceof UUID u) result.add(u);
            }
        } catch (Throwable ignored) {}
        return result;
    }

    private Object recordAccessor(Object record, String name) {
        try {
            Method method;
            try {
                method = record.getClass().getMethod(name);
            } catch (NoSuchMethodException ex) {
                method = record.getClass().getDeclaredMethod(name);
                method.setAccessible(true);
            }
            return method.invoke(record);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private String recordString(Object record, String name) {
        Object v = recordAccessor(record, name);
        return v == null ? "" : String.valueOf(v);
    }

    private long recordLong(Object record, String name) {
        Object v = recordAccessor(record, name);
        return v instanceof Number n ? n.longValue() : 0L;
    }

    private Throwable rootCause(Throwable throwable) {
        Throwable current = throwable;
        while (current.getCause() != null
                && current.getCause() != current
                && (current instanceof java.lang.reflect.InvocationTargetException
                    || current.getCause() instanceof java.lang.reflect.InvocationTargetException
                    || current.getCause() != null)) {
            if (current.getCause() == current) break;
            current = current.getCause();
        }
        return current;
    }

    private Object firstObjectWithArgs(
            Object target,
            Class<?>[] parameterTypes,
            Object[] args,
            String... methods
    ) {
        for (String method : methods) {
            try {
                Method m;
                try {
                    m = target.getClass().getMethod(method, parameterTypes);
                } catch (NoSuchMethodException ex) {
                    m = target.getClass().getDeclaredMethod(method, parameterTypes);
                    m.setAccessible(true);
                }
                return m.invoke(target, args);
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private String firstString(Object target, String... methods) {
        for (String methodName : methods) {
            Object value = firstObject(target, methodName);
            if (value instanceof net.minecraft.network.chat.Component component) {
                String text = component.getString();
                if (!text.isBlank()) return text;
            }
            if (value != null && !value.toString().isBlank()) return value.toString();
        }
        return "";
    }

    private Object firstObject(Object target, String... methods) {
        for (String methodName : methods) {
            try {
                Method method;
                try {
                    method = target.getClass().getMethod(methodName);
                } catch (NoSuchMethodException ex) {
                    method = target.getClass().getDeclaredMethod(methodName);
                    method.setAccessible(true);
                }
                return method.invoke(target);
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private JsonObject mapToJson(Object value) {
        JsonObject o = new JsonObject();
        if (value instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                Object v = e.getValue();
                if (v instanceof Number n) o.addProperty(String.valueOf(e.getKey()), n);
                else o.addProperty(String.valueOf(e.getKey()), String.valueOf(v));
            }
        }
        return o;
    }

    private String fieldString(Object o, String field) {
        try { return String.valueOf(o.getClass().getField(field).get(o)); }
        catch (Throwable ignored) { return ""; }
    }

    private long fieldLong(Object o, String field) {
        try {
            Object v = o.getClass().getField(field).get(o);
            return v instanceof Number n ? n.longValue() : 0L;
        } catch (Throwable ignored) { return 0L; }
    }

    private boolean fieldBoolean(Object o, String field) {
        try { return o.getClass().getField(field).getBoolean(o); }
        catch (Throwable ignored) { return false; }
    }
}
