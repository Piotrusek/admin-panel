package com.zaremate.admin_panel;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/** Current Java bridge contracts; web authentication/UI are tested against Node. */
public final class BridgeTest {
    public static void main(String[] args) throws Exception {
        int checks = ThreadingTest.run() + ModerationTest.run() + PunishmentRemovalTest.run() + BridgeBatchesTest.run();
        checks += configChecks();
        for(String value:List.of("null","42","true","{}","[]","\"\"","\"  \"","\"bad\\tfield\"")){
            var body=new JsonObject();body.add("value",JsonParser.parseString(value));
            try{RequestFields.string(body,"value",20);throw new AssertionError("Invalid field accepted: "+value);}catch(IllegalArgumentException expected){checks++;}
        }
        var text=new JsonObject();text.addProperty("value","line one\nline two");
        if(!RequestFields.string(text,"value",17).equals("line one\nline two"))throw new AssertionError("Multiline notes");checks++;
        Set<String> grants=new HashSet<>(Set.of("tab.players"));var staff=new StaffActor("name",UUID.randomUUID(),"custom",grants);grants.clear();
        if(!staff.has("tab.players"))throw new AssertionError("Permissions must be immutable snapshots");checks++;
        System.out.println("PASS: " + checks + " Java bridge checks (configuration, validation, permissions, moderation, removal and batching).");
    }
    private static int configChecks() throws Exception {
        int checks=0;Path dir=Files.createTempDirectory("panel-bridge-config-");Path path=dir.resolve("config/bridge.properties");
        try {
            if(BridgeConfig.load(path)!=null||!Files.readString(path).contains("enabled=false"))throw new AssertionError("Disabled first-run template");checks++;
            String token="x".repeat(43);
            for(String url:List.of("ws://localhost:8081/bridge","ws://127.0.0.1/bridge","ws://[::1]/bridge","wss://panel.example/bridge")){
                Files.writeString(path,"enabled=true\nurl="+url+"\ntoken="+token+"\n");
                if(!BridgeConfig.load(path).url().toString().equals(url))throw new AssertionError("Valid URL rejected");checks++;
            }
            for(String url:List.of("https://panel.example/bridge","ws://panel.example/bridge","wss://u:p@panel.example/bridge","wss://panel.example/other","wss://panel.example/bridge?token=x","wss://panel.example/bridge#x")){
                Files.writeString(path,"enabled=true\nurl="+url+"\ntoken="+token+"\n");
                try{BridgeConfig.load(path);throw new AssertionError("Unsafe URL accepted");}catch(IllegalArgumentException expected){checks++;}
            }
            Files.writeString(path,"enabled=true\nurl=ws://panel.example/bridge\nallow-insecure-ws=true\ntoken="+token+"\n");
            if(BridgeConfig.load(path)==null)throw new AssertionError("Explicit private WS opt-in");checks++;
            for(String value:List.of("","x".repeat(42),"x".repeat(129),"!".repeat(43))){
                try{BridgeConfig.requireToken(value);throw new AssertionError("Invalid token accepted");}catch(IllegalArgumentException expected){checks++;}
            }
        } finally {try(var files=Files.walk(dir)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())Files.delete(file);}}
        return checks;
    }
}
