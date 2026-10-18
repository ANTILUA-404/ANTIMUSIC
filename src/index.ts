import http from "node:http";
import {
  Client, Events, GatewayIntentBits, GuildMember, Message, MessageFlags, Partials, REST, Routes
} from "discord.js";
import { config } from "./config.js";
import { slashCommands } from "./commands.js";
import { log } from "./logger.js";
import { Ctx, MusicService } from "./music.js";
import { ensureLavalinkRunning, stopLavalinkProcess } from "./lavalink-process.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const music = new MusicService(client);
client.on("raw", d => music.raw(d));

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  try {
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: slashCommands });
      log.info({ scope: `guild:${config.guildId}` }, "Slash commands registered");
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), { body: slashCommands });
      log.info({ scope: "global" }, "Slash commands registered globally");
    }
  } catch (e) {
    log.error({ e }, "Failed to register slash commands");
  }
}

client.once(Events.ClientReady, async c => {
  music.init(c.user);
  log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "ANTIMUSIC online");
  c.user.setActivity(`${config.prefix}play • ANTIMUSIC`);
  await registerCommands();
});

const makeInteractionCtx = (i: any): Ctx => ({
  guildId: i.guildId,
  channelId: i.channelId,
  member: i.member as GuildMember,
  user: i.user,
  reply: async (payload: any) => {
    const data = typeof payload === "string" ? { content: payload } : payload;
    if (i.deferred || i.replied) return i.editReply(data);
    return i.reply(data);
  },
  edit: (payload: any) => i.editReply(typeof payload === "string" ? { content: payload } : payload),
});

client.on("interactionCreate", async i => {
  try {
    if (i.isButton()) {
      return void await music.handleButton(i);
    }

    if (!i.isChatInputCommand() || !i.inGuild()) return;

    await i.deferReply();
    const ctx = makeInteractionCtx(i);

    switch (i.commandName) {
      case "play":
        return void await music.play(ctx, i.options.getString("query", true));
      case "skip":
        return void await music.skip(ctx);
      case "stop":
        return void await music.stop(ctx);
      case "pause":
        return void await music.pause(ctx);
      case "resume":
        return void await music.resume(ctx);
      case "queue":
        return void await music.queue(ctx);
      case "nowplaying":
        return void await music.nowPlaying(ctx);
      case "volume":
        return void await music.volume(ctx, i.options.getInteger("level"));
      case "shuffle":
        return void await music.shuffle(ctx);
      case "clear":
        return void await music.clear(ctx);
      case "autoplay":
        return void await music.autoplay(ctx, i.options.getBoolean("enabled"));
      case "loop":
        return void await music.loop(ctx, i.options.getString("mode") as any);
      case "remove":
        return void await music.remove(ctx, i.options.getInteger("position", true));
      case "seek":
        return void await music.seek(ctx, i.options.getString("time", true));
      case "leave":
        return void await music.leave(ctx);
      case "ultrahd":
        return void await music.ultrahd(ctx, i.options.getString("profile"));
      case "help":
        return void await music.help(ctx);
      case "ping":
        return void await music.ping(ctx);
    }
  } catch (e: any) {
    log.error({ e }, "Interaction error");
    if (i.isRepliable()) {
      await (i.replied || i.deferred
        ? i.editReply({ content: `❌ ${e.message || "Error"}` })
        : i.reply({ content: `❌ ${e.message || "Error"}`, flags: MessageFlags.Ephemeral })
      ).catch(() => {});
    }
  }
});

client.on("messageCreate", async (m: Message) => {
  if (m.author.bot || !m.guild || !m.member || !m.content.startsWith(config.prefix)) return;

  const body = m.content.slice(config.prefix.length).trim();
  if (!body) return;

  const [raw, ...rest] = body.split(/\s+/);
  const cmd = raw.toLowerCase();
  const arg = rest.join(" ");

  const ctx: Ctx = {
    guildId: m.guild.id,
    channelId: m.channel.id,
    member: m.member,
    user: m.author,
    reply: (p: any) => m.reply(typeof p === "string" ? { content: p } : p),
  };

  try {
    if (["play", "p"].includes(cmd)) return void await music.play(ctx, arg);
    if (["skip", "s"].includes(cmd)) return void await music.skip(ctx);
    if (cmd === "stop") return void await music.stop(ctx);
    if (cmd === "pause") return void await music.pause(ctx);
    if (cmd === "resume") return void await music.resume(ctx);
    if (["queue", "q"].includes(cmd)) return void await music.queue(ctx);
    if (["nowplaying", "np"].includes(cmd)) return void await music.nowPlaying(ctx);

    if (["volume", "vol", "v"].includes(cmd)) {
      const val = rest.length ? Number(rest[0]) : null;
      return void await music.volume(ctx, val);
    }

    if (cmd === "shuffle") return void await music.shuffle(ctx);
    if (cmd === "clear") return void await music.clear(ctx);

    if (cmd === "autoplay") {
      const val = rest.length ? /^(on|true|1|yes)$/i.test(rest[0]) : null;
      return void await music.autoplay(ctx, val);
    }

    if (cmd === "loop") {
      const mode = rest.length && ["off", "track", "queue"].includes(rest[0].toLowerCase())
        ? (rest[0].toLowerCase() as any)
        : null;
      return void await music.loop(ctx, mode);
    }

    if (cmd === "remove") {
      return void await music.remove(ctx, Number(rest[0]));
    }

    if (cmd === "seek") {
      return void await music.seek(ctx, rest.join(" "));
    }

    if (["leave", "disconnect", "dc"].includes(cmd)) return void await music.leave(ctx);
    if (["ultrahd", "hd", "eq", "audio"].includes(cmd)) return void await music.ultrahd(ctx, arg);
    if (cmd === "ping") return void await music.ping(ctx);
    if (["help", "h"].includes(cmd)) return void await music.help(ctx);
  } catch (e: any) {
    log.error({ e, cmd }, "Prefix command error");
    await m.reply(`❌ ${e.message || "Error"}`).catch(() => {});
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = oldState.guild.id || newState.guild.id;

  if (oldState.member?.id === client.user?.id) {
    if (!newState.channelId) {
      const p = music.getPlayer(guildId);
      if (p) await p.destroy().catch(() => {});
      music.cancelEmptyChannelTimer(guildId);
      return;
    }

    if (newState.channelId && oldState.channelId !== newState.channelId) {
      const p = music.getPlayer(guildId);
      if (p) {
        p.voiceChannelId = newState.channelId;
        log.info({ guildId, channelId: newState.channelId }, "Bot moved to another voice channel");
      }
    }
  }

  music.checkEmptyChannel(guildId);
});

client.on("guildDelete", async g => {
  const p = music.getPlayer(g.id);
  if (p) await p.destroy().catch(() => {});
  music.cancelEmptyChannelTimer(g.id);
});

http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health" || req.url === "/") {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      bot: client.user?.tag || null,
      guilds: client.guilds.cache.size,
      wsPing: client.ws.ping,
      uptime: process.uptime(),
    }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  }
}).listen(config.healthPort, "0.0.0.0", () => {
  log.info({ port: config.healthPort }, "Health server online");
});

const shutdown = async (sig: string) => {
  log.info({ sig }, "Graceful shutdown");
  try {
    await music.destroyAll();
  } catch {}
  client.destroy();
  stopLavalinkProcess();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("exit", () => stopLavalinkProcess());
process.on("unhandledRejection", e => log.error({ e }, "Unhandled rejection"));
process.on("uncaughtException", e => log.fatal({ e }, "Uncaught exception"));

void ensureLavalinkRunning();
client.login(config.token);
