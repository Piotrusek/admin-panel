# Admin Panel

A server-side web companion to [ZareMate/admin-gui](https://github.com/ZareMate/admin-gui), for **Minecraft 1.21.1 / NeoForge 21.1.249 / Java 21**. The website runs in a separate Node.js service using Fastify and React. Minecraft opens an outbound authenticated WebSocket connection to it; no panel HTTP port is opened inside Minecraft. Clients only need a browser.

## Separate Node web app

The hosting app is **Fastify + TypeScript**, with a **React + TypeScript** frontend in [`web-server/`](web-server/README.md). Minecraft opens one outbound WebSocket connection to its `/bridge` route. The page, API, and WebSocket share one port; no web listener or certificate files run inside Minecraft.

`gradle build` produces:

- `build/libs/admin_panel-2.0.0.jar` for Minecraft.
- `build/distributions/admin_panel-2.0.0-web.zip` for Node hosting. Unpack it and run `npm ci --omit=dev`, `npm run setup`, then `npm start` after configuring it.

For source development: `cd web-server`, `npm ci`, `npm run build`, `npm run setup`, then `npm start`. Node.js 22.12+ is required. Configuration and persistent audit data live on the web host. Existing properties files, account hashes, Discord UUID mappings, and audit history can be copied across.

Minecraft's `config/admin-panel-bridge.properties`:

```properties
enabled=true
url=wss://YOUR_WEB_HOST/bridge
token=SAME_VALUE_AS_ADMIN_PANEL_BRIDGE_TOKEN_ON_THE_WEB_HOST
```

For a trusted private plaintext connection use `ws://HOST:PORT/bridge` with `allow-insecure-ws=true`. The web host handles HTTPS if available; this app does not require you to create certificates on the Minecraft hosting. See the [Node deployment guide](web-server/README.md) for hosting variables, plain WS, HTTPS proxying, and migration. A framework alone does not provide a trusted certificate for an HTTP-only hosting endpoint.

The earlier standalone Java web-service JAR has been replaced; use the Node archive above. No second WebSocket port is required.

## Features

- Search online and known offline players by name or UUID, with status filters and live pushed updates.
- Selected-player state updates approximately once per second while viewed; unchanged snapshots are suppressed and subscriptions recover after reconnect.
- Player profiles with Discord identity, FTB Teams, ClockIn, TSA Anticheat checks/detections, and Airport Security records.
- Punish history, direct warnings/kicks/mutes/bans, and configured offense escalation through the real Punish API.
- Remove configured offense cases through Punish’s existing removal path, preserving its related-punishment and ban-list handling.
- Add/edit/remove Admin Notes using its own persistence and author-ownership rules.
- Discord sign-in with configurable guild rank precedence, explicit tab and action permissions, login-time role checks, OAuth state protection, CSRF protection, and duplicate-request protection. Legacy local login remains an explicit compatibility option.
- Durable JSONL audit entries for successful logins, mutation requests, and their outcomes. Staff with `tab.audit` can inspect/export the latest 500 events in the browser.

The existing mods remain authoritative. This mod does not copy their databases. Missing optional mods or missing player records are shown as unavailable; no demo data is presented as live data.

## Inventory and item icons

The player profile has read-only **Inventory**, **Ender Chest**, and **Curios** tabs, each controlled by its own permission.

- Online players: live hotbar, main inventory, armor, offhand, and Ender Chest snapshots.
- Offline players: inventory and Ender Chest from the world’s existing player `.dat` file, labeled with its save time. Missing or undecodable saves show an unavailable message. Player data is never modified.
- Curios: equipped and cosmetic groups via the installed Curios API (1.21.1 API shape, checked against 9.2.2). Offline Curios is explicitly unavailable.
- Item details: names, registry IDs, stack counts, durability, enchantments, and lore. Expand an occupied slot for details.

Icons are rendered on the web host using bundled PNGs and optional mod jars copied into its `data/assets/` directory (read as ZIP data, never loaded as mods). The resolver follows generated/handheld item model parents and texture references, composites up to five layers, and shows the first square frame of vertical animation strips. Results are resized to 64×64 PNGs and cached in memory. Icons are requested in authenticated batches, not separate requests per slot.

The Node host renders generated textures and static cuboid geometry, including model UVs and GUI transforms, using Sharp. This is a preview, not Minecraft's client renderer: custom renderers, world tinting, state-dependent overrides, and client resource-pack overrides retain labeled fallbacks. Item information remains available when an icon cannot be rendered. Java desktop/image-processing support is not required on Minecraft or the web host.

## Build

```sh
gradle build
```

The default build uses the sibling repositories’ built jars:

- `../admin-gui/build/libs/admin_gui-2.0.0.jar`
- `../punish/build/libs/punish-1.0.0.jar`

To build from another checkout:

```sh
gradle build -PadminGuiJar=/absolute/path/admin_gui-2.0.0.jar -PpunishJar=/absolute/path/punish-1.0.0.jar
```

Both jars are required at compile time and are **not bundled**. Output: `build/libs/admin_panel-2.0.0.jar`. The default build targets Admin GUI 2.0.0 and the Punish API including `PunishService.removeOffense`.

## Install and configure Discord login

1. Replace the old panel jar in the dedicated server’s `mods/` folder with `admin_panel-2.0.0.jar`. Keep Admin GUI and the desired integration mods installed; remove older panel jars.
2. Create/select an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its OAuth2 **client ID** and **client secret** into the server configuration. A bot token is not needed.
3. Register the **exact** OAuth2 redirect URI `<origin>/api/auth/discord/callback`. For the current LAN origin this is `http://10.0.0.1:8080/api/auth/discord/callback`. If Discord does not accept your chosen HTTP redirect, use the HTTPS proxy setup in the Node deployment guide and register that HTTPS origin instead.
4. Merge the settings below into `config/admin-panel.properties`, set `enabled=true` on the web host and restart the Node service. The browser shows **Continue with Discord**.

```properties
enabled=true
bind=0.0.0.0
port=8080
origin=http://10.0.0.1:8080
allow-insecure-http=true
auth.mode=discord
discord.client-id=YOUR_APPLICATION_CLIENT_ID
discord.client-secret=YOUR_APPLICATION_CLIENT_SECRET
discord.guild-id=1506410587553398854
discord.rank-order=dev,owner,admin,mod,trial-mod,helper,trial-helper
```

The secret can instead come from `ADMIN_PANEL_DISCORD_CLIENT_SECRET`, which takes precedence over the config entry. Keep it server-side; it is never sent to the browser. In Docker, publish TCP 8080 from the container running the standalone web service.

The [web configuration template](web-server/admin-panel.example.properties) lists the rank role-ID fields and explicit permissions. Set `discord.rank.<rank>.role-id` and `discord.rank.<rank>.permissions`. The first matching rank in `discord.rank-order` wins; permissions from lower ranks are not combined. Empty permissions or a missing `panel.access` permission deny login. Restart Node after changing configuration.

For example, a trial moderator who can read profiles and notes and edit their own notes:

```properties
discord.rank.trial-mod.permissions=panel.access,tab.players,tab.overview,tab.notes,notes.edit
```

See the [permission reference](web-server/README.md#permissions) for every tab and action. Old `.access` entries are accepted for migration; an explicit `.permissions` entry always overrides them. Saving ranks in the web UI writes explicit permissions.

The server verifies guild membership and current role IDs only at login. Normal panel requests and moderation actions use the rank saved in the session and make no Discord API calls. Role changes or leaving the guild take effect on the next login; existing sessions retain their login-time access until logout, expiry, or server restart. Discord outages/rate limits block new logins but do not interrupt existing sessions. Login itself remains subject to Discord rate limits. Sessions expire after at most eight hours or when the OAuth access token expires, whichever comes first. OAuth tokens are discarded after the login exchange; logout ends the panel session but does not remove the application from the user’s Discord Authorized Apps.

The flow uses the authorization-code grant with `identify` and `guilds.members.read`, and a one-use, five-minute OAuth state tied to an HttpOnly browser cookie. See [Discord OAuth2 documentation](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx).

### Staff note identity

Audit/punishment authors include the Discord username and stable user ID. For note ownership, Discord accounts get stable, namespaced author UUIDs. Optionally map an account to its real Minecraft UUID to share ownership of existing in-game notes:

```properties
discord.minecraft.DISCORD_USER_ID=MINECRAFT_UUID
```

These are trusted administrator mappings, not values supplied by the user’s browser. Changing a mapping changes which existing notes that account owns. Discord login does not automatically use the Discord Link mod’s player database or inherit LuckPerms/operator privileges.

### Legacy local login

Existing configurations without `auth.mode` retain local login for migration. New generated configurations use Discord. Setting `auth.mode=discord` disables the password endpoint and ignores all `user.*` entries; there is no password fallback if Discord is unavailable.

To deliberately use the old mode, set `auth.mode=local`, generate `user.*` entries with `python3 tools/create-user.py`, and restart. Local passwords are salted PBKDF2 hashes; local sessions last eight hours.

### Remote access

Configure HTTPS, the public origin, proxy trust, and WebSocket forwarding on the Node host. See the [Node deployment guide](web-server/README.md) for the current nginx configuration and Docker settings. Forward upgrades for both `/bridge` and `/api/live`. Minecraft only needs its outbound bridge URL and shared token.

For a trusted private HTTP network, set `allow-insecure-http=true` on the web host and `allow-insecure-ws=true` on Minecraft when using a remote `ws://` URL. Restart the affected service after changing its configuration.

## Permissions

Ranks grant individual permissions for each tab and action. The **Rank access** editor displays checkboxes and requires `access.manage`; no rank name automatically grants privileges. At least one saved rank must retain `panel.access` and `access.manage`.

Permissions are enforced in HTTP endpoints, browser live streams, and Minecraft mutation handling. Hidden tabs also have their data removed from profile responses. Note editing/removal still requires ownership of a non-system note.

On the **Punishments** tab, `punish.remove` permits removing a direct warning, kick record, mute, or ban. Removal preserves history and records the remover; removing a kick record cannot undo the original kick. `punish.revoke` removes an entire configured offense case and its related punishments. An unrelated live ban for the same UUID/IP stays enforced. Removal reasons are recorded in the web audit log.

All mutation checks run server-side. Game/mod API access runs on the Minecraft server thread. Direct kick requires an online player. Durations are explicit, and zero means permanent. Configured offenses use the mod’s own escalation steps. Arbitrary console commands are not exposed.

## Operational details and limits

- Audit file: `logs/admin-panel-audit.jsonl`. Back it up alongside the underlying mods’ data. It contains moderation reasons and note text; restrict filesystem access. It is append-only from the panel, not cryptographically tamper-proof against server operators.
- Each mutation writes a durable `requested` record before invoking the mod, then its result. A timeout or exception may leave execution unconfirmed: inspect the player and audit before retrying. Request IDs prevent resubmission within the current server/session lifetime; they are not a cross-restart exactly-once guarantee.
- Offense case removal is supported. Direct warnings, kick records, mutes and bans can also be removed in the web UI with `punish.remove`. IP-based punishment creation and arbitrary server commands are not exposed.
- History lists records belonging to the selected UUID, with IP values hidden. It is not a complete cross-account IP investigation view.
- Player discovery and integration availability follow Admin GUI’s APIs. An unavailable integration record can mean the optional mod is absent, incompatible, or has no data for that player.
- The Fastify web service and Java bridge bound request sizes, pending commands and live subscriptions. Large snapshots are batched on both WebSocket hops; see the [transport limits](web-server/README.md#batched-data-transport).
## Automated tests

`gradle build` runs the current suites; a failure fails the build:

- `gradle bridgeTest`: Java bridge configuration, request validation, explicit permissions, moderation bounds, exact-record removal planning, and Unicode-safe batching.
- `gradle webTest`: Fastify authentication/CSRF/audit, Discord OAuth errors and login snapshots, permissions, image resolution, live subscriptions, reconnects, and bounded batches. Runs the real Java bridge against Node, including a 9 MiB transfer, and the production React UI in Chromium.
- `gradle webTypecheck`: TypeScript validation, including unused imports, locals and parameters.
- `gradle verifyModJar`: ensures the mod artifact contains no retired Java web-server classes, legacy pages, bundled icons, or test fixtures.

`webTest` builds the web app first. It requires Node.js 22.12+, Python 3, Chromium, and matching `chromedriver` on PATH. Browser failure artifacts are written to `build/reports/react-browser/`. Containers unable to support Chromium's normal sandbox may explicitly set `PANEL_TEST_NO_SANDBOX=1` for tests.

The retired embedded Java server, setup pages, image renderer and their duplicate test suites have been removed. Web authentication, assets and UI are tested against the Node/React implementation. Existing properties/account migration remains supported by Node; the local account generator in `tools/create-user.py` is still used.

Tests use temporary data and fake game/Discord services. They do not perform live Discord authorization or verify third-party mod enforcement on an installed Minecraft server.

## Standalone Discord bot

The optional [Discord bot](discord-bot/README.md) runs separately from Minecraft and Node hosting. Set its own bot token and guild ID to log in and print visible channels to its console. It can also categorize ticket channels and sync them to the permission-controlled Tickets tab; see its README for setup.

To start both services in a detached tmux session, run `./start.sh` from this checkout (or use its absolute path). It creates three panes: web server, interactive shell, and Discord bot. Attach with `tmux attach -t admin-panel`. Repeated runs leave an existing session alone; exited services leave a shell open for inspecting errors.

Install tmux and Node.js 22.12+, configure each service's `.env`, and run `npm ci` and `npm run build` in both `web-server/` and `discord-bot/` first. The script uses its own directory as the project path and runs as `zaremate`; edit `RUN_AS` if needed. Root launches switch to that user with `runuser`. For cron, use the absolute script path and ensure Node/npm and tmux are on the cron `PATH` (shell-based Node version managers are not loaded automatically).


### Bridge threading

Panel requests and live subscriptions run on the bounded bridge worker. Player
list sorting, profile-cache file reads, TSA report parsing, offline player NBT
reads/decompression, offline playtime reads, response assembly, permission filtering,
and WebSocket serialization run there. TSA 1.x reports are read once per second at
most per bridge instance; no legacy TSA `getPlayer()`/`getPlayers()` call is made,
so a server with the older blocking TSA API does not scan files on its tick thread.
Detection changes may take a refresh interval plus worker backlog to appear.

Small server-thread captures retain ownership of live players, inventories, Curios,
team/ClockIn/Discord/ASS state, and Punish snapshots. Saved item component codecs
also run on the server thread after the worker has read and decompressed NBT.
Moderation and note mutations remain on the server thread to preserve the owning
mods' live-state and authorization behavior; those mods may perform persistence
inside their own mutation APIs. Mutations no longer load a full player profile or
TSA history first. Server captures time out after 15 seconds; queued captures and
mutations are cancelled when the bridge shuts down or the wait times out. Already
started mutations cannot be rolled back automatically.

The web service already performs its HTTP/database work outside Minecraft. These
changes affect the Java bridge; deploy the rebuilt mod and restart Minecraft.
