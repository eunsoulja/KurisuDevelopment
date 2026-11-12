# Kurisu Security

Discord antinuke, raid protection and moderation bot. discord.js 14, Components V2, SQLite.
Red custom emojis are the only colour: no accent bars, grey (secondary) buttons only.

## What is included

| Area | Details |
|---|---|
| Antinuke | 23 modules, each with enable/disable, threshold, time window, punishment, incident log, persistent config |
| Raid protection | NORMAL / ELEVATED / HIGH / LOCKDOWN, join velocity, account age, auto and manual lockdown with expiry, verification mode, join history |
| Whitelist | Users **and roles**, with per-entry scopes: pings/mentions, channel create/delete/rename, role changes, member actions, webhooks, bots, server settings, all modules; trusted_admin, trusted_mod, bypass, trusted bot; owner protections cannot be removed |
| Moderation | `/ban /unban /kick /timeout /untimeout /warn /warnings /purge /clear /slowmode /lock /unlock /hide /unhide /nickname /role add|remove /softban /massban` |
| Security Center | `/security` dashboard, fully interactive (modules, thresholds, punishments, whitelist, logs, raid, log channels) |
| Command Center | `/help` generated from the real command definitions, category pages, detail pages, pagination, branded media |
| Logs | antinuke, raid, moderation, member, message, channel, role, voice, configuration |
| Recovery | channel and role restore, role/channel/server-name revert, webhook removal, unapproved bot removal, invite cleanup |
| Extra commands | `/raid status|lockdown|unlock`, `/verification enable|disable|status`, `/quarantine release`, `/logs set|clear|view`, `/prefix`, `/about`, `/invite`, `/ping`, `/serverinfo` |
| Text commands | Per-server prefix (default `!`), e.g. `khelp`, `kping`, `kserverinfo`, `kban @member spam`; same permission checks and V2 views as slash commands |
| Mention card | Mentioning Kurisu replies with a branded Components V2 card (GIF + live bot stats + emoji invite button); 15s per-user cooldown |
| Presence | The bot's status is `Watching <n> users`, refreshed every two minutes from the real member count |

## Design language

Kurisu uses Discord's Components V2 (containers, sections, text displays, separators and media galleries) rather than classic embeds. The design stays intentionally colourless: no accent colour, grey secondary buttons only, and hierarchy comes from typography, spacing, separators, status emojis and thumbnails. This mirrors how mature utility bots keep panels readable without relying on brand colours:

- one clear header, a short subtitle and the most important stats first;
- grouped sections with separators instead of a wall of fields;
- branding media (avatar, GIF, banner) used sparingly;
- consistent labels (`Label  **value**`), relative timestamps and compact footers;
- ephemeral replies for personal actions, public panels for shared information;
- every interactive view is re-authorised on each interaction.

## Whitelist scopes

Whitelist entries can target a **user or a role** and can be limited to specific protection modules. If `scopes` is omitted, the level default applies: Trusted Moderators only bypass message modules; Trusted Administrators, Bypass and Trusted Bot are fully exempt.

```text
/whitelist add level:Trusted Moderator role:@Moderators scopes:channel-create,channel-rename
/whitelist add level:Trusted Moderator user:@member scopes:pings
/whitelist add level:Bypass user:@trusted-admin
/whitelist add level:Trusted Bot user:@logger-bot
```

`scopes` accepts comma-separated module keys (`channelCreate`, `channelUpdate`, `everyoneMention`, ...), friendly presets (`pings`, `channels`, `roles`, `members`, `webhooks`, `server`, `emojis`, `bots`, `permissions`), `all`, or `default`. The Security Center whitelist page exposes the same scopes as a multi-select.

## Text commands

Slash commands are always available. Kurisu also accepts text commands with the server's prefix (default `!`, change it with `/prefix` or `kprefix`). The prefix is matched case-insensitively and does not need a space:

```text
khelp
kping
kserverinfo
kban @member spam
ktimeout @member 10m spam
kwhitelist add @member trusted_mod pings
```

Arguments are typed: mentions, IDs, `#channel`, `@role`, numbers, choices and quoted strings all work. For example, `kban @member reason:"spam and eggs" delete_days:7` is equivalent to `/ban`. Text commands use the same permission, hierarchy and antinuke checks as their slash counterparts, and reply with the same Components V2 views.

## Requirements

- Node.js 20 or newer (developed on 22)
- A Discord application with a bot user
- The custom emojis from `src/config/emojis.js` must be visible to the bot. Either the bot is in the server that owns them, or you upload them as **Application Emojis** in the Developer Portal. On startup Kurisu validates the registry and logs any emoji it cannot see.

## Discord Developer Portal setup

1. Create an application, add a bot, copy the token and application ID.
2. Bot tab, **Privileged Gateway Intents**: enable **Server Members Intent** and **Message Content Intent**. Message Content is required for prefix text commands (`khelp`, `kban`, ...); slash commands work without it.
3. Gateway intents requested in code: Guilds, GuildMembers, GuildModeration, GuildMessages, MessageContent, GuildVoiceStates.
4. Invite with scopes `bot` and `applications.commands`, permissions listed below.

