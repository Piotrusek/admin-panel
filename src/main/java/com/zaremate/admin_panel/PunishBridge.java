package com.zaremate.admin_panel;

import com.google.gson.*;
import com.mojang.authlib.GameProfile;
import com.zaremate.punish.*;
import com.zaremate.punish.api.*;
import net.minecraft.server.MinecraftServer;
import java.util.*;

/** Loaded only when Punish is present. Never dispatches arbitrary console commands. */
final class PunishBridge {
    static JsonArray captureHistory(MinecraftServer server, UUID id) {
        JsonArray a = new JsonArray();
        PunishMod.service(server.getServerDirectory()).db().records().stream()
                .filter(r -> id.toString().equals(r.uuid))
                .forEach(r -> { JsonObject row = r.toJson(); row.remove("ip"); row.remove("seenAccounts"); a.add(row); });
        return a;
    }
    static JsonElement mutate(MinecraftServer server, UUID id, String name, StaffActor actor, String action, JsonObject b) {
        var service = PunishMod.service(server.getServerDirectory());
        ModerationRequest request = ModerationRequest.parse(actor, action, b, server.getPlayerList().getPlayer(id) != null,
                service.offenses().stream().map(o -> o.id()).collect(java.util.stream.Collectors.toSet()));
        String reason = request.reason();
        JsonObject result = new JsonObject();
        if (action.equals("revoke")) {
            long caseId = request.caseId();
            boolean exists = service.db().records().stream().anyMatch(r -> id.toString().equals(r.uuid) && r.caseId == caseId && r.offense != null && r.removedBy == null);
            if (!exists) throw new BridgeFailure(409, "Offense case is missing or already removed");
            var online = server.getPlayerList().getPlayer(id);
            var target = new PunishService.Target(name, id.toString(), null, new GameProfile(id, name), online);
            int count = service.removeOffense(server, target, caseId, new net.minecraft.commands.CommandSourceStack(server, net.minecraft.world.phys.Vec3.ZERO, net.minecraft.world.phys.Vec2.ZERO, server.overworld(), 4, actor.name(), net.minecraft.network.chat.Component.literal(actor.name()), server, null));
            result.addProperty("removed", count); result.addProperty("reason", reason); return result;
        }
        if (action.equals("remove-punishment")) {
            long now = System.currentTimeMillis();
            var plan = PunishmentRemoval.plan(service.db().records().stream().map(r -> new PunishmentRemoval.Entry(
                    r.id, r.uuid, r.offense, r.removedBy, r.type, r.ipBased, r.ip, r.live(now))).toList(), request.caseId(), id);
            var record = service.db().records().stream().filter(r -> r.id == plan.record().id()).findFirst().orElseThrow();
            var source = new net.minecraft.commands.CommandSourceStack(server, net.minecraft.world.phys.Vec3.ZERO, net.minecraft.world.phys.Vec2.ZERO, server.overworld(), 4, actor.name(), net.minecraft.network.chat.Component.literal(actor.name()), server, null);
            service.lift(record, source);
            service.save();
            // Preserve unrelated bans for the same UUID or IP.
            if (plan.clearBan()) {
                if (record.ipBased && record.ip != null) server.getPlayerList().getIpBans().remove(record.ip);
                else if (!record.ipBased) server.getPlayerList().getBans().remove(new GameProfile(id, name));
            }
            result.addProperty("removed", 1); result.addProperty("recordId", record.id); result.addProperty("reason", reason); return result;
        }
        String type = request.type();
        boolean silent = request.silent();
        if (type.equals("OFFENSE")) {
            String offense = request.offense();
            var applied = PunishApi.addPunishment(server, id, name, offense, "Web review: " + reason, actor.name(), silent);
            result.addProperty("records", applied.size());
        } else {
            PunishmentType kind = PunishmentType.valueOf(type);
            var record = PunishApi.addPunishment(server, id, name, kind, false, null, request.durationMillis(), reason, actor.name(), silent);
            result.addProperty("id", record.id());
        }
        result.addProperty("status", "applied"); return result;
    }
}
