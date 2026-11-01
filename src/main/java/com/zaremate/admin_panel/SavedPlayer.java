package com.zaremate.admin_panel;

import net.minecraft.nbt.*;
import java.nio.file.*;

/** Owned by a single request; decoded on the worker before registry-dependent item parsing. */
record SavedPlayer(CompoundTag data, long savedAt, String error) {
    static SavedPlayer read(Path path) {
        if (!Files.isRegularFile(path)) return new SavedPlayer(null, 0, "No saved player data found. The player must join this server first.");
        try {
            return new SavedPlayer(NbtIo.readCompressed(path, NbtAccounter.create(16 * 1024 * 1024)),
                    Files.getLastModifiedTime(path).toMillis(), null);
        } catch (Exception error) {
            return new SavedPlayer(null, 0, "Could not read the saved player data.");
        }
    }
}