Bot permissions used (integer `1100451490998`): View Channels, Send Messages, Read Message History, Manage Channels, Manage Roles, Manage Server, Manage Messages, Manage Nicknames, Manage Webhooks, Kick Members, Ban Members, Moderate Members, View Audit Log, Use External Emojis.

**Important:** place Kurisu's role near the top of the role list. Discord hierarchy decides whether Kurisu can punish, strip roles or restore anything. A bot below the attacker cannot stop them.

## Install

```bash
npm install
cp .env.example .env        # then fill DISCORD_TOKEN, CLIENT_ID, OWNER_IDS
npm run deploy              # registers slash commands (set DEV_GUILD_ID for instant, guild-only testing)
npm start
```

`AUTO_DEPLOY=true` registers commands at every startup instead.

### Environment

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | bot token (never commit) |
| `CLIENT_ID` | application ID |
| `DEV_GUILD_ID` | optional, register commands to one guild |
| `OWNER_IDS` | comma-separated bot owner user IDs (always exempt, can edit the whitelist) |
| `DATABASE_PATH` | SQLite file, default `./data/kurisu.db` |
| `AUTO_DEPLOY` | `true` to register commands on boot |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

### Database

SQLite via better-sqlite3 (WAL mode, foreign keys on). Migrations run automatically at startup and are tracked in `schema_migrations`. Back up the `data/` folder. All tables are keyed by `guild_id`. Config, whitelist, warnings, cases, incidents, snapshots and lockdown state survive restarts; an expired lockdown is resolved on the next startup.

### Deployment

Any process manager works. Example with pm2:

```bash
npm i -g pm2
pm2 start src/index.js --name kurisu
pm2 save && pm2 startup
```

The bot handles SIGINT/SIGTERM by closing the gateway and the database cleanly.

## First-time setup in a server

1. Run `/security` (server owner, bot owner or a Trusted Administrator).
2. Settings: pick log channels (at least Antinuke, Raid, Moderation).
3. Whitelist: add trusted staff and trusted bots, otherwise their legitimate bulk actions can trigger a response.
4. Review each module's threshold and punishment in Protection.

## How detection works

Kurisu consumes `GUILD_AUDIT_LOG_ENTRY_CREATE`. Each entry already carries the executor, target, action and changes, so there is no guessing from "the latest audit log row" and no polling delay.

1. Entry arrives, duplicates by entry ID are dropped.
2. No executor on the entry: ignored. Kurisu never punishes an arbitrary member.
3. The entry is mapped to one or more modules.
4. Exempt actors (guild owner, bot owner, Kurisu, whitelist) are skipped. Administrator permission alone gives no immunity.
5. A per-executor sliding window counts actions; at the threshold a per-executor lock prevents double punishment during a flood.
6. Punishment is applied, with a fallback chain if Discord refuses (ban, kick, quarantine, timeout). A repeat offender within 24 hours escalates to ban (configurable, 0 = off). Bot accounts are banned.
7. Everything in the burst is mitigated (restore, revert or remove) and an incident row plus a short log is written.

Message-based modules (@everyone, mass mention) run from `messageCreate`.

## Known limits (Discord API)

- Messages of a deleted channel cannot be recovered. Restored channels and roles get new IDs.
- Members of a deleted role are not re-assigned.
- Server icon, banner and vanity URL cannot be restored through the API. Kurisu detects vanity/server changes, punishes, and restores the server name only.
- Restored roles and channel overwrites never regain dangerous permissions; those bits are withheld and the recovery note says so.
- Reverting a role edit only removes dangerous permissions that were added. It never grants any.
- Mass message deletion is detected through bulk-delete audit entries. Discord merges individual moderator deletions into one entry, which is not reliably countable.
- Quarantine uses removed roles, a role without permissions and a 28 day timeout; Discord caps timeouts at 28 days.
- Verification mode and lockdown use Discord's verification level, @everyone send permissions and the invite pause. Raid protection never mass-bans; optional lockdown kicks only accounts younger than the configured age.
- Message logs intentionally show author, channel and attachment count, not message content.

## Tests

```bash
npm test
```

Automated: persistence across a restart, guild isolation, whitelist and hierarchy rules, antinuke thresholds/dedupe/exemptions, audit classification, raid levels, help generation from real commands, Components V2 limits, grey-buttons-only, no accent colour, and authorization on dashboard and help interactions.

**Not automated, run these on a disposable test server before production:** every slash command against live Discord, gateway reconnects, real audit-log delivery, emoji rendering, lockdown/unlock on a server with many channels, channel and role restoration, and bot hierarchy edge cases. Never run destructive tests on a real community.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Emojis show as text | The bot cannot see them; use Application Emojis or join the emoji server. Check the startup warning. |
| Slash commands missing | Run `npm run deploy`; global commands can take a while, use `DEV_GUILD_ID` when testing. |
| "Used disallowed intents" | Enable Server Members Intent and Message Content Intent in the Portal. |
| No incidents appear | Bot lacks View Audit Log, or the module/antinuke is disabled, or the actor is whitelisted. |
| Punishment failed | Kurisu's role is below the executor's role, or it lacks Ban/Kick/Manage Roles/Moderate Members. |
| Cannot log to a channel | Grant Kurisu View Channel and Send Messages there. |
| `better-sqlite3` fails to install | Use Node 20+ and a supported platform, or install build tools (python3, make, g++). |
