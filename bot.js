import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
} from "discord.js";
import fs from "fs";
import "dotenv/config";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const TOKEN = process.env.DISCORD_TOK;

// Load roles.json globally
let rolesData = [];
try {
  rolesData = JSON.parse(fs.readFileSync("roles.json", "utf8"));
} catch (err) {
  console.error("❌ Failed to load roles.json:", err);
}

function chunkArray(arr, size) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Role creation queue with concurrency & rate-limit handling ----
async function createRoleQueueConcurrent(guild, rolesData, concurrency = 3) {
  const createdRoles = [];
  const queue = [...rolesData];

  const workers = Array(concurrency)
    .fill(null)
    .map(async () => {
      while (queue.length > 0) {
        const { name, color } = queue.shift();
        let role = guild.roles.cache.find((r) => r.name === name);
        if (!role) {
          let success = false;
          while (!success) {
            try {
              const primaryColor = parseInt(color.replace("#", ""), 16);
              role = await guild.roles.create({
                name,
                colors: { primaryColor },
              });
              console.log(`✅ Created role: ${name}`);
              createdRoles.push(role);
              success = true;
              await delay(300);
            } catch (err) {
              if (
                err.code === 30010 ||
                err.message?.includes("Too Many Requests")
              ) {
                const waitTime = err.retryAfter ?? 5000;
                console.log(
                  `⚠️ Rate limited on "${name}". Waiting ${waitTime}ms...`
                );
                await delay(waitTime);
              } else {
                console.error(`❌ Failed to create role "${name}":`, err);
                success = true; // skip errors
              }
            }
          }
        } else {
          createdRoles.push(role);
        }
      }
    });

  await Promise.all(workers);
  return createdRoles;
}

client.once("clintReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!epic-roles")) return;
  if (
    !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return message.reply({
      content: "❌ You need administrator permissions to use this.",
      ephemeral: true,
    });
  }

  const args = message.content.split(" ").slice(1);
  const subCommand = args[0];
  const guild = message.guild;

  // ---- !epic-roles add ----
  if (subCommand === "add") {
    const createdRoles = await createRoleQueueConcurrent(guild, rolesData, 5);
    await message.reply({
      content: `✅ Added/verified **${createdRoles.length}** roles from \`roles.json\`.`,
      ephemeral: true,
    });
  }

  // ---- !epic-roles remove ----
  if (subCommand === "remove") {
    const removedRoles = [];
    for (const { name } of rolesData) {
      const role = guild.roles.cache.find((r) => r.name === name);
      if (role) {
        await role.delete().catch(() => null);
        console.log(`Removed role: ${name}`);
        removedRoles.push(name);
      }
    }
    await message.reply({
      content:
        removedRoles.length > 0
          ? `🗑️ Removed **${removedRoles.length}** roles from \`roles.json\`.`
          : "⚠️ No matching roles were found to remove.",
      ephemeral: true,
    });
  }

  // ---- !epic-roles dropdown <channel-id> ----
  if (subCommand === "dropdown") {
    const channelId = args[1];
    if (!channelId)
      return message.reply({
        content: "❌ Please provide a channel ID.",
        ephemeral: true,
      });

    const targetChannel = await message.guild.channels
      .fetch(channelId)
      .catch(() => null);
    if (!targetChannel)
      return message.reply({
        content: "❌ Invalid channel ID.",
        ephemeral: true,
      });

    const guildRoles = guild.roles.cache;
    const enrichedRoles = rolesData
      .map((data) => {
        const role = guildRoles.find((r) => r.name === data.name);
        return { role, emoji: data.emoji || null, hex: data.color };
      })
      .filter((r) => r.role);

    const chunks = chunkArray(enrichedRoles, 25);

    for (let i = 0; i < chunks.length; i++) {
      const options = chunks[i].map(({ role, emoji, hex }) => ({
        label: role.name,
        value: role.id,
        emoji: emoji || undefined,
        description: hex,
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`colorRoles_${i}`)
        .setPlaceholder("Pick your color")
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(menu);

      await targetChannel.send({
        content: `🎨 **Color Roles Page ${i + 1}**`,
        components: [row],
      });
    }

    await message.reply({
      content: `✅ Dropdown menus created in <#${channelId}>`,
      ephemeral: true,
    });
  }
});

// ---- Handle menu interactions ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("colorRoles_")) return;

  const member = interaction.member;
  const guild = interaction.guild;

  const colorRoleIds = rolesData
    .map((r) => guild.roles.cache.find((role) => role.name === r.name)?.id)
    .filter(Boolean);

  // Remove existing color roles
  for (const roleId of colorRoleIds) {
    if (member.roles.cache.has(roleId)) await member.roles.remove(roleId);
  }

  if (interaction.values.length > 0) {
    const newRoleId = interaction.values[0];
    await member.roles.add(newRoleId);
    return interaction.reply({
      content: `✅ You now have the **${
        guild.roles.cache.get(newRoleId).name
      }** role!`,
      ephemeral: true,
    });
  } else {
    return interaction.reply({
      content: "🗑️ Removed your color role.",
      ephemeral: true,
    });
  }
});

client.login(TOKEN);
