// deploy-commands.js  –  Run ONCE to register slash commands with Discord
// Usage: node deploy-commands.js
import "dotenv/config";
import { REST, Routes } from "discord.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const commands = [];

const commandFiles = readdirSync(join(__dirname, "commands")).filter((f) =>
  f.endsWith(".js")
);

for (const file of commandFiles) {
  const cmd = await import(`./commands/${file}`);
  commands.push(cmd.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

console.log(`🔄  Registering ${commands.length} command(s)...`);

try {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
  console.log("✅  Slash commands registered successfully.");
} catch (err) {
  console.error("❌  Failed to register commands:", err);
}
