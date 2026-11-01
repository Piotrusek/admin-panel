# Standalone Discord bot

Logs into Discord, appears online, and prints the channels it can view in one configured guild. It remains connected until stopped. It runs independently of Minecraft, with optional ticket-directory sync to the web server.

## Setup

Requires Node.js 22.12 or newer.

1. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications).
2. Invite the bot to your server using the application's `bot` install scope. Grant **View Channels** for channels it should see. Administrator, Message Content, and Server Members intents are not needed.
3. Copy `.env.example` to `.env` if `.env` does not exist, then fill in:

```dotenv
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
DISCORD_GUILD_ID=YOUR_SERVER_ID
```

Use the bot token from the **Bot** page, not the panel's OAuth client secret. Enable Discord Developer Mode to copy your server ID.

```sh
cd discord-bot
npm ci
npm run build
npm start
```

For development use `npm run dev`. Stop with Ctrl+C. Configuration and channel listings are loaded at startup; restart to print a fresh listing.

The console prints channel type, name and ID for visible text, announcement, voice, stage, category, forum and media channels, plus accessible **active** threads. Channels are grouped under category headings in category/channel position order, with active threads indented beneath their parent channel. Forum threads also display their applied tag names (`Tags: none` when untagged, with an ID fallback for unknown tags). Channels without a visible category appear under **Uncategorized**. Archived threads are not enumerated. Channel visibility respects the bot's roles and channel overrides. The startup listing does not read message history. Optional panel conversations can read history and send staff replies; the bot does not register Discord commands.

Channel enumeration uses [discord.js GuildChannelManager](https://discord.js.org/docs/packages/discord.js/14.27.0/GuildChannelManager:Class) and its channel visibility checks.

## Tests

```sh
npm run typecheck
npm test
npm run build
```

Tests use local fixtures and do not log into Discord. This service has its own dependencies and is not included in the Minecraft or web-server artifacts.

## Ticket categories and panel sync

Set `TICKET_CATEGORY_IDS` in `.env` to a comma-separated list of Discord **category IDs**. Only visible text channels and active threads below those categories are considered. Forum threads use the forum's parent category; their applied tags are included. Archived threads are not listed. Message history is fetched only when staff open a ticket conversation. Active thread enumeration follows the [Discord.js guild channel API](https://discord.js.org/docs/packages/discord.js/main/GuildChannelManager%3AClass).

The seven default patterns are `lost-items-or-airship-*`, `other-support-*`, `cant-connect-to-the-server-*`, `buy-a-shop-plot-at-spawn-*`, `stealing-or-grieffing-*`, `player-report-*`, and `report-*`. Matching covers the whole channel name, is case-sensitive, and `*` means any suffix/text. First matching rule wins in this order. Unmatched channels are omitted.

Override labels or patterns in `.env` with JSON (the seven category IDs stay fixed for permissions):

```dotenv
TICKET_CATEGORY_IDS=123456789012345678,234567890123456789
TICKET_RULES='{"lost-items-or-airship":{"pattern":"lost-items-or-airship-*","label":"Lost Items or Airship"},"report":{"pattern":"report-*","label":"Reports"}}'
TICKET_SYNC_URL=wss://panel.example.com/tickets-sync
TICKET_SYNC_TOKEN=YOUR_RANDOM_URL_SAFE_SECRET_AT_LEAST_43_CHARACTERS
```

Set the same `TICKET_SYNC_TOKEN` in `web-server/.env`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Restart both services. The bot only makes outbound WebSocket connections. Use `ws://10.0.1.1:3000/tickets-sync` on your private network or `wss://` for TLS. Leave the sync URL/token unset for console-only operation. The directory sync does not send Discord messages; the conversation integration below supports staff replies.

Tickets refresh every 30 seconds and transfer in batches below 16 KiB, with at most 10,000 tickets per snapshot. Failed or incomplete transfers leave the previous panel snapshot intact. The panel marks it stale after 90 seconds. Snapshots are held in memory and repopulate after restarting the web service. Existing channel/category/tag logging still runs at startup.

## Reading and replying from the panel

Enable **Message Content Intent** on the application's **Bot** page in the Discord Developer Portal before restarting this version. Discord requires that intent for ordinary message content ([Discord message documentation](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx)). The bot requests Guilds, Guild Messages and Message Content intents. Give it View Channel, Read Message History, Send Messages, and Send Messages in Threads for the ticket sources.

A second outbound WebSocket connects to `/tickets-commands` on the same host using the same sync secret. Forward that path too if your proxy has path-specific routing. It reconnects automatically. Message history is fetched on demand in pages of 25 and transported one message per frame; replies are never automatically replayed. All commands recheck the configured source category and ticket name. Archived/locked threads cannot receive panel replies.

Replies are posted as the bot, with the staff member’s current server nickname and panel rank appended (for example, `— Server Nickname · moderator`). Mentions cannot ping users or roles. Replies are limited to 1,800 characters to leave room for staff attribution; Discord nonce deduplication protects immediate duplicate sends. The panel records who sent each reply in its audit log. The bot never impersonates a Discord user.

Ticket message text and embed titles, descriptions, and fields display user/role mentions as `@Display Name` and `@Role Name`. Guild nicknames take precedence for users. Missing members fall back to known Discord usernames; unresolved/deleted IDs remain visible. Lookups are deduplicated and capped per history page. This only changes the panel display and does not edit Discord messages or generate pings.

## Suggestions forum

Set `SUGGESTIONS_FORUM_ID` to your suggestions **forum channel ID** in `.env`, then restart the bot. Suggestions use the same `TICKET_SYNC_URL` and `TICKET_SYNC_TOKEN` connection; a suggestions-only deployment can leave `TICKET_CATEGORY_IDS` empty. No Discord messages are sent just by enabling this feature.

The panel lists active and archived threads with forum tags and can read their conversations. Users with `suggestions.tags` can apply/remove existing tags on active, unlocked threads; the bot needs **Manage Threads**, **View Channel**, and **Read Message History** in this forum. Up to five applied tags are supported, following [Discord's thread API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx). Tag definitions are managed in Discord. The bot checks the configured forum on every request and rejects stale tag edits. It does not unarchive or unlock threads implicitly.

Set `SUGGESTIONS_WEBHOOK_URL` to a webhook created in the suggestions forum channel (Edit Channel → Integrations → Webhooks) to let admins with `suggestions.create` / `suggestions.status` / `suggestions.delete` add suggestions, set their status (Denied, Done, Under consideration, Maybe next season, Waiting for update, Testing, Poll) and delete them from the panel. The bot posts new suggestions through the webhook and, on a status change, edits that webhook message's trailing `**Status:** …` line; it refuses a webhook belonging to another channel. Webhooks can only edit their own messages, so suggestions posted by members cannot receive a status. Deleting a thread needs **Manage Threads**. Keep the webhook URL secret.

Suggestion replies require Send Messages in Threads in the configured forum. They use the existing staff signature and nonce deduplication; the bot verifies forum membership and rejects archived/locked threads before sending.
