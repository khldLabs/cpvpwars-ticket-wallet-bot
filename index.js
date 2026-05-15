// index.js  –  Bot entry point
import "dotenv/config";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Client setup ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();

// ── Load commands ─────────────────────────────────────────────────────────────
const commandFiles = readdirSync(join(__dirname, "commands")).filter((f) =>
  f.endsWith(".js")
);

for (const file of commandFiles) {
  const cmd = await import(`./commands/${file}`);
  client.commands.set(cmd.data.name, cmd);
}

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once("clientReady", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`📋  Commands loaded: ${[...client.commands.keys()].join(", ")}`);
});

// ── Interactions ──────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    // Print the error clearly so it's easy to diagnose in the terminal
    console.error(`\n[ERROR] /${interaction.commandName} — ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);

    const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
    try {
      if (interaction.replied) {
        // editReply already succeeded — DB change is done, only logging failed.
        // Don't send a confusing error message on top of a successful response.
        console.error("[ERROR] The command already replied successfully. Suppressing followUp error message.");
      } else if (interaction.deferred) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (replyErr) {
      console.error("[ERROR] Failed to send error reply:", replyErr.message);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);

// Schedule daily backups of wallet.db
import("./backup.js").then(({ scheduleBackups }) => scheduleBackups());

// Start the Tebex webhook server once the bot is ready
client.once("clientReady", () => {
  if (process.env.TEBEX_WEBHOOK_SECRET || process.env.WEBHOOK_PORT) {
    import("./webhook.js").then(({ createWebhookServer }) => {
      createWebhookServer(client);
    });
  } else {
    console.log("ℹ️  Webhook server not started (TEBEX_WEBHOOK_SECRET not set).");
    console.log("   Set it in .env to enable automatic Tebex → ticket syncing.");
  }
});
