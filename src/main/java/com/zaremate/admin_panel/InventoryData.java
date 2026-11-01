package com.zaremate.admin_panel;

import com.google.gson.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.component.DataComponents;
import net.minecraft.nbt.*;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.ItemStack;
import net.neoforged.fml.ModList;
import net.neoforged.neoforge.items.IItemHandler;
import java.util.*;
import java.util.function.IntFunction;

/** Read-only snapshots. Never loads an offline player entity or writes player data. */
final class InventoryData {
    static JsonObject readLive(MinecraftServer server, UUID id) {
        var online = server.getPlayerList().getPlayer(id);
        JsonObject result = new JsonObject();
        result.addProperty("source", online == null ? "saved" : "live");
        result.addProperty("capturedAt", System.currentTimeMillis());
        if (online != null) {
            result.add("inventory", inventory(i -> online.getInventory().getItem(i), online.getInventory().selected));
            result.add("enderChest", container("Ender Chest", 27, i -> online.getEnderChestInventory().getItem(i)));
            result.add("curios", curios(online));
            return result;
        }
        throw new IllegalStateException("Live inventory requested for an offline player");
    }
    // Registry/component codecs remain on the server thread; disk read and decompression already finished.
    static JsonObject readSaved(MinecraftServer server, SavedPlayer saved) {
        JsonObject result = new JsonObject();
        result.addProperty("source", "saved"); result.addProperty("capturedAt", System.currentTimeMillis());
        result.add("curios", unavailable("Curios inspection requires an online player."));
        if (saved.data() == null) {
            result.add("inventory", unavailable(saved.error()));
            result.add("enderChest", unavailable(saved.error()));
            return result;
        }
        try {
            CompoundTag data = saved.data();
            result.addProperty("savedAt", saved.savedAt());
            ItemStack[] items = empty(41), ender = empty(27);
            if (data.contains("Inventory", Tag.TAG_LIST)) {
                for (Tag raw : data.getList("Inventory", Tag.TAG_COMPOUND)) {
                    CompoundTag entry = (CompoundTag) raw;
                    int slot = inventoryIndex(entry.getByte("Slot") & 255);
                    if (slot >= 0) items[slot] = ItemStack.parse(server.registryAccess(), entry).orElseThrow(() -> new IllegalArgumentException("Unreadable saved item"));
                }
                result.add("inventory", inventory(i -> items[i], data.getInt("SelectedItemSlot")));
            } else result.add("inventory", unavailable("Saved inventory is missing or has an unsupported format."));
            if (data.contains("EnderItems", Tag.TAG_LIST)) {
                for (Tag raw : data.getList("EnderItems", Tag.TAG_COMPOUND)) {
                    CompoundTag entry = (CompoundTag) raw;
                    int slot = entry.getByte("Slot") & 255;
                    if (slot < 27) ender[slot] = ItemStack.parse(server.registryAccess(), entry).orElseThrow(() -> new IllegalArgumentException("Unreadable saved item"));
                }
                result.add("enderChest", container("Ender Chest", 27, i -> ender[i]));
            } else result.add("enderChest", unavailable("Saved Ender Chest is missing or has an unsupported format."));
        } catch (Exception e) {
            result.add("inventory", unavailable("Could not decode the saved inventory with this server's item registry."));
            result.add("enderChest", unavailable("Could not decode the saved Ender Chest."));
        }
        return result;
    }
    static int inventoryIndex(int savedSlot) {
        if (savedSlot >= 0 && savedSlot < 36) return savedSlot;
        if (savedSlot >= 100 && savedSlot <= 103) return savedSlot - 64;
        return savedSlot == 150 ? 40 : -1;
    }
    private static ItemStack[] empty(int size) { ItemStack[] a = new ItemStack[size]; Arrays.fill(a, ItemStack.EMPTY); return a; }
    static JsonObject unavailable(String reason) { JsonObject r = new JsonObject(); r.addProperty("available", false); r.addProperty("reason", reason); return r; }
    private static JsonObject inventory(IntFunction<ItemStack> items, int selected) {
        JsonObject r = new JsonObject(); r.addProperty("available", true);
        JsonArray groups = new JsonArray();
        groups.add(group("Hotbar", 9, i -> items.apply(i), i -> "Hotbar " + (i+1), selected));
        groups.add(group("Main inventory", 27, i -> items.apply(i+9), i -> "Slot " + (i+9), -1));
        groups.add(group("Armor", 4, i -> items.apply(39-i), i -> List.of("Helmet", "Chestplate", "Leggings", "Boots").get(i), -1));
        groups.add(group("Offhand", 1, i -> items.apply(40), i -> "Offhand", -1));
        r.add("groups", groups); return r;
    }
    private static JsonObject container(String name, int size, IntFunction<ItemStack> items) {
        JsonObject r = new JsonObject(); r.addProperty("available", true); JsonArray groups = new JsonArray();
        groups.add(group(name, size, items, i -> "Slot " + i, -1)); r.add("groups", groups); return r;
    }
    private static JsonObject group(String name, int size, IntFunction<ItemStack> items, IntFunction<String> labels, int selected) {
        JsonObject r = new JsonObject(); r.addProperty("name", name); JsonArray slots = new JsonArray();
        for (int i=0; i<size; i++) { JsonObject slot = item(items.apply(i)); slot.addProperty("slot", i); slot.addProperty("label", labels.apply(i)); slot.addProperty("selected", i == selected); slots.add(slot); }
        r.add("slots", slots); return r;
    }
    static JsonObject item(ItemStack stack) {
        JsonObject r = new JsonObject(); r.addProperty("empty", stack.isEmpty());
        if (stack.isEmpty()) return r;
        r.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        r.addProperty("name", stack.getHoverName().getString()); r.addProperty("count", stack.getCount());
        if (stack.isDamageableItem()) { r.addProperty("damage", stack.getDamageValue()); r.addProperty("maxDamage", stack.getMaxDamage()); }
        JsonArray enchants = new JsonArray();
        stack.getEnchantments().entrySet().forEach(e -> enchants.add(e.getKey().value().description().getString() + " " + e.getIntValue()));
        // Enchanted books keep their enchantments in a distinct component.
        var stored = stack.get(DataComponents.STORED_ENCHANTMENTS);
        if (stored != null) stored.entrySet().forEach(e -> enchants.add(e.getKey().value().description().getString() + " " + e.getIntValue()));
        r.add("enchantments", enchants);
        JsonArray lore = new JsonArray(); var itemLore = stack.get(DataComponents.LORE);
        if (itemLore != null) itemLore.lines().forEach(line -> lore.add(line.getString()));
        r.add("lore", lore); return r;
    }
    private static JsonObject curios(net.minecraft.server.level.ServerPlayer player) {
        if (!ModList.get().isLoaded("curios")) return unavailable("Curios is not installed on this server.");
        try {
            Class<?> api = Class.forName("top.theillusivec4.curios.api.CuriosApi");
            Object raw = api.getMethod("getCuriosInventory", net.minecraft.world.entity.LivingEntity.class).invoke(null, player);
            if (!(raw instanceof Optional<?> optional) || optional.isEmpty()) return unavailable("No Curios inventory is attached to this player.");
            Class<?> inventory = Class.forName("top.theillusivec4.curios.api.type.capability.ICuriosItemHandler");
            Class<?> slots = Class.forName("top.theillusivec4.curios.api.type.inventory.ICurioStacksHandler");
            Map<?,?> handlers = (Map<?,?>) inventory.getMethod("getCurios").invoke(optional.get());
            JsonArray groups = new JsonArray();
            for (var entry : handlers.entrySet().stream().sorted(Comparator.comparing(e -> e.getKey().toString())).toList()) {
                String name = entry.getKey().toString();
                for (String method : List.of("getStacks", "getCosmeticStacks")) {
                    IItemHandler handler = (IItemHandler) slots.getMethod(method).invoke(entry.getValue());
                    if (handler.getSlots() > 512) throw new IllegalArgumentException("Too many accessory slots");
                    groups.add(group(name + (method.equals("getStacks") ? " · Equipped" : " · Cosmetic"), handler.getSlots(), handler::getStackInSlot, i -> name + " " + (i+1), -1));
                }
            }
            JsonObject r = new JsonObject(); r.addProperty("available", true); r.add("groups", groups); return r;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) { return unavailable("Curios inventory could not be read. Check that its API supports Minecraft 1.21.1."); }
    }
}
