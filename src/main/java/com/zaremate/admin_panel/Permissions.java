package com.zaremate.admin_panel;
import java.util.*;
import com.google.gson.*;
final class Permissions {
 static final Set<String> ALL=Set.of("suggestions.reply", "tab.todo", "todo.create", "todo.edit", "todo.delete", "tab.suggestions", "suggestions.tags", "suggestions.status", "suggestions.create", "suggestions.delete", "tickets.reply", "tab.tickets", "tickets.lost-items-or-airship", "tickets.other-support", "tickets.cant-connect-to-the-server", "tickets.buy-a-shop-plot-at-spawn", "tickets.stealing-or-grieffing", "tickets.player-report", "tickets.report", "tickets.uncategorized", "panel.access", "tab.players", "tab.overview", "tab.cases", "tab.notes", "tab.security", "tab.inventory", "tab.enderChest", "tab.curios", "tab.audit", "access.manage", "notes.add", "notes.edit", "notes.remove", "punish.warn", "punish.kick", "punish.mute", "punish.ban", "punish.offense", "punish.remove", "punish.revoke");
 static Set<String> parse(JsonArray values) {
  if(values==null)throw new IllegalArgumentException("Explicit permissions required");
  Set<String> out=new HashSet<>();
  for(JsonElement value:values){if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString()||!ALL.contains(value.getAsString()))throw new IllegalArgumentException("Unknown permission");out.add(value.getAsString());}
  return Set.copyOf(out);
 }
 static void mutation(StaffActor user,String action,JsonObject body) {
  user.require("tab.players");user.require(action.startsWith("note-")?"tab.notes":"tab.cases");
  String permission=switch(action){
   case "punish" -> "punish."+RequestFields.string(body,"type",16).toLowerCase(Locale.ROOT);
   case "revoke" -> "punish.revoke";
   case "remove-punishment" -> "punish.remove";
   case "note-add" -> "notes.add";
   case "note-edit" -> "notes.edit";
   case "note-remove" -> "notes.remove";
   default -> throw new IllegalArgumentException("Unknown action");
  };user.require(permission);
 }
 static JsonObject detail(JsonObject input,StaffActor user) {
  user.require("tab.players");JsonObject out=new JsonObject();
  copy(input,out,"uuid","name","online","updatedAt");
  if(user.has("tab.overview"))copy(input,out,"location","playtime","discord","teams","clockin");
  if(user.has("tab.cases"))copy(input,out,"cases","punish");
  if(user.has("tab.notes"))copy(input,out,"notes","notesAvailable");
  if(user.has("tab.security"))copy(input,out,"tsa","ass","hasDetections");
  if(input.has("storage")){
   JsonObject storage=new JsonObject(),source=input.getAsJsonObject("storage");
   for(String key:List.of("inventory","enderChest","curios"))if(user.has("tab."+key))copy(source,storage,key);
   if(!storage.isEmpty()){copy(source,storage,"source","savedAt","capturedAt");out.add("storage",storage);}
  }return out;
 }
 private static void copy(JsonObject source,JsonObject out,String... keys){for(String key:keys)if(source.has(key))out.add(key,source.get(key).deepCopy());}
}
