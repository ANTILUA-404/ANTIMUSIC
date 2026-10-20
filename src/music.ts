import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  GuildMember, Message, MessageFlags, PermissionFlagsBits, TextBasedChannel
} from "discord.js";
import { LavalinkManager } from "lavalink-client";
import { applyAudioQualityProfile, optimizeVoiceChannelBitrate, PROFILE_INFO } from "./audio-hd.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { HDProfile, patchState, remember, state } from "./state.js";
import {
  baseEmbed, isUrl, ms, normalizeQuery, parseSeconds,
  requesterName, trackArtwork, trackAuthor, trackLength, trackTitle, trackUri, truncate
} from "./utils.js";

export type Ctx = {
  guildId: string;
  channelId: string;
  member: GuildMember;
  user: any;
  reply: (payload: any) => Promise<any>;
  edit?: (payload: any) => Promise<any>;
};

async function getYoutubeTitleFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const rawTitle = data?.title?.trim();
    if (!rawTitle) return null;

    const cleanTitle = rawTitle
      .replace(/\|+/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\((official\s*(music)?\s*video|official\s*audio|lyrics?|remaster(ed)?)\)/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleanTitle || rawTitle;
  } catch {
    return null;
  }
}

export class MusicService {
  public lavalink: LavalinkManager;
  private lastTrack = new Map<string, any>();
  private autoplayBusy = new Set<string>();
  private emptyTimers = new Map<string, NodeJS.Timeout>();
  private npMessages = new Map<string, Message>();
  private nodeCooldowns = new Map<string, number>();
  private autoplayPool = new Map<string, any[]>();

  public markNodeDegraded(nodeId: string, durationMs = 45_000) {
    this.nodeCooldowns.set(nodeId, Date.now() + durationMs);
  }

  public isNodeHealthy(node: any): boolean {
    if (!node || !node.connected || !node.info) return false;
    const cooldownUntil = this.nodeCooldowns.get(node.id) || 0;
    return Date.now() > cooldownUntil;
  }

