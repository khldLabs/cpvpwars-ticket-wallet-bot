// commands/tickets.js  –  /tickets subcommand group
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import {
  getBalance,
  addTickets,
  useTickets,
  removeTickets,
  setTickets,
  getHistory,
} from "../database.js";

// ── Colors ────────────────────────────────────────────────────────────────────
const GREEN   = 0x43b581;
const RED     = 0xed4245;
const ORANGE  = 0xfaa61a;
const GOLD    = 0xf5a623;
const BLURPLE = 0x5865f2;
const GREY    = 0x36393f;

function base(color) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

/**
 * Ensures embed field values are always valid non-empty strings.
 * EmbedBuilder.addFields() throws a shapeshift validation error if any
 * value is "", undefined, null, or not a string. Truncates at 1024 chars
 * (Discord's per-field limit).
 */
function safeStr(value, fallback = "—") {
  const s = String(value ?? "").trim();
  return s.length > 0 ? s.slice(0, 1024) : fallback;
}

// ── Command definition ────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("tickets")
  .setDescription("Match Ticket wallet system")

  .addSubcommand((s) =>
    s.setName("balance").setDescription("Check your own Match Ticket balance")
  )
  .addSubcommand((s) =>
    s
      .setName("check")
      .setDescription("[Staff] Check a player's balance")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player to check").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("[Staff] Add Match Tickets to a player's wallet")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Tickets to add").setRequired(true).setMinValue(1)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason (e.g. Tebex purchase tbx-xxx)").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("use")
      .setDescription("[Staff] Deduct a Match Ticket (game hosted)")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Tickets to deduct").setRequired(true).setMinValue(1)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason (e.g. Sponsored game at 7 PM)").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("[Staff] Remove tickets (admin correction)")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Tickets to remove").setRequired(true).setMinValue(1)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason (e.g. Refund correction)").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("[Staff] Set a player's balance to an exact number")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("New balance").setRequired(true).setMinValue(0)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("history")
      .setDescription("[Staff] View a player's ticket transaction history")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player").setRequired(true)
      )
  );

