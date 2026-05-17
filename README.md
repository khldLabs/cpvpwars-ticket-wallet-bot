# 🎟️ Match Ticket Wallet Bot

> A Discord bot for managing Match Ticket purchases and game scheduling on the cpvpwars server.

## What is this?

This bot powers the Match Ticket system on cpvpwars: players buy tickets through the Tebex store, and the bot automatically grants them to the buyer's Discord account via a verified webhook. Staff use slash commands to deduct tickets when a sponsored game is hosted, correct balances after refunds, and audit every transaction in a dedicated log channel. Built with discord.js and SQLite (WAL mode + atomic transactions) so that purchases, refunds, and admin corrections can never get out of sync.

## Screenshots

**Slash commands available to players and staff:**

![Slash commands](https://github.com/khldLabs/cpvpwars-ticket-wallet-bot/raw/main/screenshot-commands.png)

**Automatic audit logging in `#ticket-logs`:**

![Audit log examples](https://github.com/khldLabs/cpvpwars-ticket-wallet-bot/raw/main/screenshot-logs.png)

---

## Commands

| Command | Who | Description |
|---|---|---|
| `/tickets balance` | Everyone | Check your own balance |
| `/tickets check @user` | Staff | Check a player's balance |
| `/tickets add @user amount reason` | Staff | Add tickets (manual grant) |
| `/tickets use @user amount reason` | Staff | Deduct tickets when a game is hosted |
| `/tickets remove @user amount reason` | Staff | Remove tickets (admin correction) |
| `/tickets set @user amount reason` | Staff | Set balance to an exact number |
| `/tickets history @user` | Staff | View last 10 transactions |

---

## Requirements

- **Node.js** 20.x, 22.x, or 24.x (LTS recommended)
- npm

## Setup Guide

### 1. Create the Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it (e.g. `Ticket Wallet`)
3. Go to **Bot** → click **Add Bot**
4. Under **Token** → click **Reset Token** → copy it (save for `.env`)
5. Scroll down → enable **Server Members Intent**
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`
   - Copy the generated URL and invite the bot to your server

### 2. Get Your IDs

Enable Developer Mode in Discord: **User Settings → Advanced → Developer Mode**

| ID | How to get it |
|---|---|
| `CLIENT_ID` | Developer Portal → your app → OAuth2 → Client ID |
| `GUILD_ID` | Right-click your server icon → **Copy Server ID** |
| `STAFF_ROLE_ID` | Server Settings → Roles → right-click your Staff role → **Copy Role ID** |
| `LOG_CHANNEL_ID` | Right-click your `#ticket-logs` channel → **Copy Channel ID** |

### 3. Install

```bash
npm install
```

### 4. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_server_id_here

STAFF_ROLE_ID=123456789012345678
LOG_CHANNEL_ID=123456789012345678

TEBEX_WEBHOOK_SECRET=your_tebex_webhook_secret_here
WEBHOOK_PORT=3000
```

> **`STAFF_ROLE_ID`** — numeric ID of the role whose members can run staff commands. Administrators always pass regardless.
> **`LOG_CHANNEL_ID`** — numeric ID of the channel where all ticket actions are logged.
> **`TEBEX_WEBHOOK_SECRET`** — the bot will refuse to start the webhook server without this.

### 5. Register Slash Commands

Run this **once** (or any time you change commands):

```bash
npm run deploy
```

### 6. Start the Bot

```bash
npm start
```

---

## Tebex Webhook Setup

### Tebex package variable (required on every Match Ticket package)

For each ticket package in Tebex, add a variable so buyers submit their Discord ID:

**Tebex Control Panel → Packages → your package → Variables → Add Variable**

| Field | Value |
|---|---|
| Label | `Your Discord User ID` |
| Identifier | `discord_id` ← must be exactly this |
| Type | Text |
| Required | **Yes** |

Tell players: *Right-click your name in Discord → Copy User ID* (requires Developer Mode).

> ⚠️ The identifier must be `discord_id` (lowercase, underscore). The bot reads this exact field.

### Expose the bot to the internet

Tebex needs a public URL to POST webhooks to. Options:

- **ngrok** (easy, for testing): `ngrok http 3000` → gives you `https://xxx.ngrok.io`
- **VPS** (for production): run the bot on a server with a public IP

### Register the webhook in Tebex

**Tebex Control Panel → Integrations → Webhooks → Add Endpoint**

| Field | Value |
|---|---|
| URL | `https://your-public-url/webhook/tebex` |
| Events | `payment.completed`, `payment.refunded`, `payment.dispute.opened`, `payment.dispute.lost` |

Copy the **Secret** Tebex generates → paste it as `TEBEX_WEBHOOK_SECRET` in `.env`.

### Package IDs in `webhook.js`

`TICKET_PACKAGES` maps Tebex package IDs to ticket counts:

```js
export const TICKET_PACKAGES = {
  7447582: 1,  // 1 Match Ticket
  7447585: 3,  // 3 Match Tickets
  7447586: 5,  // 5 Match Tickets
};
```

Find your package ID in Tebex: **Packages → click a package → ID shown in the URL**.

---

## Example Flow

```
Player buys "5 Match Tickets" on Tebex
→ Enters Discord User ID at checkout: 123456789012345678
→ Tebex fires webhook to your server
→ Bot verifies signature, grants 5 tickets atomically
→ #ticket-logs: 🛒 Tebex Purchase — +5 tickets → @Player | Balance: 5

Player opens a support ticket: "I want to host a game at 7 PM"
→ Staff: /tickets use @Player 1 Sponsored game at 7 PM
→ #ticket-logs: 🎟️ Ticket Used | -1 | New Balance: 4 | Reason: Sponsored game at 7 PM
```

---

## Data Storage & Backups

Wallet data lives in `./data/wallet.db` (SQLite with WAL mode enabled).

**Automatic backups:** the bot creates a daily backup to `./data/backups/` and keeps the last 7 days automatically. No setup needed.

**Manual backup:** `node backup.js` — copies the DB immediately.

**Cron backup** (alternative to the built-in scheduler):
```
0 3 * * * cd /path/to/ticket-wallet-bot && node backup.js >> logs/backup.log 2>&1
```