  private cleanTitleForCompare(t: string): string {
    return (t || "")
      .toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/(official\s*(music)?\s*video|official\s*audio|lyrics?|full\s*album|cover|remix|acoustic|live|slowed|reverb|hd|4k|audio|video)/gi, " ")
      .replace(/[^a-z0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isSameSong(t1: string, t2: string): boolean {
    const c1 = this.cleanTitleForCompare(t1);
    const c2 = this.cleanTitleForCompare(t2);
    if (!c1 || !c2) return false;
    if (c1 === c2) return true;
    if (c1.includes(c2) || c2.includes(c1)) return true;

    const words1 = new Set(c1.split(" ").filter(w => w.length > 2));
    const words2 = new Set(c2.split(" ").filter(w => w.length > 2));
    if (!words1.size || !words2.size) return false;

    let match = 0;
    for (const w of words1) if (words2.has(w)) match++;
    const ratio = match / Math.max(words1.size, words2.size);
    return ratio >= 0.55;
  }

  private extractYouTubeVideoId(track: any): string | null {
    if (!track) return null;
    const identifier = track?.info?.identifier;
    if (identifier && /^[a-zA-Z0-9_-]{11}$/.test(identifier) && (!track?.info?.sourceName || track?.info?.sourceName === "youtube")) {
      return identifier;
    }
    const uri = trackUri(track);
    if (uri) {
      const match = uri.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      if (match) return match[1];
    }
    return null;
  }

  constructor(private client: Client) {
    this.lavalink = new LavalinkManager({
      nodes: config.lavalinkNodes,
      sendToShard: (guildId: string, payload: any) => {
        const guild = this.client.guilds.cache.get(guildId);
        (guild?.shard ?? this.client.ws.shards.first())?.send(payload);
      },
      autoSkip: true,
      autoMove: config.autoFailover,
      client: { id: config.clientId, username: "ANTIMUSIC" },
      playerOptions: {
        defaultSearchPlatform: "ytmsearch",
        volumeDecrementer: 0.8,
        onDisconnect: { autoReconnect: true, destroyPlayer: false },
        onEmptyQueue: { destroyAfterMs: config.idleDestroyMs },
        useUnresolvedData: true,
      },
      queueOptions: { maxPreviousTracks: 20 },
    } as any);

    this.registerEvents();
  }

  init(user: any) {
    this.lavalink.init({ ...user });
  }

  raw(d: any) {
    this.lavalink.sendRawData(d);
  }

  getAllPlayers(): any[] {
    try {
      const players = (this.lavalink as any).players;
      if (!players) return [];
      if (typeof players.values === "function") return Array.from(players.values());
      return [];
    } catch {
      return [];
    }
  }

  getPlayer(guildId: string): any {
    try {
      const players = (this.lavalink as any).players;
      return players?.get?.(guildId) ?? (this.lavalink as any).getPlayer?.(guildId);
    } catch {
      return null;
    }
  }

  public async destroyAll() {
    for (const p of this.getAllPlayers()) {
      this.stopNowPlayingUpdater(p.guildId);
      await p.destroy().catch(() => {});
    }
  }

  public getPlayerPosition(player: any): number {
    if (!player || !player.queue?.current) return 0;
    const track = player.queue.current;
    const len = trackLength(track);
    if (!len || track?.info?.isStream) return 0;

    let pos = 0;
    if (typeof player.lastPosition === "number") {
      if (player.paused || !player.lastPositionChange) {
        pos = player.lastPosition;
      } else {
        pos = player.lastPosition + (Date.now() - player.lastPositionChange);
      }
    } else if (typeof player.position === "number") {
      pos = player.position;
    }

    return Math.min(Math.max(0, pos), len);
  }

  public stopNowPlayingUpdater(guildId: string) {
    this.npMessages.delete(guildId);
  }

  public async updateNowPlayingMessage(player: any) {
    try {
      const msg = this.npMessages.get(player.guildId);
      if (msg && player.queue?.current) {
        await msg.edit({
          embeds: [this.nowPlayingEmbed(player.queue.current, player)],
          components: [this.controls(player)],
        }).catch(() => {});
      }
    } catch {}
  }

  private registerEvents() {
    this.lavalink.nodeManager.on("connect", (node: any) => {
      log.info({ node: node.id, host: node.options.host, port: node.options.port }, "Lavalink connected");
      this.nodeCooldowns.delete(node.id);
      node.updateSession?.(true, 300_000).catch?.(() => {});
    });

    this.lavalink.nodeManager.on("error", (node: any, error: any) => {
      log.error({ node: node.id, error: error?.message || error }, "Lavalink node error");
      this.markNodeDegraded(node.id, 60_000);
    });

    this.lavalink.nodeManager.on("disconnect", async (node: any, reason: any) => {
      log.warn({ node: node.id, reason }, "Lavalink node disconnected. Checking failover candidates...");
      this.markNodeDegraded(node.id, 90_000);

      if (!config.autoFailover) return;

      const affectedPlayers = this.getAllPlayers().filter(
        (p: any) => p.node?.options?.id === node.options?.id || p.node?.id === node.id
      );

      if (!affectedPlayers.length) return;

      const healthyNodes = Array.from(this.lavalink.nodeManager.nodes.values()).filter(
        (n: any) => n.id !== node.id && n.connected && n.sessionId && this.isNodeHealthy(n)
      );

      const candidateNodes = healthyNodes.length
        ? healthyNodes
        : Array.from(this.lavalink.nodeManager.nodes.values()).filter(
            (n: any) => n.id !== node.id && n.connected && n.info
          );

      if (!candidateNodes.length) {
        log.warn({ node: node.id }, "No healthy backup nodes available for failover");
        return;
      }

      const leastUsed = this.lavalink.nodeManager.leastUsedNodes();
      const targetNode = candidateNodes.find((c: any) => leastUsed.some((l: any) => l.id === c.id)) || candidateNodes[0];

      for (const player of affectedPlayers) {
        try {
          await player.changeNode(targetNode, false).catch(() => {});

          const s = state(player.guildId);
          if (s.ultraHd) {
            await applyAudioQualityProfile(player, s.hdProfile).catch(() => {});
          }

          const ch: any = this.client.channels.cache.get(player.textChannelId);
          if (ch?.isTextBased?.()) {
            await ch.send({
              content: `🛡️ **Failover Otomatis**: Server audio \`${node.id}\` terputus. Musik otomatis dialihkan ke server cadangan **${targetNode.id}** (\`${targetNode.options.host}\`) tanpa terhenti!`,
            }).catch(() => {});
          }
        } catch (err: any) {
          log.error({ err, guildId: player.guildId }, "Failover player migration failed");
        }
      }
    });

    this.lavalink.on("trackStart", async (player: any, track: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      player.lastPosition = 0;
      player.lastPositionChange = Date.now();

      this.cancelEmptyChannelTimer(player.guildId);
      this.lastTrack.set(player.guildId, track);
      remember(player.guildId, track?.info?.identifier || trackUri(track) || trackTitle(track));

      const s = state(player.guildId);
      if (s.ultraHd) {
        await applyAudioQualityProfile(player, s.hdProfile).catch(() => {});
      }

      const ch: any = this.client.channels.cache.get(player.textChannelId);
      if (!ch?.isTextBased?.()) return;

      const sent = await ch.send({
        embeds: [this.nowPlayingEmbed(track, player)],
        components: [this.controls(player)],
      }).catch(() => null);

      if (sent) {
        this.npMessages.set(player.guildId, sent);
      }
    });

    this.lavalink.on("trackEnd", (player: any) => {
      this.stopNowPlayingUpdater(player.guildId);
    });

    this.lavalink.on("trackError", async (player: any, track: any, payload: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      log.warn({ guild: player.guildId, track: trackTitle(track), payload }, "Track error");
      const ch: any = this.client.channels.cache.get(player.textChannelId);
      const reason = payload?.exception?.message || payload?.error || "Gagal memutar audio.";

      // Jika error karena blokir IP YouTube atau koneksi gagal, coba failover ke node cadangan
      const isRecoverableError = /login|all clients failed|sign in|blocked|rate limit|connection reset/i.test(reason);
      if (isRecoverableError && config.autoFailover) {
        const otherNodes = Array.from(this.lavalink.nodeManager.nodes.values()).filter(
          (n: any) => n.id !== player.node?.id && n.connected
        );
        if (otherNodes.length > 0) {
          const backupNode = otherNodes[0];
          log.info({ from: player.node?.id, to: backupNode.id }, "Switching to backup node due to track error");
          await player.changeNode(backupNode, false).catch(() => {});
          await ch?.send?.(`🔄 Terjadi kendala pemutaran di server \`${player.node?.id}\`. Mengalihkan ke server cadangan **${backupNode.id}**...`).catch?.(() => {});
          const s = state(player.guildId);
          if (s.ultraHd) {
            await applyAudioQualityProfile(player, s.hdProfile).catch(() => {});
          }
          await player.play({ track }).catch(() => {});
          return;
        }
      }

      await ch?.send?.(`⚠️ Gagal memutar **${truncate(trackTitle(track), 60)}**: ${reason}`).catch?.(() => {});
    });

    this.lavalink.on("trackStuck", async (player: any, track: any, payload: any) => {
      log.warn({ guild: player.guildId, track: trackTitle(track), payload }, "Track stuck");
      const ch: any = this.client.channels.cache.get(player.textChannelId);
      await ch?.send?.(`⚠️ Track **${truncate(trackTitle(track), 60)}** macet. Melewati ke track berikutnya...`).catch?.(() => {});
      await player.skip(0, false).catch?.(() => {});
    });

    this.lavalink.on("queueEnd", async (player: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      const s = state(player.guildId);
      if (s.autoplay) {
        const handled = await this.smartAutoplay(player);
        if (handled) return;
      }

      const ch: any = this.client.channels.cache.get(player.textChannelId);
      if (config.idleDestroyMs > 0) {
        await ch?.send?.(`🛑 Queue habis. ANTIMUSIC standby selama ${Math.round(config.idleDestroyMs / 1000)} detik sebelum keluar.`).catch?.(() => {});
      } else {
        await ch?.send?.("🛑 Queue habis. ANTIMUSIC keluar dari voice channel.").catch?.(() => {});
        await player.destroy().catch(() => {});
      }
    });

    (this.lavalink as any).on("playerQueueEmptyEnd", async (player: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      const ch: any = this.client.channels.cache.get(player.textChannelId);
      await ch?.send?.("🛑 Waktu standby habis. ANTIMUSIC keluar dari voice channel.").catch?.(() => {});
    });

    (this.lavalink as any).on("playerDestroy", (player: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      this.lastTrack.delete(player.guildId);
      this.autoplayBusy.delete(player.guildId);
      this.cancelEmptyChannelTimer(player.guildId);
    });
  }

  private controls(player?: any) {
    const isPaused = player?.paused ?? false;
    const isAutoplay = player ? state(player.guildId).autoplay : false;

    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("am_pause")
        .setEmoji(isPaused ? "▶️" : "⏸️")
        .setLabel(isPaused ? "Resume" : "Pause")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("am_skip")
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("am_shuffle")
        .setEmoji("🔀")
        .setLabel("Shuffle")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("am_stop")
        .setEmoji("⏹️")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("am_autoplay")
        .setEmoji("♾️")
        .setLabel(isAutoplay ? "Autoplay ON" : "Autoplay OFF")
        .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }

  private nowPlayingEmbed(track: any, player: any) {
    const uri = trackUri(track);
    const len = trackLength(track);
    const isStream = !!(track?.info?.isStream);
    const isPaused = player?.paused ?? false;

    const durationStr = isStream ? "🔴 LIVE" : (len ? ms(len) : "0:00");
    const guildState = state(player.guildId);
    const safeTitle = truncate(trackTitle(track), 80).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    const statusText = isPaused ? "\n\n⏸️ *(Sedang Dijeda)*" : "";

    const e = baseEmbed("🎧 ANTIMUSIC • Now Playing")
      .setDescription(
        `${uri ? `**[${safeTitle}](${uri})**` : `**${safeTitle}**`}${statusText}`
      )
      .addFields(
        { name: "Artist", value: truncate(trackAuthor(track), 40), inline: true },
        { name: "Durasi", value: durationStr, inline: true },
        { name: "Volume", value: `${player.volume ?? guildState.volume}%`, inline: true },
        { name: "Requester", value: requesterName(track, this.client.user?.id), inline: true },
        { name: "Autoplay", value: guildState.autoplay ? "ON 🟢" : "OFF ⚪", inline: true },
        { name: "Loop", value: `${player.repeatMode || guildState.loop}`.toUpperCase(), inline: true },
        { name: "Kualitas Audio", value: guildState.ultraHd ? `${PROFILE_INFO[guildState.hdProfile].emoji} **${PROFILE_INFO[guildState.hdProfile].label}**` : "⚪ Standard Flat", inline: true },
      )
      .setFooter({ text: "💎 Ultra HD Studio Engine • 48kHz Stereo Opus" });

    const art = trackArtwork(track);
    if (art) e.setThumbnail(art);

    return e;
  }

  private voiceChannel(ctx: Ctx) {
    return ctx.member.voice?.channel;
  }

  private getNodePriority(node: any): number {
    const host = String(node?.options?.host || node?.host || "").toLowerCase();
    const id = String(node?.id || "").toLowerCase();
    if (host.includes("nazha") || id.includes("nazha")) return 1;
    if (host.includes("jirayu") || id.includes("jirayu")) return 2;
    if (host.includes("127.0.0.1") || host.includes("localhost") || id.includes("local")) return 3;
    if (host.includes("serenetia") || id.includes("serenetia")) return 4;
    return 5;
  }

  private async migratePlayerToNode(player: any, targetNode: any): Promise<boolean> {
    if (!player || !targetNode) return false;
    if (player.node?.id === targetNode.id) return true;

    try {
      if (player.voice?.token && player.voice?.endpoint && player.voice?.sessionId) {
        await player.changeNode(targetNode, false);
        return true;
      }
      player.node = targetNode;
      return true;
    } catch (err: any) {
      log.warn({ err: err?.message || err, from: player.node?.id, to: targetNode.id }, "changeNode failed, falling back to direct assignment");
      player.node = targetNode;
      return true;
    }
  }

  private async safePlay(player: any, maxRetries = 2): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (player.voice?.token && player.voice?.endpoint) break;
      await new Promise(r => setTimeout(r, 100));
    }

    let lastError: any = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await player.play();
        return;
      } catch (err: any) {
        lastError = err;
        const msg = err?.message || String(err);
        log.warn({ attempt, error: msg, node: player.node?.id }, "player.play() gagal. Mencoba failover ke server lain...");

        if (player.node?.id) {
          this.markNodeDegraded(player.node.id, 60_000);
        }

        const candidateNodes = Array.from(this.lavalink.nodeManager.nodes.values()).filter(
          (n: any) => n.connected && n.info && n.id !== player.node?.id && this.isNodeHealthy(n)
        ).sort((a: any, b: any) => this.getNodePriority(a) - this.getNodePriority(b));

        if (!candidateNodes.length) {
          break;
        }

        const nextNode = candidateNodes[0];
        log.info({ from: player.node?.id, to: nextNode.id }, "Memindahkan player ke node cadangan...");
        await this.migratePlayerToNode(player, nextNode);
      }
    }

    if (lastError) {
      const msg = lastError.message || String(lastError);
      if (/timeout|aborted/i.test(msg)) {
        throw new Error(
          "Server audio mengalami timeout saat memulai pemutaran lagu.\n" +
          "💡 **Solusi:** Coba jalankan kembali `?play <lagu>` atau gunakan `?changenode` untuk beralih ke node lain."
        );
      }
      throw lastError;
    }
  }

  private async ensurePlayer(ctx: Ctx) {
    const voice = this.voiceChannel(ctx);
    if (!voice) throw new Error("Kamu harus masuk voice channel terlebih dahulu.");

    const botMember = ctx.member.guild.members.me ?? (await ctx.member.guild.members.fetch(this.client.user?.id || "").catch(() => null));
    if (botMember) {
      const perms = voice.permissionsFor(botMember);
      if (!perms?.has(PermissionFlagsBits.Connect)) {
        throw new Error(`ANTIMUSIC tidak memiliki izin **Connect** di voice channel <#${voice.id}>.`);
      }
      if (!perms?.has(PermissionFlagsBits.Speak)) {
        throw new Error(`ANTIMUSIC tidak memiliki izin **Speak** di voice channel <#${voice.id}>.`);
      }
    }

    const allNodes = Array.from(this.lavalink.nodeManager.nodes.values());
    const connectedNodes = allNodes.filter(n => n.connected && n.info);
    if (!connectedNodes.length) {
      const summary = allNodes.map(n => `• \`${n.id}\` (${n.options.host}): ${n.connected ? "Connected" : "Disconnected/Reconnecting"}`).join("\n");
      throw new Error(
        `Semua server audio (Lavalink) sedang offline atau belum terhubung.\n` +
        (summary || `• Host: \`${config.lavalink.host}:${config.lavalink.port}\``) + `\n` +
        `Bot sedang berusaha menyambung ulang secara otomatis ke semua host.`
      );
    }

    const healthyNodes = connectedNodes.filter(n => this.isNodeHealthy(n));
    const pool = healthyNodes.length ? healthyNodes : connectedNodes;
    const sortedPool = [...pool].sort((a, b) => this.getNodePriority(a) - this.getNodePriority(b));
    const targetNode = sortedPool[0];

    let player = this.getPlayer(ctx.guildId);

    if (player && (!player.node || !player.node.connected || !this.isNodeHealthy(player.node))) {
      await this.migratePlayerToNode(player, targetNode).catch(() => {});
    }

    if (player && player.connected && player.voiceChannelId && player.voiceChannelId !== voice.id) {
      const currentChannel = ctx.member.guild.channels.cache.get(player.voiceChannelId);
      const activeHumanListeners = currentChannel?.isVoiceBased()
        ? currentChannel.members.filter(m => !m.user.bot).size
        : 0;

      if (activeHumanListeners > 0) {
        throw new Error(`ANTIMUSIC sedang digunakan oleh member lain di channel <#${player.voiceChannelId}>.`);
      }

      player.voiceChannelId = voice.id;
      player.textChannelId = ctx.channelId;
      await player.connect();
      return player;
    }

    const s = state(ctx.guildId);

    if (!player) {
      player = this.lavalink.createPlayer({
        guildId: ctx.guildId,
        voiceChannelId: voice.id,
        textChannelId: ctx.channelId,
        selfDeaf: true,
        selfMute: false,
        volume: s.volume,
        node: targetNode,
      } as any);

      await player.connect();

      if (s.loop && s.loop !== "off") {
        await player.setRepeatMode(s.loop).catch(() => {});
      }
    } else {
      player.textChannelId = ctx.channelId;
      if (!player.connected) {
        player.voiceChannelId = voice.id;
        await player.connect();
      }
    }

    await optimizeVoiceChannelBitrate(voice).catch(() => {});
    if (s.ultraHd) {
      await applyAudioQualityProfile(player, s.hdProfile).catch(() => {});
    }

    return player;
  }

  private sameVoice(ctx: Ctx, player: any) {
    const v = this.voiceChannel(ctx);
    if (!v) return false;
    if (!player?.connected) return true;
    return !player.voiceChannelId || player.voiceChannelId === v.id;
  }

  async searchWithClusterFailover(
    player: any,
    searchQuery: string,
    isDirectUrl: boolean,
    user: any
  ): Promise<{ result: any; fallbackNote?: string }> {
    const allConnected = Array.from(this.lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected && n.info);
    if (!allConnected.length) {
      throw new Error(
        "Semua server audio (Lavalink) sedang offline atau belum terhubung.\n" +
        "Bot sedang berusaha menyambung ulang secara otomatis. Mohon tunggu beberapa saat."
      );
    }

    // Bangun daftar prioritas node: node aktif player (jika sehat), lalu node sehat lainnya diurutkan prioritas, lalu sisa node
    const candidateNodes: any[] = [];
    if (player?.node?.connected && this.isNodeHealthy(player.node)) {
      candidateNodes.push(player.node);
    }

    const otherHealthy = allConnected
      .filter((n: any) => !candidateNodes.some(c => c.id === n.id) && this.isNodeHealthy(n))
      .sort((a: any, b: any) => this.getNodePriority(a) - this.getNodePriority(b));
    candidateNodes.push(...otherHealthy);

    const remaining = allConnected
      .filter((n: any) => !candidateNodes.some(c => c.id === n.id))
      .sort((a: any, b: any) => this.getNodePriority(a) - this.getNodePriority(b));
    candidateNodes.push(...remaining);

    let lastError: any = null;
    let fallbackNote: string | null = null;
    const searchSources = isDirectUrl ? [undefined] : ["ytmsearch", "ytsearch", "spsearch", "scsearch"];

    for (const node of candidateNodes) {
      let nodeHadTimeoutOrNetworkError = false;

      for (const source of searchSources) {
        try {
          const res: any = await node.search(
            { query: searchQuery, source: isDirectUrl ? undefined : source },
            user
          );

          if (res && res.loadType !== "error" && res.tracks?.length) {
            // Berhasil! Jika node berbeda dengan node aktif player saat ini, migrasikan player
            if (player && player.node?.id !== node.id) {
              await this.migratePlayerToNode(player, node);
            }

            if (!isDirectUrl && source && source !== "ytmsearch") {
              const srcLabel = source === "spsearch" ? "Spotify" : source === "scsearch" ? "SoundCloud" : "YouTube";
              fallbackNote = `Diputar via sumber cadangan: ${srcLabel}`;
            }

            return { result: res, fallbackNote: fallbackNote || undefined };
          }

          if (res?.loadType === "error") {
            const msg = res.exception?.message || "";
            if (/timeout|aborted|login|all clients failed|sign in/i.test(msg)) {
              this.markNodeDegraded(node.id, 45_000);
            }
            lastError = new Error(msg);
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          if (/timeout|aborted|fetch failed|econnreset|econnrefused/i.test(errMsg)) {
            this.markNodeDegraded(node.id, 60_000);
            nodeHadTimeoutOrNetworkError = true;
          }
          lastError = err;
        }

        // Jika node ini mengalami network error atau timeout, tidak perlu membuang waktu mencoba source lain di node yang sama
        if (nodeHadTimeoutOrNetworkError) {
          break;
        }
      }
    }

    // Jika direct url YouTube gagal dimuat langsung, coba ambil judul via oEmbed dan cari dengan keyword
    if (isDirectUrl && /(youtube\.com|youtu\.be)/i.test(searchQuery)) {
      log.warn({ url: searchQuery }, "Link YouTube gagal dimuat langsung. Mencoba ambil judul via oEmbed...");
      const ytTitle = await getYoutubeTitleFromUrl(searchQuery);
      if (ytTitle) {
        log.info({ url: searchQuery, ytTitle }, "Judul ditemukan via oEmbed, memulai pencarian judul...");
        const res = await this.searchWithClusterFailover(player, ytTitle, false, user).catch(() => null);
        if (res && res.result?.tracks?.length) {
          return {
            result: res.result,
            fallbackNote: `Diputar dari judul: "${ytTitle}"`,
          };
        }
      }
    }

    if (lastError) {
      const msg = lastError.message || String(lastError);
      if (/timeout|aborted/i.test(msg)) {
        throw new Error(
          "Pencarian lagu mengalami timeout karena server audio sedang padat.\n" +
          "💡 **Solusi:** Coba jalankan kembali `?play <lagu>`, gunakan `?play sc:<lagu>` (SoundCloud), atau ganti host dengan `?changenode`."
        );
      }
      if (/login|all clients failed|sign in/i.test(msg)) {
        throw new Error(
          "Server YouTube membatasi pemutaran langsung (This video requires login).\n" +
          "💡 **Solusi:** Coba ketik `?play sc:<nama lagu>` untuk memutar lagu via SoundCloud."
        );
      }
      throw lastError;
    }

    throw new Error("Lagu tidak ditemukan. Coba gunakan judul atau link lain.");
  }

  async play(ctx: Ctx, query: string) {
    if (!query?.trim()) {
      return ctx.reply({ content: "❌ Masukkan link atau kata kunci lagu. Contoh: `?play Bohemian Rhapsody` atau `/play query: <link>`." });
    }

    try {
      const player = await this.ensurePlayer(ctx);
      this.autoplayPool.delete(ctx.guildId);
      const currentQueueSize = player.queue?.tracks?.length ?? 0;
      if (currentQueueSize >= config.maxQueueSize) {
        throw new Error(`Queue sudah mencapai batas maksimal ${config.maxQueueSize} track.`);
      }

      const searchQuery = normalizeQuery(query);
      const isDirectUrl = isUrl(searchQuery);

      const { result, fallbackNote } = await this.searchWithClusterFailover(
        player,
        searchQuery,
        isDirectUrl,
        ctx.user
      );

      if (!result?.tracks?.length || result.loadType === "empty") {
        throw new Error("Lagu tidak ditemukan. Coba gunakan judul atau link lain.");
      }

      const availableSlots = Math.max(1, config.maxQueueSize - currentQueueSize);
      const tracks = result.tracks.slice(0, availableSlots);

      await player.queue.add(tracks);

      const isPlaylist = tracks.length > 1 || String(result.loadType || "").toLowerCase().includes("playlist");
      const playlistName = result.playlist?.title || result.playlist?.name || null;

      if (!player.playing && !player.queue.current) {
        if (player.paused) await player.resume().catch(() => {});
        player.lastPosition = 0;
        player.lastPositionChange = Date.now();
        await this.safePlay(player);
      }

      if (isPlaylist) {
        return ctx.reply({
          embeds: [
            baseEmbed("📚 Playlist Ditambahkan ke Queue")
              .setDescription(
                playlistName
                  ? `**[${playlistName}](${searchQuery})**\nDitambahkan **${tracks.length} track** ke dalam antrean.`
                  : `Ditambahkan **${tracks.length} track** ke dalam antrean.`
              )
              .setFooter({ text: `Total antrean: ${(player.queue?.tracks?.length ?? 0)} track` }),
          ],
        });
      }

      const firstTrack = tracks[0];
      const title = trackTitle(firstTrack);
      const author = trackAuthor(firstTrack);
      const uri = trackUri(firstTrack);

      const desc = uri
        ? `**[${truncate(title, 80)}](${uri})**\n${author}${fallbackNote ? `\n\nℹ️ *${fallbackNote}*` : ""}`
        : `**${truncate(title, 80)}**\n${author}${fallbackNote ? `\n\nℹ️ *${fallbackNote}*` : ""}`;

      return ctx.reply({
        embeds: [
          baseEmbed("✅ Ditambahkan ke Queue")
            .setDescription(desc)
            .setFooter({ text: `Posisi di antrean: #${player.queue?.tracks?.length ?? 1}` }),
        ],
      });
    } catch (e: any) {
      const msg = e?.message || "Gagal memutar track.";
      if (/timeout|aborted/i.test(msg)) {
        return ctx.reply({
          content:
            "❌ **Koneksi Audio Timeout**: Server audio sedang padat atau lambat merespons.\n" +
            "💡 **Solusi:** Coba jalankan kembali `?play <lagu>` atau gunakan `?changenode` untuk beralih ke node lain.",
        });
      }
      return ctx.reply({ content: `❌ ${msg}` });
    }
  }

  async skip(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });
    if (!p.queue?.current) return ctx.reply({ content: "❌ Tidak ada track yang sedang diputar." });

    this.stopNowPlayingUpdater(ctx.guildId);
    const upcoming = p.queue?.tracks?.length ?? 0;
    const guildState = state(ctx.guildId);

    if (upcoming === 0 && !guildState.autoplay && p.repeatMode === "off") {
      await p.skip(0, false).catch(() => {});
      return ctx.reply({ content: "⏭️ Track di-skip. Queue kosong." });
    }

    await p.skip(0, false);
    return ctx.reply({ content: "⏭️ Track berhasil di-skip." });
  }

  async stop(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    this.stopNowPlayingUpdater(ctx.guildId);
    this.autoplayPool.delete(ctx.guildId);
    if (p.queue?.tracks?.length) {
      await p.queue.splice(0, p.queue.tracks.length).catch(() => {});
    }
    await p.destroy();
    return ctx.reply({ content: "⏹️ Pemutaran dihentikan, queue dibersihkan, dan ANTIMUSIC keluar." });
  }

  async pause(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });
    if (p.paused) return ctx.reply({ content: "⏸️ Player sudah dalam keadaan pause." });

    p.lastPosition = this.getPlayerPosition(p);
    p.lastPositionChange = null;
    await p.pause();
    await this.updateNowPlayingMessage(p);
    return ctx.reply({ content: "⏸️ Pemutaran di-pause." });
  }

  async resume(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });
    if (!p.paused) return ctx.reply({ content: "▶️ Player tidak sedang di-pause." });

    p.lastPositionChange = Date.now();
    await p.resume();
    await this.updateNowPlayingMessage(p);
    return ctx.reply({ content: "▶️ Pemutaran dilanjutkan." });
  }

  async volume(ctx: Ctx, v?: number | null) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });

    if (v == null || isNaN(v)) {
      return ctx.reply({ content: `🔊 Volume saat ini: **${p.volume}%** (Gunakan \`?volume <0-200>\` atau \`/volume level: <0-200>\` untuk mengubah)` });
    }

    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    const safeVol = Math.max(0, Math.min(200, Math.round(v)));
    await p.setVolume(safeVol);
    patchState(ctx.guildId, { volume: safeVol });
    await this.updateNowPlayingMessage(p);
    return ctx.reply({ content: `🔊 Volume disetel ke **${safeVol}%**` });
  }

  async shuffle(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    const upcoming = p.queue?.tracks?.length ?? 0;
    if (upcoming < 2) return ctx.reply({ content: "❌ Butuh minimal 2 lagu di dalam antrean untuk diacak." });

    await p.queue.shuffle();
    return ctx.reply({ content: `🔀 Berhasil mengacak **${upcoming}** lagu di antrean.` });
  }

  async clear(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    const count = p.queue?.tracks?.length ?? 0;
    if (count === 0) return ctx.reply({ content: "❌ Antrean lagu sudah kosong." });

    this.autoplayPool.delete(ctx.guildId);
    await p.queue.splice(0, count);
    await p.queue.utils?.save?.();
    return ctx.reply({ content: `🧹 Berhasil membersihkan **${count}** lagu dari antrean.` });
  }

  async autoplay(ctx: Ctx, enabled?: boolean | null) {
    const current = state(ctx.guildId).autoplay;
    const nextState = enabled == null ? !current : !!enabled;

    patchState(ctx.guildId, { autoplay: nextState });
    if (!nextState) {
      this.autoplayPool.delete(ctx.guildId);
    }

    const p = this.getPlayer(ctx.guildId);
    if (p) {
      await this.updateNowPlayingMessage(p);
      if (nextState && p.connected && !p.playing && !p.queue?.current && (p.queue?.tracks?.length ?? 0) === 0) {
        void this.smartAutoplay(p);
      }
    }

    return ctx.reply({ content: `♾️ Smart Autoplay: **${nextState ? "ON 🟢" : "OFF ⚪"}**` });
  }

  async loop(ctx: Ctx, mode?: "off" | "track" | "queue" | null) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    let nextMode: "off" | "track" | "queue" = "off";
    if (!mode) {
      const current = (p.repeatMode || state(ctx.guildId).loop) as "off" | "track" | "queue";
      if (current === "off") nextMode = "track";
      else if (current === "track") nextMode = "queue";
      else nextMode = "off";
    } else {
      nextMode = ["off", "track", "queue"].includes(mode) ? mode : "off";
    }

    await p.setRepeatMode(nextMode);
    patchState(ctx.guildId, { loop: nextMode });
    await this.updateNowPlayingMessage(p);

    const labels = { off: "OFF ⚪", track: "TRACK (Lagu Saat Ini) 🔂", queue: "QUEUE (Seluruh Antrean) 🔁" };
    return ctx.reply({ content: `🔁 Mode Loop disetel ke: **${labels[nextMode]}**` });
  }

  async seek(ctx: Ctx, input: string | number) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    const currentTrack = p.queue?.current;
    if (!currentTrack) return ctx.reply({ content: "❌ Tidak ada track yang sedang diputar." });

    if (currentTrack.info?.isStream || !currentTrack.info?.isSeekable) {
      return ctx.reply({ content: "❌ Track ini adalah live stream dan tidak dapat di-seek." });
    }

    const seconds = parseSeconds(input);
    if (seconds == null) {
      return ctx.reply({ content: "❌ Format waktu tidak valid. Gunakan detik atau mm:ss (contoh: `?seek 90` atau `?seek 1:30`)." });
    }

    const totalLen = trackLength(currentTrack);
    const targetMs = seconds * 1000;

    if (totalLen > 0 && targetMs >= totalLen) {
      return ctx.reply({ content: `❌ Posisi seek melebihi durasi lagu (${ms(totalLen)}).` });
    }

    await p.seek(targetMs);
    p.lastPosition = targetMs;
    p.lastPositionChange = Date.now();
    await this.updateNowPlayingMessage(p);

    return ctx.reply({ content: `⏩ Berhasil seek ke **${ms(targetMs)}**.` });
  }

  async remove(ctx: Ctx, pos: number) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    const tracks = p.queue?.tracks ?? [];
    if (!tracks.length) return ctx.reply({ content: "❌ Antrean lagu kosong." });

    if (!Number.isInteger(pos) || pos < 1 || pos > tracks.length) {
      return ctx.reply({ content: `❌ Posisi tidak valid. Masukkan angka antara 1 sampai ${tracks.length}.` });
    }

    const index = pos - 1;
    const removedTrack = tracks[index];

    await p.queue.splice(index, 1);
    await p.queue.utils?.save?.();

    return ctx.reply({ content: `🗑️ Berhasil menghapus lagu: **${truncate(trackTitle(removedTrack), 80)}**` });
  }

  async leave(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada player aktif." });
    if (!this.sameVoice(ctx, p)) return ctx.reply({ content: "❌ Kamu harus berada di voice channel yang sama dengan bot." });

    this.stopNowPlayingUpdater(ctx.guildId);
    this.autoplayPool.delete(ctx.guildId);
    await p.destroy();
    return ctx.reply({ content: "👋 ANTIMUSIC keluar dari voice channel." });
  }

  async ping(ctx: Ctx) {
    const wsPing = this.client.ws.ping;
    const p = this.getPlayer(ctx.guildId);
    const lavalinkPing = p?.ping?.lavalink ? `${p.ping.lavalink}ms` : "N/A";
    return ctx.reply({
      content: `🏓 **Pong!**\n• Discord Gateway: **${wsPing}ms**\n• Lavalink: **${lavalinkPing}**`,
    });
  }

  async queue(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) return ctx.reply({ content: "❌ Tidak ada antrean aktif." });

    const current = p.queue?.current;
    const tracks = p.queue?.tracks ?? [];

    if (!current && tracks.length === 0) {
      return ctx.reply({ content: "❌ Antrean kosong. Tambahkan lagu dengan `?play <lagu>` atau `/play query: <lagu>`." });
    }

    let desc = "";
    if (current) {
      const curLen = trackLength(current);
      desc += `**Sedang Diputar:**\n▶️ **[${truncate(trackTitle(current), 70)}](${trackUri(current)})** \`[${ms(curLen)}]\`\n\n`;
    }

    if (tracks.length > 0) {
      desc += "**Lagu Berikutnya:**\n";
      desc += tracks
        .slice(0, 15)
        .map((t: any, i: number) => `\`${i + 1}.\` [${truncate(trackTitle(t), 55)}](${trackUri(t)}) \`[${ms(trackLength(t))}]\``)
        .join("\n");

      if (tracks.length > 15) {
        desc += `\n\n*…dan ${tracks.length - 15} lagu lainnya.*`;
      }
    } else {
      desc += "*Tidak ada lagu berikutnya di antrean.*";
    }

    const totalDuration = tracks.reduce((acc: number, t: any) => acc + trackLength(t), trackLength(current));
    const guildState = state(ctx.guildId);

    const embed = baseEmbed(`📋 Antrean Musik (${tracks.length} Lagu Berikutnya)`)
      .setDescription(desc)
      .setFooter({
        text: `Total Durasi: ${ms(totalDuration)} • Loop: ${p.repeatMode?.toUpperCase() || "OFF"} • Autoplay: ${guildState.autoplay ? "ON" : "OFF"}`,
      });

    return ctx.reply({ embeds: [embed] });
  }

  async nowPlaying(ctx: Ctx) {
    const p = this.getPlayer(ctx.guildId);
    const t = p?.queue?.current;
    if (!p || !p.connected || !t) {
      return ctx.reply({ content: "❌ Tidak ada lagu yang sedang diputar saat ini." });
    }
    return ctx.reply({ embeds: [this.nowPlayingEmbed(t, p)], components: [this.controls(p)] });
  }

  async help(ctx: Ctx) {
    return ctx.reply({
      embeds: [
        baseEmbed("⚡ ANTIMUSIC • Panduan Perintah")
          .setDescription(
            "ANTIMUSIC adalah bot musik Discord modern bertenaga **Discord.js + Lavalink v4**.\n\n" +
            "**🎶 Pemutaran & Antrean:**\n" +
            "• `?play <link/judul>` / `/play` — Memutar lagu dari YouTube / YT Music atau pencarian\n" +
            "• `?skip` / `/skip` — Melewati lagu saat ini\n" +
            "• `?stop` / `/stop` — Menghentikan pemutaran & membersihkan antrean\n" +
            "• `?pause` / `/pause` — Menjeda lagu\n" +
            "• `?resume` / `/resume` — Melanjutkan pemutaran\n" +
            "• `?queue` / `/queue` — Menampilkan daftar antrean lagu\n" +
            "• `?np` / `/nowplaying` — Menampilkan detail lagu yang sedang diputar\n\n" +
            "**⚙️ Pengaturan & Kontrol:**\n" +
            "• `?volume [0-200]` / `/volume` — Melihat atau mengatur volume\n" +
            "• `?seek <detik/mm:ss>` / `/seek` — Melompat ke menit/detik tertentu\n" +
            "• `?shuffle` / `/shuffle` — Mengacak antrean lagu\n" +
            "• `?clear` / `/clear` — Menghapus semua lagu di antrean\n" +
            "• `?remove <nomor>` / `/remove` — Menghapus lagu tertentu dari antrean\n" +
            "• `?loop [off|track|queue]` / `/loop` — Mengatur mode perulangan\n" +
            "• `?autoplay [on|off]` / `/autoplay` — Menyalakan/mematikan pemutaran otomatis\n" +
            "• `?hd [studio|bass|vocal|off]` / `/ultrahd` — Pengaturan kualitas audio Ultra HD\n" +
            "• `?nodes` / `/nodes` — Menampilkan status cluster node Lavalink & auto-failover\n" +
            "• `?changenode <host/nomor>` / `/changenode` — Pindah ke host audio cadangan secara manual\n" +
            "• `?leave` / `/leave` — Memerintahkan bot keluar dari voice channel\n" +
            "• `?ping` / `/ping` — Menampilkan latensi bot"
          )
          .setFooter({ text: "Gunakan prefix ? atau Slash Commands (/)" }),
      ],
    });
  }

  async ultrahd(ctx: Ctx, profileInput?: string | null) {
    const raw = profileInput?.trim().toLowerCase();
    const guildState = state(ctx.guildId);
    const player = this.getPlayer(ctx.guildId);

    const voice = this.voiceChannel(ctx);
    let bitrateInfo = { previousBitrate: 64000, currentBitrate: 64000, maxBitrate: 96000, boosted: false, canManage: false };
    if (voice) {
      bitrateInfo = await optimizeVoiceChannelBitrate(voice);
    }

    if (raw) {
      let targetProfile: HDProfile | null = null;
      if (["ultrahd", "hd", "studio", "on", "enable", "master"].includes(raw)) {
        targetProfile = "ultrahd";
      } else if (["bass", "bassboost", "heavybass"].includes(raw)) {
        targetProfile = "bassboost";
      } else if (["vocal", "acoustic", "clarity", "clear"].includes(raw)) {
        targetProfile = "vocal";
      } else if (["off", "flat", "disable", "none", "normal"].includes(raw)) {
        targetProfile = "off";
      }

      if (!targetProfile) {
        return ctx.reply({
          content:
            "❌ Pilihan profil audio tidak valid.\n" +
            "Gunakan salah satu pilihan berikut:\n" +
            "• `?hd studio` — 💎 **Ultra HD Studio Master** (Rekomendasi)\n" +
            "• `?hd bass` — 🔊 **Ultra Bass Boost**\n" +
            "• `?hd vocal` — 🎤 **Vocal & Acoustic Clarity**\n" +
            "• `?hd off` — ⚪ **Standard Flat (Mati)**",
        });
      }

      const isUltraHdActive = targetProfile !== "off";
      patchState(ctx.guildId, { ultraHd: isUltraHdActive, hdProfile: targetProfile });

      if (player && player.connected) {
        await applyAudioQualityProfile(player, targetProfile);
      }

      const pInfo = PROFILE_INFO[targetProfile];
      const chBitrateKbps = Math.round((voice?.bitrate ?? bitrateInfo.currentBitrate) / 1000);
      const embed = baseEmbed(`${pInfo.emoji} Kualitas Audio: ${pInfo.label}`)
        .setDescription(
          `Pengaturan audio berhasil diperbarui untuk server ini!\n\n` +
          `• **Status Ultra HD:** ${isUltraHdActive ? "🟢 Aktif (Studio Fidelity)" : "⚪ Nonaktif (Standard Flat)"}\n` +
          `• **Deskripsi:** ${pInfo.description}\n` +
          `• **Voice Channel Bitrate:** \`${chBitrateKbps} kbps\` ${bitrateInfo.boosted ? "*(Otomatis dimaksimalkan!)*" : ""}\n` +
          `• **Format Output:** \`48,000 Hz Stereo Opus\``
        )
        .setFooter({ text: "Nikmati pengalaman mendengarkan musik dengan kualitas tertinggi di Discord!" });

      return ctx.reply({ embeds: [embed] });
    }

    const curProfile = guildState.hdProfile;
    const pInfo = PROFILE_INFO[curProfile];
    const chBitrateKbps = Math.round((voice?.bitrate ?? bitrateInfo.currentBitrate) / 1000);
    const maxBitrateKbps = Math.round((voice?.guild?.maximumBitrate ?? bitrateInfo.maxBitrate) / 1000);

    const embed = baseEmbed("💎 ANTIMUSIC • Ultra HD Audio Engine")
      .setDescription(
        "ANTIMUSIC dilengkapi dengan sistem pemrosesan audio **Studio Master Ultra HD** yang mengoptimalkan spektrum frekuensi untuk voice channel Discord.\n\n" +
        `**Status Audio Server Ini:**\n` +
        `• **Engine Ultra HD:** ${guildState.ultraHd ? "🟢 **AKTIF (Ultra High Fidelity)**" : "⚪ Nonaktif"}\n` +
        `• **Profil Equalizer:** ${pInfo.emoji} **${pInfo.label}**\n` +
        `• **Detail Profil:** *${pInfo.description}*\n` +
        `• **Voice Channel Bitrate:** \`${chBitrateKbps} kbps\` *(Batas Server: ${maxBitrateKbps} kbps)*\n` +
        `• **Format Output:** \`48,000 Hz Stereo Opus (High Bitrate Stream)\`\n\n` +
        `**Ganti Profil Audio:**\n` +
        `• \`?hd studio\` — 💎 **Ultra HD Studio Master** (Optimal untuk semua genre)\n` +
        `• \`?hd bass\` — 🔊 **Ultra Bass Boost** (Bass bertenaga untuk EDM/Phonk)\n` +
        `• \`?hd vocal\` — 🎤 **Vocal & Acoustic Clarity** (Akustik & vokal jernih)\n` +
        `• \`?hd off\` — ⚪ **Standard Flat** (Suara asli tanpa EQ)\n\n` +
        `💡 *Tips:* Berikan bot izin **Manage Channels** agar bot dapat otomatis menaikkan bitrate voice channel ke batas maksimal server Discord kamu (${maxBitrateKbps} kbps)!`
      )
      .setFooter({ text: "Gunakan ?hd <profil> atau /ultrahd" });

    return ctx.reply({ embeds: [embed] });
  }

  async nodes(ctx: Ctx) {
    const allNodes = Array.from(this.lavalink.nodeManager.nodes.values());
    const p = this.getPlayer(ctx.guildId);
    const currentPlayerNodeId = p?.node?.id || p?.node?.options?.id;

    if (!allNodes.length) {
      return ctx.reply({ content: "❌ Tidak ada node Lavalink yang terdaftar di konfigurasi." });
    }

    const connectedCount = allNodes.filter(n => n.connected).length;
    const descLines: string[] = [
      `Sistem cluster audio ANTIMUSIC dilengkapi **Multi-Node Failover Otomatis**.\n` +
      `Jika satu host mengalami kendala/disconnect, pemutaran musik akan **otomatis dialihkan ke host lain yang aktif** tanpa terputus.\n`,
      `**Status Cluster:** \`${connectedCount}/${allNodes.length} Host Terhubung\` • **Auto-Failover:** \`${config.autoFailover ? "AKTIF 🛡️" : "NONAKTIF"}\`\n`,
    ];

    allNodes.forEach((node, idx) => {
      const isCurrent = currentPlayerNodeId === node.id || currentPlayerNodeId === node.options?.id;
      const isHealthy = this.isNodeHealthy(node);
      const statusIcon = !node.connected ? "🔴" : (!isHealthy ? "🟡" : "🟢");
      const statusText = !node.connected
        ? "Disconnected / Reconnecting"
        : (!isHealthy ? "Connected (Slow / Cooldown)" : "Connected");
      const rawPing = (node as any).heartBeatPing ?? (node as any).ping?.lavalink;
      const ping = rawPing ? `${rawPing}ms` : (node.connected ? "Active" : "Offline");
      const players = node.stats?.players ?? 0;
      const playing = node.stats?.playingPlayers ?? 0;

      let memStr = "";
      if (node.stats?.memory?.used) {
        const usedMb = Math.round(node.stats.memory.used / 1024 / 1024);
        memStr = ` • RAM: ${usedMb}MB`;
      }

      descLines.push(
        `${statusIcon} **${idx + 1}. ${node.id}** ${isCurrent ? "*(Sedang Digunakan Server Ini 🎧)*" : ""}\n` +
        `• Host: \`${node.options.host}:${node.options.port}\` (${node.options.secure ? "SSL" : "No-SSL"})\n` +
        `• Status: **${statusText}** • Ping: \`${ping}\` • Load: \`${playing}/${players} playing\`${memStr}`
      );
    });

    descLines.push(
      `\n💡 *Tips:* Gunakan \`?changenode <nomor/nama>\` atau \`/changenode\` jika kamu ingin memindahkan server audio secara manual.`
    );

    const embed = baseEmbed("🌐 ANTIMUSIC • Lavalink Multi-Node Cluster")
      .setDescription(descLines.join("\n"))
      .setFooter({ text: "Sistem failover otomatis aktif 24/7" });

    return ctx.reply({ embeds: [embed] });
  }

  async changeNode(ctx: Ctx, targetInput: string) {
    const raw = targetInput?.trim();
    if (!raw) {
      return ctx.reply({
        content: "❌ Masukkan nama atau nomor host yang ingin dituju. Contoh: `?changenode 2` atau `?changenode Lavalink-Nazha`. Ketik `?nodes` untuk melihat daftar host."
      });
    }

    const p = this.getPlayer(ctx.guildId);
    if (!p || !p.connected) {
      return ctx.reply({ content: "❌ Bot belum terhubung ke voice channel di server ini." });
    }

    const allNodes = Array.from(this.lavalink.nodeManager.nodes.values());
    let targetNode: any = null;

    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      targetNode = allNodes[idx];
    } else {
      targetNode = allNodes.find(
        n => n.id.toLowerCase() === raw.toLowerCase() ||
             n.options.host.toLowerCase().includes(raw.toLowerCase())
      );
    }

    if (!targetNode) {
      return ctx.reply({
        content: `❌ Host \`${raw}\` tidak ditemukan. Ketik \`?nodes\` untuk melihat daftar host yang tersedia.`
      });
    }

    if (!targetNode.connected) {
      return ctx.reply({
        content: `❌ Host **${targetNode.id}** saat ini sedang offline / reconnecting. Pilih host lain yang bertanda 🟢 Connected.`
      });
    }

    if (p.node?.id === targetNode.id) {
      return ctx.reply({
        content: `ℹ️ Bot sudah terhubung ke host **${targetNode.id}** (\`${targetNode.options.host}\`).`
      });
    }

    this.nodeCooldowns.delete(targetNode.id);
    const prevNodeId = p.node?.id || "Unknown";
    await p.changeNode(targetNode, false);

    const s = state(ctx.guildId);
    if (s.ultraHd) {
      await applyAudioQualityProfile(p, s.hdProfile).catch(() => {});
    }

    return ctx.reply({
      embeds: [
        baseEmbed("🔄 Migrasi Host Audio Berhasil")
          .setDescription(
            `Server audio pemutaran musik berhasil dipindahkan!\n\n` +
            `• **Dari:** \`${prevNodeId}\`\n` +
            `• **Ke:** 🟢 **${targetNode.id}** (\`${targetNode.options.host}:${targetNode.options.port}\`)\n` +
            `• **Status Pemutaran:** Berjalan mulus tanpa henti!`
          )
      ]
    });
  }

  async smartAutoplay(player: any): Promise<boolean> {
    const guildId = player.guildId;
    if (this.autoplayBusy.has(guildId)) return false;
    this.autoplayBusy.add(guildId);

    try {
      const seed = this.lastTrack.get(guildId) || player.queue?.previous?.[0] || player.queue?.current;
      if (!seed) return false;

      const s = state(guildId);
      const seedTitle = trackTitle(seed);
      const seedAuthor = trackAuthor(seed);
      const cleanAuthor = (!seedAuthor || seedAuthor.toLowerCase() === "unknown")
        ? ""
        : seedAuthor.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();

      const seedId = seed?.info?.identifier || trackUri(seed);

      // 1. Cek apakah di autoplayPool guild ini masih ada sisa lagu rekomendasi yang valid
      let pool = this.autoplayPool.get(guildId) || [];
      pool = pool.filter((t: any) => {
        const id = t?.info?.identifier || trackUri(t);
        const title = trackTitle(t);
        if (!id || s.history.includes(id) || id === seedId) return false;
        if (this.isSameSong(title, seedTitle)) return false;
        return true;
      });

      // 2. Jika pool kosong atau habis, racik rekomendasi baru ala YouTube Music / Spotify Radio Mix
      if (!pool.length) {
        log.info({ guildId, seedTitle, cleanAuthor }, "Autoplay pool kosong. Mengambil racikan rekomendasi Radio Mix...");

        let videoId = this.extractYouTubeVideoId(seed);

        // Jika lagu awal bukan dari YouTube (misal Spotify), cari dulu video ID YouTube resminya
        if (!videoId) {
          const quickQuery = cleanAuthor ? `${cleanAuthor} ${seedTitle}` : seedTitle;
          const searchYt = await this.searchWithClusterFailover(player, quickQuery, false, this.client.user).catch(() => null);
          const topTrack = searchYt?.result?.tracks?.[0];
          if (topTrack) {
            videoId = this.extractYouTubeVideoId(topTrack);
          }
        }

        let mixTracks: any[] = [];

        // Tier 1: YouTube Radio Mix Playlist (list=RD${videoId}) — Algoritma resmi rekomendasi YouTube / YT Music
        if (videoId) {
          const radioMixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
          const mixRes = await this.searchWithClusterFailover(player, radioMixUrl, true, this.client.user).catch(() => null);
          if (mixRes?.result?.tracks?.length) {
            mixTracks = mixRes.result.tracks;
            log.info({ videoId, count: mixTracks.length }, "Berhasil memuat YouTube Radio Mix playlist");
          }
        }

        // Tier 2: YouTube Music Radio / Playlist Mix Search jika Tier 1 tidak ada hasil
        if (!mixTracks.length && cleanAuthor) {
          const queries = [
            `ytmsearch:${cleanAuthor} radio`,
            `ytsearch:${cleanAuthor} popular mix playlist`,
            `ytmsearch:${cleanAuthor}`,
          ];
          for (const q of queries) {
            const fallbackRes = await this.searchWithClusterFailover(player, q, false, this.client.user).catch(() => null);
            if (fallbackRes?.result?.tracks?.length) {
              mixTracks = fallbackRes.result.tracks;
              break;
            }
          }
        }

        // Saring lagu-lagu dari mix: buang lagu yang sudah pernah diputar, dan buang lagu dengan judul yang sama (cover/remix/variasi lagu saat ini)
        pool = mixTracks.filter((t: any) => {
          const id = t?.info?.identifier || trackUri(t);
          const title = trackTitle(t);
          if (!id || s.history.includes(id) || id === seedId) return false;
          if (this.isSameSong(title, seedTitle)) return false;
          return true;
        });
      }

      if (!pool.length) {
        log.warn({ guildId, seedTitle }, "Tidak ditemukan lagu rekomendasi autoplay yang cocok");
        return false;
      }

      // Ambil lagu pertama dari pool
      const next = pool.shift();
      // Simpan sisa rekomendasi ke pool guild agar lagu berikutnya langsung diambil tanpa delay
      this.autoplayPool.set(guildId, pool);

      if (!next) return false;

      await player.queue.add(next);
      player.lastPosition = 0;
      player.lastPositionChange = Date.now();
      await this.safePlay(player);

      const nextTitle = trackTitle(next);
      const nextUri = trackUri(next);
      const nextAuthor = trackAuthor(next);

      const ch: any = this.client.channels.cache.get(player.textChannelId);
      await ch?.send?.({
        embeds: [
          baseEmbed("♾️ Autoplay Radio Mix")
            .setDescription(`Melanjutkan pemutaran dengan lagu yang seirama:\n**[${truncate(nextTitle, 80)}](${nextUri})**\n${nextAuthor}`)
            .setFooter({ text: `Sisa antrean rekomendasi: ${pool.length} lagu seirama • ANTIMUSIC` })
        ]
      }).catch?.(() => {});

      return true;
    } catch (e) {
      log.warn({ e, guildId }, "Smart autoplay failed");
      return false;
    } finally {
      this.autoplayBusy.delete(guildId);
    }
  }

  async handleButton(interaction: any) {
    if (!interaction.inGuild()) return;

    const p = this.getPlayer(interaction.guildId);
    if (!p || !p.connected) {
      return interaction.reply({ content: "❌ Player sudah tidak aktif.", flags: MessageFlags.Ephemeral });
    }

    const member = interaction.member as GuildMember;
    const voice = member.voice?.channel;
    if (!voice || (p.voiceChannelId && p.voiceChannelId !== voice.id)) {
      return interaction.reply({
        content: "❌ Kamu harus berada di voice channel yang sama dengan bot untuk menggunakan tombol kontrol.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const ctx: Ctx = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      member,
      user: interaction.user,
      reply: async (payload: any) => {
        const data = typeof payload === "string" ? { content: payload } : payload;
        if (interaction.deferred || interaction.replied) return interaction.editReply(data);
        return interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
      },
    };

    switch (interaction.customId) {
      case "am_pause": {
        if (p.paused) {
          p.lastPositionChange = Date.now();
          await p.resume();
          await this.updateNowPlayingMessage(p);
          return ctx.reply("▶️ Pemutaran dilanjutkan (Resume).");
        } else {
          p.lastPosition = this.getPlayerPosition(p);
          p.lastPositionChange = null;
          await p.pause();
          await this.updateNowPlayingMessage(p);
          return ctx.reply("⏸️ Pemutaran dijeda (Pause).");
        }
      }
      case "am_skip":
        return this.skip(ctx);
      case "am_shuffle":
        return this.shuffle(ctx);
      case "am_stop":
        return this.stop(ctx);
      case "am_autoplay":
        return this.autoplay(ctx, !state(ctx.guildId).autoplay);
    }
  }

  public checkEmptyChannel(guildId: string) {
    const p = this.getPlayer(guildId);
    if (!p || !p.connected || !p.voiceChannelId) {
      this.cancelEmptyChannelTimer(guildId);
      return;
    }

    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(p.voiceChannelId);
    if (!channel?.isVoiceBased()) return;

    const humanMembers = channel.members.filter(m => !m.user.bot);
    if (humanMembers.size === 0) {
      if (!this.emptyTimers.has(guildId)) {
        log.info({ guildId }, "Voice channel is empty. Starting 30-second leave timer");
        const timer = setTimeout(async () => {
          this.emptyTimers.delete(guildId);
          const currentPlayer = this.getPlayer(guildId);
          if (currentPlayer && currentPlayer.connected) {
            this.stopNowPlayingUpdater(guildId);
            const ch: any = this.client.channels.cache.get(currentPlayer.textChannelId);
            await ch?.send?.("👋 Semua member telah meninggalkan voice channel. ANTIMUSIC keluar.").catch?.(() => {});
            await currentPlayer.destroy().catch(() => {});
          }
        }, 30_000);
        this.emptyTimers.set(guildId, timer);
      }
    } else {
      this.cancelEmptyChannelTimer(guildId);
    }
  }

  public cancelEmptyChannelTimer(guildId: string) {
    const t = this.emptyTimers.get(guildId);
    if (t) {
      clearTimeout(t);
      this.emptyTimers.delete(guildId);
      log.info({ guildId }, "Voice channel has active listeners. Cancelled leave timer");
    }
  }
}
