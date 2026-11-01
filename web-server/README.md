# Admin Panel web app

A separate **Node.js + Fastify + TypeScript** server and **React + TypeScript** UI. Minecraft only opens an outbound WebSocket connection. There is no Java web-server process, Minecraft installation, or certificate file required by this app.

The website, HTTP API, and `/bridge` WebSocket share **one port**. Authentication, Discord OAuth, audit persistence, skins, and icon rendering run here. Minecraft performs game-state reads and changes through the existing mod APIs.

## Run from source

Requires Node.js 22.12+ (Node 24 LTS recommended) and npm. From `web-server/`:

```sh
npm ci
npm run build
npm run setup
```

Setup creates `.env` with a random bridge secret and a disabled `data/config/admin-panel.properties` template. It never overwrites existing files. Edit the configuration, fill in your Discord settings and role IDs (or local `user.*` accounts), and set `enabled=true`. Set the public URL in `.env`, then:

```sh
npm start
```

You can instead copy your existing `config/admin-panel.properties` to `data/config/admin-panel.properties` and `logs/admin-panel-audit.jsonl` to `data/logs/admin-panel-audit.jsonl`. Existing local password hashes, Discord rank order, and Minecraft UUID mappings remain compatible. Discord-derived author UUIDs are unchanged, preserving note ownership. Sessions require a fresh login. Discord roles are checked at login and retained in the session; normal page refreshes do not query Discord.

For deployment without source, unpack `build/distributions/admin_panel-2.0.0-web.zip`, run `npm ci --omit=dev`, then `npm run setup` and `npm start`. React is already built in that archive. Keep `data/` on persistent storage. Run **one Node instance per Minecraft server**; bridge connections and browser sessions are process-local.

## Connect Minecraft

Install `admin_panel-2.0.0.jar` and its required Admin GUI dependency in Minecraft. Configure `config/admin-panel-bridge.properties`:

```properties
enabled=true
url=wss://panel.example.com/bridge
token=COPY_THE_ADMIN_PANEL_BRIDGE_TOKEN_VALUE_FROM_THE_WEB_APP
```

Restart Minecraft. It connects outward and reconnects after disconnects; no inbound panel port or certificate is needed on Minecraft. Every command retains the staff identity and game-side role checks. Interrupted commands report an uncertain outcome and are never automatically replayed.

For a trusted private connection to a host exposing only an IP and port:

```properties
enabled=true
url=ws://YOUR_WEB_HOST:3000/bridge
token=YOUR_SHARED_SECRET
allow-insecure-ws=true
```

`ws://` is plaintext. Use `wss://` when crossing an untrusted network. `ws://localhost:3000/bridge` needs no insecure override. The `/bridge` endpoint is for the Minecraft client, not browsers.

## Your hosting and SSL

The app listens on ordinary HTTP using `HOST` and `PORT`; the public URL is configured separately with `PUBLIC_ORIGIN`. If your hosting provides HTTPS, set that URL and use the corresponding `wss://` URL in Minecraft. The host must forward WebSocket upgrades to **the same port as the website** and preserve `Authorization` and `Host` headers. No certificate creation or installation inside this app is required.

If the host exposes only plain HTTP, a framework cannot make that endpoint HTTPS on its own. Either use its HTTP endpoint on a trusted private network, or put a TLS-capable endpoint/tunnel in front of it. For private HTTP browser access, set `PUBLIC_ORIGIN=http://HOST:PORT` and `allow-insecure-http=true` in the properties file. Secure cookies are enabled automatically when the public origin is HTTPS, even if the hosting proxy talks HTTP to Node. Do not disable TLS verification in Minecraft.

If a proxy changes the Host header, configure `TRUSTED_PROXIES` with **only that proxy's actual IP addresses/CIDRs** so forwarded host/client-IP headers can be used. Otherwise keep it unset and preserve the original Host. Register exactly `<PUBLIC_ORIGIN>/api/auth/discord/callback` in Discord. There is no separate WebSocket port such as 8081.