// ── Permission guard ──────────────────────────────────────────────────────────
function isStaff(member) {
  const roleId = process.env.STAFF_ROLE_ID;
  if (!roleId) return member.permissions.has(PermissionFlagsBits.Administrator);
  return (
    member.roles.cache.has(roleId) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

// ── Executor ──────────────────────────────────────────────────────────────────
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // MessageFlags.Ephemeral replaces the deprecated { ephemeral: true } option
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // ── /tickets balance  (everyone) ─────────────────────────────────────────
  if (sub === "balance") {
    const balance = getBalance(interaction.user.id);
    const embed = base(BLURPLE)
      .setTitle("🎟️ Your Match Ticket Balance")
      .setDescription(
        balance === 0
          ? "You have **no Match Tickets**.\nPurchase some in the store to get started!"
          : `You have **${balance} Match Ticket${balance !== 1 ? "s" : ""}**.`
      )
      .setFooter({ text: "Open a support ticket to use your tickets." });
    return interaction.editReply({ embeds: [embed] });
  }

  // ── Staff-only from here ──────────────────────────────────────────────────
  if (!isStaff(interaction.member)) {
    const roleId = process.env.STAFF_ROLE_ID;
    const roleMention = roleId ? `<@&${roleId}>` : "the Staff role";
    return interaction.editReply({
      content: `❌ You need ${roleMention} to use this command.`,
    });
  }

  const targetUser = interaction.options.getUser("user");
  const amount     = interaction.options.getInteger("amount");
  const reason     = interaction.options.getString("reason");

  // ── /tickets check ────────────────────────────────────────────────────────
  if (sub === "check") {
    const balance = getBalance(targetUser.id);
    const embed = base(GOLD)
      .setTitle(`🎟️ Wallet — ${targetUser.username}`)
      .addFields(
        { name: "Balance", value: safeStr(`${balance} ticket${balance !== 1 ? "s" : ""}`), inline: true },
        { name: "User ID", value: safeStr(targetUser.id), inline: true }
      )
      .setThumbnail(targetUser.displayAvatarURL());
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /tickets add ──────────────────────────────────────────────────────────
  if (sub === "add") {
    const newBalance = addTickets(
      targetUser.id, targetUser.username, amount, reason,
      interaction.user.id, interaction.user.username
    );
    await interaction.editReply({
      embeds: [base(GREEN)
        .setTitle("🎟️ Tickets Added")
        .addFields(
          { name: "Player",      value: safeStr(targetUser.username),       inline: true  },
          { name: "Added",       value: safeStr(`+${amount}`),              inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                inline: true  },
          { name: "Reason",      value: safeStr(reason),                    inline: false },
          { name: "Staff",       value: safeStr(interaction.user.username), inline: true  }
        )],
    });
    try {
      sendLog(interaction.guild, base(GREEN)
        .setTitle("✅ Tickets Added")
        .addFields(
          { name: "Player",      value: safeStr(`<@${targetUser.id}>`),       inline: true  },
          { name: "Added",       value: safeStr(`+${amount}`),                inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                  inline: true  },
          { name: "Reason",      value: safeStr(reason),                      inline: false },
          { name: "Staff",       value: safeStr(`<@${interaction.user.id}>`), inline: true  }
        )
      );
    } catch (e) { console.error("[log] build error (add):", e.message); }
    return;
  }

  // ── /tickets use ──────────────────────────────────────────────────────────
  if (sub === "use") {
    let newBalance;
    try {
      newBalance = useTickets(
        targetUser.id, targetUser.username, amount, reason,
        interaction.user.id, interaction.user.username
      );
    } catch (err) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    await interaction.editReply({
      embeds: [base(RED)
        .setTitle("🎟️ Ticket Used")
        .addFields(
          { name: "Player",      value: safeStr(targetUser.username),       inline: true  },
          { name: "Used",        value: safeStr(`-${amount}`),              inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                inline: true  },
          { name: "Reason",      value: safeStr(reason),                    inline: false },
          { name: "Staff",       value: safeStr(interaction.user.username), inline: true  }
        )],
    });
    try {
      sendLog(interaction.guild, base(RED)
        .setTitle("🎟️ Ticket Used")
        .addFields(
          { name: "Player",      value: safeStr(`<@${targetUser.id}>`),       inline: true  },
          { name: "Used",        value: safeStr(`-${amount}`),                inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                  inline: true  },
          { name: "Reason",      value: safeStr(reason),                      inline: false },
          { name: "Staff",       value: safeStr(`<@${interaction.user.id}>`), inline: true  }
        )
      );
    } catch (e) { console.error("[log] build error (use):", e.message); }
    return;
  }

  // ── /tickets remove ───────────────────────────────────────────────────────
  if (sub === "remove") {
    let newBalance;
    try {
      newBalance = removeTickets(
        targetUser.id, targetUser.username, amount, reason,
        interaction.user.id, interaction.user.username
      );
    } catch (err) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    await interaction.editReply({
      embeds: [base(ORANGE)
        .setTitle("🎟️ Tickets Removed")
        .addFields(
          { name: "Player",      value: safeStr(targetUser.username),       inline: true  },
          { name: "Removed",     value: safeStr(`-${amount}`),              inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                inline: true  },
          { name: "Reason",      value: safeStr(reason),                    inline: false },
          { name: "Staff",       value: safeStr(interaction.user.username), inline: true  }
        )],
    });
    try {
      sendLog(interaction.guild, base(ORANGE)
        .setTitle("🔧 Tickets Removed (Correction)")
        .addFields(
          { name: "Player",      value: safeStr(`<@${targetUser.id}>`),       inline: true  },
          { name: "Removed",     value: safeStr(`-${amount}`),                inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                  inline: true  },
          { name: "Reason",      value: safeStr(reason),                      inline: false },
          { name: "Staff",       value: safeStr(`<@${interaction.user.id}>`), inline: true  }
        )
      );
    } catch (e) { console.error("[log] build error (remove):", e.message); }
    return;
  }

  // ── /tickets set ──────────────────────────────────────────────────────────
  if (sub === "set") {
    const oldBalance = getBalance(targetUser.id);
    const newBalance = setTickets(
      targetUser.id, targetUser.username, amount, reason,
      interaction.user.id, interaction.user.username
    );
    await interaction.editReply({
      embeds: [base(GREY)
        .setTitle("🎟️ Balance Set")
        .addFields(
          { name: "Player",      value: safeStr(targetUser.username),       inline: true  },
          { name: "Old Balance", value: safeStr(oldBalance),                inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                inline: true  },
          { name: "Reason",      value: safeStr(reason),                    inline: false },
          { name: "Staff",       value: safeStr(interaction.user.username), inline: true  }
        )],
    });
    try {
      sendLog(interaction.guild, base(GREY)
        .setTitle("🔧 Balance Set (Override)")
        .addFields(
          { name: "Player",      value: safeStr(`<@${targetUser.id}>`),       inline: true  },
          { name: "Old Balance", value: safeStr(oldBalance),                  inline: true  },
          { name: "New Balance", value: safeStr(newBalance),                  inline: true  },
          { name: "Reason",      value: safeStr(reason),                      inline: false },
          { name: "Staff",       value: safeStr(`<@${interaction.user.id}>`), inline: true  }
        )
      );
    } catch (e) { console.error("[log] build error (set):", e.message); }
    return;
  }

  // ── /tickets history ──────────────────────────────────────────────────────
  if (sub === "history") {
    const rows = getHistory(targetUser.id, 10);
    if (rows.length === 0) {
      return interaction.editReply({
        content: `📭 No ticket history for **${targetUser.username}**.`,
      });
    }

    const actionEmoji = { add: "➕", use: "🎮", remove: "➖", set: "🔧" };
    const lines = rows.map((r) => {
      const emoji = actionEmoji[r.action] ?? "•";
      const sign  = r.amount >= 0 ? "+" : "";
      const note  = r.reason ? ` — *${r.reason}*` : "";
      const date  = r.timestamp.slice(0, 10);
      return `${emoji} \`${date}\` **${sign}${r.amount}**${note}`;
    });

    const embed = base(GREY)
      .setTitle(`🕓 Ticket History — ${targetUser.username}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Current balance: ${getBalance(targetUser.id)} ticket(s) · Last 10 entries` })
      .setThumbnail(targetUser.displayAvatarURL());
    return interaction.editReply({ embeds: [embed] });
  }
}

// ── Log helper ────────────────────────────────────────────────────────────────
// Not awaited at call sites — logging must never affect command success/failure.
// The embed is pre-built by the caller; errors there are caught with try/catch above.
function sendLog(guild, embed) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;

  guild.channels.fetch(channelId)
    .then((ch) => {
      if (!ch) {
        console.error(`[log] Channel ${channelId} not found — check LOG_CHANNEL_ID.`);
        return;
      }
      if (!ch.isTextBased()) {
        console.error(`[log] Channel ${channelId} is not a text channel.`);
        return;
      }
      return ch.send({ embeds: [embed] });
    })
    .catch((err) => {
      console.error(`[log] Failed to post to channel ${channelId}: ${err.message}`);
    });
}
