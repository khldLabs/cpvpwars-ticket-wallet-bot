// webhook.js  –  Tebex purchase webhook handler

import express from "express";
import crypto  from "crypto";
import { EmbedBuilder } from "discord.js";
import { grantTebexTickets } from "./database.js";

// ── Package map  (key = Tebex numeric package ID) ─────────────────────────────
// Find your package ID in Tebex: Packages → click a package → the ID shown in
// the URL or the package details panel.
// Using IDs (not names) prevents mismatch if you ever rename a package.
export const TICKET_PACKAGES = {
  7447582: 1,  // 1 Match Ticket
  7447585: 3,  // 3 Match Tickets
  7447586: 5,  // 5 Match Tickets
};

// ── Signature verification ────────────────────────────────────────────────────
// Tebex algorithm:
//   1. SHA-256 hash the raw request body  → bodyHash (hex)
//   2. HMAC-SHA-256(bodyHash, secret)     → signature (hex)
// X-Signature header == result of step 2.
function verifyTebexSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", secret).update(bodyHash).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,        "hex"),
      Buffer.from(signatureHeader, "hex")
    );
  } catch {
    return false;
  }
}

// ── Snowflake validation ──────────────────────────────────────────────────────
// Discord user IDs are 17–19 digit integers.
// Rejects usernames ("Vxqrds") and obvious typos immediately, before any API call.
const SNOWFLAKE_RE = /^\d{17,19}$/;
function isValidSnowflake(id) {
  return typeof id === "string" && SNOWFLAKE_RE.test(id.trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTickets(product) {
  return TICKET_PACKAGES[product.id] ?? 0;
}

// Extracts the discord_id variable the player filled in at checkout.
// In Tebex: Packages → your package → Variables → Identifier must be "discord_id".
function extractDiscordId(variables = []) {
  return (
    variables
      .find((v) => v.identifier?.toLowerCase() === "discord_id")
      ?.option?.trim() ?? null
  );
}

// ── Server factory ────────────────────────────────────────────────────────────
export function createWebhookServer(discordClient) {
  // Fix 1: Refuse to start without a secret — no secret means no security.
  const secret = process.env.TEBEX_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "TEBEX_WEBHOOK_SECRET is not set. " +
      "The webhook server will not start without it. " +
      "Set it in your .env file (found in Tebex → Integrations → Webhooks → your endpoint → Secret)."
    );
  }

  const logChannelId = process.env.LOG_CHANNEL_ID;
  const port         = parseInt(process.env.WEBHOOK_PORT ?? "3000", 10);

  const app = express();

  // Fix 9: 100 kb body size limit — rejects oversized or malformed requests early.
  app.use(express.raw({ type: "application/json", limit: "100kb" }));

  app.post("/webhook/tebex", async (req, res) => {
    // Signature check
    const sig = req.headers["x-signature"];
    if (!verifyTebexSignature(req.body, sig, secret)) {
      console.warn("Tebex webhook: bad signature — rejected.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { type } = payload;
    console.log(`Tebex webhook: ${type}`);

    // Validation handshake — Tebex fires this when you save the endpoint URL.
    if (type === "validation.webhook") {
      console.log("  Validation handshake → responding with id:", payload.id);
      return res.status(200).json({ id: payload.id });
    }

    // Refund/dispute events: log a staff alert, that's all.
    // Corrections are handled manually with /tickets remove or /tickets set.
    if (["payment.refunded", "payment.dispute.opened", "payment.dispute.lost"].includes(type)) {
      const txId = payload.subject?.transaction_id ?? "unknown";
      console.log(`  Payment event ${type} for tx ${txId} — alerting staff.`);
      // Fix 8: wrap Discord call so a log failure returns 200 (no retry triggered)
      await tryLog(discordClient, logChannelId, buildDisputeEmbed(type, txId));
      return res.status(200).json({ status: "alerted" });
    }

    if (type !== "payment.completed") {
      return res.status(200).json({ status: "ignored", type });
    }

    // ── Completed payment ─────────────────────────────────────────────────────
    const subject  = payload.subject ?? {};
    const products = subject.products ?? [];
    const txId = subject.transaction_id;
    if (!txId) {
      console.warn("  payment.completed received with no transaction_id — skipped.");
      return res.status(200).json({ status: "skipped", reason: "missing transaction_id" });
    }

    for (const product of products) {
      const qty        = product.quantity ?? 1;
      const ticketsPer = resolveTickets(product);

      if (ticketsPer === 0) {
        console.log(`  Skipped product ${product.id} "${product.name}" — not in TICKET_PACKAGES.`);
        continue;
      }

      const totalTickets = ticketsPer * qty;
      const rawDiscordId = extractDiscordId(product.variables ?? []);

      // Fix 6a: validate snowflake format before any API call
      if (!rawDiscordId || !isValidSnowflake(rawDiscordId)) {
        console.warn(
          rawDiscordId
            ? `  Bad discord_id "${rawDiscordId}" in tx ${txId} — not a valid snowflake.`
            : `  No discord_id in tx ${txId}.`
        );
        await tryLog(discordClient, logChannelId,
          buildIdAlert(rawDiscordId, product, txId, totalTickets, "missing_or_invalid")
        );
        continue;
      }

      const discordId = rawDiscordId.trim();

      // Validate the Discord user exists before touching the DB
      let discordUser;
      try {
        discordUser = await discordClient.users.fetch(discordId);
      } catch {
        console.warn(`  Discord user ${discordId} not found — tx ${txId}.`);
        await tryLog(discordClient, logChannelId,
          buildIdAlert(discordId, product, txId, totalTickets, "not_found")
        );
        continue;
      }

      // Check membership in the configured guild (GUILD_ID) specifically.
      // Falls back to scanning all guilds only if GUILD_ID is not set.
      let inGuild = false;
      const targetGuildId = process.env.GUILD_ID;
      if (targetGuildId) {
        try {
          const guild = await discordClient.guilds.fetch(targetGuildId);
          await guild.members.fetch(discordId);
          inGuild = true;
        } catch { /* not in the configured guild */ }
      } else {
        for (const guild of discordClient.guilds.cache.values()) {
          try { await guild.members.fetch(discordId); inGuild = true; break; }
          catch { /* not in this guild */ }
        }
      }
      if (!inGuild) {
        console.warn(`  ${discordUser.username} (${discordId}) not in server — tickets still granted.`);
        await tryLog(discordClient, logChannelId,
          buildIdAlert(discordId, product, txId, totalTickets, "not_in_server", discordUser.username)
        );
      }

      // Single atomic SQLite transaction: claim + balance update + history.
      // If this call returns { granted: false }, Tebex already delivered this
      // exact (tx, product, user) and the DB was not changed.
      // If the process crashes mid-call, SQLite rolls back — no orphaned claim.
      const { granted, newBalance } = grantTebexTickets(
        txId, product.id, discordUser.id, discordUser.username, totalTickets
      );

      if (!granted) {
        console.log(`  Duplicate: tx ${txId} / product ${product.id} / user ${discordId} — skipped.`);
        continue;
      }

      console.log(`  ✅ +${totalTickets} → ${discordUser.username} (balance: ${newBalance})`);
      await tryLog(discordClient, logChannelId,
        buildSuccessEmbed(discordUser, product, totalTickets, newBalance, txId)
      );
    }

    return res.status(200).json({ status: "ok", txId });
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(port, () => {
    console.log(`Tebex webhook server → port ${port}`);
    console.log(`Endpoint: POST http://your-server:${port}/webhook/tebex`);
  });

  return app;
}

// ── tryLog — Discord failures stay silent ─────────────────────────────────────
// Any exception here is caught and logged to console only.
// This ensures Tebex always gets a 200 and never retries due to our own log issues.
async function tryLog(client, channelId, embed) {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error("Discord log failed (non-fatal):", err.message);
  }
}

// ── Embed builders ────────────────────────────────────────────────────────────

function buildSuccessEmbed(user, product, tickets, newBalance, txId) {
  return new EmbedBuilder()
    .setColor(0x43b581)
    .setTitle("🛒 Tebex Purchase — Tickets Added")
    .addFields(
      { name: "Player",        value: `<@${user.id}> (${user.username})`, inline: true  },
      { name: "Package ID",    value: String(product.id),                  inline: true  },
      { name: "Package Name",  value: product.name,                        inline: true  },
      { name: "Tickets Added", value: `+${tickets}`,                       inline: true  },
      { name: "New Balance",   value: `${newBalance} ticket(s)`,           inline: true  },
      { name: "Transaction",   value: txId,                                inline: false }
    )
    .setTimestamp();
}

function buildIdAlert(discordId, product, txId, tickets, reason, username) {
  const descriptions = {
    missing_or_invalid:
      "No valid `discord_id` was submitted at checkout, or the value is not a Discord snowflake (17–19 digit number).\n" +
      "The player likely entered their **username** instead of their **User ID**.\n" +
      "**Fix:** Make `discord_id` **Required** in Tebex → Packages → Variables, and instruct players to copy their User ID.",
    not_found:
      `Discord ID \`${discordId}\` does not exist.\n` +
      "The player may have entered a wrong ID, or the account was deleted.\n" +
      "Staff must verify and add manually with \`/tickets add\`.",
    not_in_server:
      `\`${username}\` (\`${discordId}\`) is not currently in the server.\n` +
      "Tickets were still added to their wallet. They will apply once the player joins.",
  };

  return new EmbedBuilder()
    .setColor(reason === "not_in_server" ? 0xfaa61a : 0xed4245)
    .setTitle(
      reason === "not_in_server"
        ? "⚠️ Tickets Added — Player Not in Server"
        : "❌ Tebex Purchase — Discord ID Issue"
    )
    .setDescription(descriptions[reason] ?? "Unknown issue.")
    .addFields(
      { name: "Provided ID",  value: discordId ?? "none", inline: true },
      { name: "Package ID",   value: String(product.id),  inline: true },
      { name: "Package Name", value: product.name,         inline: true },
      { name: "Tickets",      value: `${tickets}`,          inline: true },
      { name: "Transaction",  value: txId,                  inline: false }
    )
    .setTimestamp();
}

function buildDisputeEmbed(type, txId) {
  const configs = {
    "payment.refunded": {
      color: 0xfaa61a,
      title: "💸 Payment Refunded",
      desc: "Staff: use `/tickets remove` or `/tickets set` to correct the balance if needed.",
    },
    "payment.dispute.opened": {
      color: 0xfaa61a,
      title: "⚠️ Dispute Opened",
      desc: "A chargeback was initiated. Do not grant tickets to this account until resolved.",
    },
    "payment.dispute.lost": {
      color: 0xed4245,
      title: "❌ Dispute Lost — Chargeback Confirmed",
      desc: "Staff: use `/tickets remove` or `/tickets set` to remove tickets and review the account.",
    },
  };
  const cfg = configs[type] ?? { color: 0x99aab5, title: type, desc: "" };
  return new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(cfg.title)
    .setDescription(cfg.desc)
    .addFields({ name: "Transaction", value: txId, inline: true })
    .setTimestamp();
}