For example, an existing nginx HTTPS virtual host can forward everything with:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 90s;
}
```

This example assumes HTTPS is already configured by your host; it does not issue certificates.

## Configuration and operations

- `PUBLIC_ORIGIN`: exact public origin, no trailing slash; overrides `origin` in the properties file.
- `HOST`, `PORT`: assigned interface and port; override `bind` and `port`.
- `ADMIN_PANEL_BRIDGE_TOKEN`: random 43–128 character URL-safe secret shared only with Minecraft. `npm run setup` generates one.
- `DATA_DIR`: persistent data root, default `./data`.
- `PANEL_CONFIG`: optional path to an existing properties file.
- `ADMIN_PANEL_DISCORD_CLIENT_SECRET`: optional override for the Discord secret.
- `TRUSTED_PROXIES`: optional comma-separated proxy IPs/CIDRs.

Normal `npm start` loads `.env` if present. Hosting-provided environment variables take precedence. The secret never goes into the React bundle. Use the existing `tools/create-user.py` from the repository to generate local account entries. Rank changes from the UI update the configuration atomically and take effect after restarting Node.

Bundled item exports live in `assets/icons/` and are copied to generated `public/icons/` during the web build. Optional additional exports go in `data/assets/icons/<namespace>__<item>.png`; copied mod jars go directly in `data/assets/` and are read only as asset archives. Restart Node after changing assets. Generated item textures, layered textures, and static cuboid models are previewed on the web host. Custom renderers, world tinting, and client-state-dependent items retain labeled fallbacks. Player list reads are coalesced and cached for two seconds; details stay viewer-specific for note ownership.

## Live state updates

Signed-in browsers connect to `/api/live` over WebSocket on the same host and port. Forward WebSocket upgrades for both `/bridge` (Minecraft) and `/api/live` (browsers); the nginx catch-all example above already does this. Install the updated mod and restart the Node service together, then reload browser tabs.

The mod samples only subscribed data approximately once per second and pushes snapshots only when content changes. Player joins/leaves and panel mutations also request an immediate sample. The player list is shared across viewers; the selected profile is keyed by player and staff identity/permissions, preserving note ownership. Location, inventory, playtime, security data, notes, and punishments update while that profile is open. Timestamp-only changes do not resend entire snapshots. Under server load, updates may take longer than one second.

Closing a tab or logging out removes its subscriptions; with no viewers, the mod does not continuously build live snapshots. Browser and Minecraft connections reconnect automatically and restore subscriptions. Expired sessions lose live access. Selected-player updates pause in the UI while a moderation dialog is open so forms are not disrupted. The Refresh button remains available, with a 30-second HTTP fallback when the live channel is unavailable. Commands are never replayed during reconnect.

The service bounds live connections to 128 total and four per staff session, with up to 32 distinct game subscriptions (one shared list plus up to 31 profiles with distinct staff identities). Slow browser clients are disconnected instead of accumulating unlimited queued snapshots.

## Tests and Docker

`npm run typecheck` (including unused-code checks), `npm run build`, and `npm test` validate the Node app and React UI. Browser tests require Chromium and a matching ChromeDriver. `gradle build` additionally runs Java contract tests through `bridgeTest`, checks the mod artifact with `verifyModJar`, and runs the actual Java bridge client against Fastify; `npm test` alone skips that test unless `JAVA_BRIDGE_CLASSPATH` is set. Tests use temporary data and fake game/Discord services, not your live server.

From the repository root, `docker build -f web-server/Dockerfile -t admin-panel-web .` builds the Node service. Mount a writable persistent directory at `/data`, supply environment variables, and publish port 3000. The container runs as the `node` user. The Docker image does not manage TLS certificates.

## Permissions

Ranks use `discord.rank.<name>.permissions`, a comma-separated list. The highest matching Discord rank wins; grants are not combined across ranks. Rank names do not grant permissions. Use **Rank access** to select each permission, save, and restart Node. The editor preserves one rank with both `panel.access` and `access.manage`. Authorization is captured at login; restarting Node clears existing sessions.

| Permission | Allows |
| --- | --- |
| `panel.access` | Sign in (required) |
| `tab.players` | Player directory and selecting profiles |
| `tab.overview` | Overview, location, playtime, linked Discord, teams and ClockIn |
| `tab.cases` | Punishment history and configured offenses |
| `tab.notes` | Staff notes |
| `tab.security` | Security records and detection badges |
| `tab.inventory` | Inventory |
| `tab.enderChest` | Ender Chest |
| `tab.curios` | Curios |
| `tab.audit` | Read and export audit history, including action details |
| `access.manage` | View and edit Discord rank permissions |
| `notes.add`, `notes.edit`, `notes.remove` | Individual note actions (also require player and notes tabs) |
| `punish.warn`, `punish.kick`, `punish.mute`, `punish.ban`, `punish.offense` | Individual punishment actions (also require player and punishment tabs) |
| `punish.remove` | Remove direct punishment records |
| `punish.revoke` | Remove an entire configured offense case |

Profile tabs also require `tab.players`. Empty permissions deny login. Notes remain editable/removable only by their author and cannot be system notes. Removal requires a reason and confirmation, preserves punishment history, and records the remover. Direct removals lift the selected record only; unrelated live bans remain enforced. Offense records must be removed through **Remove case** to keep escalation counts consistent. Removing a kick record does not reverse the kick. Reasons are retained in the web audit trail.

Old `.access=admin|moderator|viewer|deny` settings still load with equivalent explicit grants; old admin access gains direct punishment removal, while rank management remains limited to old owner/dev mappings. An explicit `.permissions` entry, including an empty one, takes precedence. Saving ranks replaces legacy access keys with permissions. Local accounts can use `permissions.<username>=...` to override legacy grants; their existing `user.<username>=rank,UUID,SALT:HASH` format is retained and a custom rank name requires explicit permissions. Neither the browser nor the Minecraft bridge derives grants from those rank names.

Install the rebuilt mod and web app together: bridge actors now carry explicit permissions, and the mod rejects requests without them.

## Batched data transport

Large initial reads and real-time snapshots are batched on **both** WebSocket hops: Minecraft → Node and Node → browser. Each chunk carries a transfer ID, sequence number, and total count. Chunks contain at most 8,192 UTF-16 characters, preserve emoji/surrogate pairs, and remain below the 64 KiB WebSocket message limit including JSON escaping. Small messages travel directly.

Node and the browser expose a snapshot only after every chunk is received in order. Missing, duplicate, malformed, or timed-out transfers are discarded; reconnect starts fresh without replaying commands. Writes wait for the preceding frame to drain. Browser connections also have a bounded outgoing queue and authorization is checked between frames.

There is a **32 MiB total UTF-8 limit per assembled message** and a 30-second transfer deadline. These bounds prevent unbounded buffering; exceeding them produces an error or disconnect instead of an encoding exception. Existing command deadlines still apply. Mutation requests remain small and retain their existing validation limits. HTTP refresh responses use normal HTTP JSON after bridge reassembly; they are not Minecraft string-codec packets.

Deploy the updated mod and Node service together and reload browser tabs to load the matching batch receiver.

## Discord tickets

The optional [Discord bot](../discord-bot/README.md#ticket-categories-and-panel-sync) sends channel metadata to `/tickets-sync` using its own `TICKET_SYNC_TOKEN` (set the same secret in both services). Minecraft is not involved. The endpoint is disabled until this secret is configured; it does not use staff cookies or the Minecraft bridge token.

Grant `tab.tickets` in **Rank access**, plus each allowed category permission:

- `tickets.lost-items-or-airship`
- `tickets.other-support`
- `tickets.cant-connect-to-the-server`
- `tickets.buy-a-shop-plot-at-spawn`
- `tickets.stealing-or-grieffing`
- `tickets.player-report`
- `tickets.report`

Both grants are required. The API filters category labels and records before returning them; direct requests to forbidden categories return 403. Existing explicit ranks receive no new permissions automatically. As with other rank changes, restart the web service and sign in again to apply grants.

The Tickets inbox displays channel names, forum tags, and links to Discord, with 50 tickets per page and automatic refresh every 15 seconds. Discord still enforces channel access when opening those links. Ticket conversations support reading and replying; closing tickets is not implemented. See the bot README for source category IDs and name-pattern overrides. No received snapshot means a waiting notice; stale snapshots are visibly marked. Restarting the web service clears its in-memory snapshot until the next bot sync.

### Ticket conversations

Select a ticket in the inbox to read its conversation, text embeds and inline image/video/audio attachments. History loads in pages of 25; “Load earlier messages” retrieves older pages. The open conversation refreshes every 10 seconds. Text is rendered without raw HTML. Other attachment links open separately; uploads are not implemented.

The existing ticket tab and category grants allow reading. Grant the additional **`tickets.reply`** permission to allow responding within those permitted categories. The API enforces both grants, CSRF protection and request deduplication. Staff replies are attributed, mention pings are disabled, and the audit log records requested/successful/unconfirmed sends. If a connection fails during a send, inspect the refreshed conversation before retrying; the draft remains in the editor and the request is not replayed automatically.

Restart both services after updating. Enable the bot's **Message Content Intent** and the Discord permissions described in the bot README. Both `/tickets-sync` and `/tickets-commands` must accept WebSocket upgrades. A disconnected bot shows an error in the conversation while the existing ticket directory remains available.

Ticket media displays inline: images/GIFs open full size when clicked, and video/audio attachments have native playback controls. Spoiler attachments require a click to reveal. Previews load only from Discord CDN/media hosts; other files remain links. Signed attachment URLs are refreshed when message history refreshes. Unsupported browser codecs or unavailable files fall back to a link. Media is loaded directly from Discord, not streamed through Minecraft or the panel server; there is no autoplay. External service players (such as YouTube/Spotify iframes) and uploading attachments are not implemented.

Ticket authors use their server nickname and server-profile avatar when available, falling back to their Discord display name and global/default avatar. Hover over the author name to see the account username. Missing or failed avatar images display initials. Webhook authors retain their own profile identity.

Ticket text supports Discord-style bold, italics, underline, strikethrough, spoilers, inline/fenced code, headings, quotes, lists, subtext and HTTP(S) links. User/role mentions appear as highlighted badges with resolved names. Names are rendered literally, code blocks do not format mentions, and raw HTML is never executed. This renderer does not implement Discord interactive components or custom emoji/sticker rendering.

## Developer to-do and Discord suggestions

**To-do** is a persistent developer board for fixes and features. Tasks have a title, details, assignee, priority and status (To do / In progress / Done). Search filters the board. Data lives in `DATA_DIR/todos.json`; include it in backups and mount `DATA_DIR` persistently in containers. Saves are atomic, with version checks to reject stale concurrent edits. Run one web process against this data directory. The board supports up to 2,000 tasks.

Grant `tab.todo` plus the required `todo.create`, `todo.edit`, and/or `todo.delete` permissions to your developer ranks in Rank access. There is no hardcoded `dev` rank name. Read-only users need just `tab.todo`. Refresh tasks to see other staff's changes; a conflict requires refreshing and reopening the task before saving.

**Suggestions** displays active and archived threads from the forum set by `SUGGESTIONS_FORUM_ID` in `discord-bot/.env`. Use the forum channel ID, not a category ID. The existing `TICKET_SYNC_URL` / `TICKET_SYNC_TOKEN` WebSocket connection carries suggestions as well. Each page has at most 24 threads plus forum metadata; conversations use the existing bounded message transport.

Grant `tab.suggestions` to read suggestions and `suggestions.tags` to apply/remove the forum's existing tags (up to five per thread). This edits applied tags, not the forum's tag definitions. Tags are checked against the configured forum and current thread tags before saving. Archived/locked threads are readable but cannot be retagged here; reopen them in Discord first. The bot needs View Channel, Read Message History and Manage Threads for tag edits. Tag operations are audited. Grant `suggestions.reply` alongside `tab.suggestions` to respond from the panel. Replies use the same server-nickname/rank signature, disabled mention pings, CSRF checks, duplicate-send protection and audit logging as ticket replies. Archived or locked threads must be reopened in Discord first.

**Admin controls.** Three more permissions, granted in Rank access (legacy `admin` accounts get them automatically): `suggestions.status` changes a suggestion's status, `suggestions.create` posts a new suggestion, and `suggestions.delete` deletes a suggestion's thread. Statuses are fixed: Denied, Done, Under consideration, Maybe next season, Waiting for update, Testing, Poll. Posting and status edits go through the Discord webhook configured as `SUGGESTIONS_WEBHOOK_URL` in the bot's `.env` (a webhook of the suggestions forum channel). A status is stored as a final `**Status:** …` line of the suggestion's first message, which the bot edits through that webhook, so the Discord post always shows the current status. The webhook can only edit messages it posted: suggestions created from the panel work, but threads started by community members cannot get a status and the panel reports that. Status changes use a version check (a conflict asks you to refresh). Deleting removes the whole Discord thread and needs Manage Threads for the bot. All three actions are written to the audit log.

“Create task” links a suggestion to the To-do board and requires both `tab.todo` and `todo.create`. Duplicate imports of the same suggestion are rejected. All new permissions appear in Rank access; existing explicit grants are unchanged. Restart both services after deploying, and restart the web service/sign in again after changing rank permissions.

Tasks can be dragged between status columns by users with `todo.edit`. A status dropdown on each card provides the same action for keyboard/touch users. Moves save immediately with the existing version check; failed moves keep the original position. Dragging is disabled while saving or editing a task.

Suggestions use compact rows with name search on the current page and multi-select tag filters (all selected tags must match). Active and archived suggestions are filtered and sorted by latest message time, newest first, before pagination. Archived listings are cached for 30 seconds; scans exceeding 10,000 entries or the time budget return an error instead of a partially sorted list. Filters persist when switching Active/Archived; Clear filters resets them.

Suggestion pages are cached in the current signed-in view for 30 seconds (up to 30 page/filter combinations). Returning to a fresh cached page is instant. While uncached or expired results load, the previous list and filter controls stay visible with an updating status; stale rows and pagination cannot be activated. Refresh suggestions and successful tag edits invalidate the cache. Leaving the view or signing out discards it.
