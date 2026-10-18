import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  GuildMember, Message, MessageFlags, PermissionFlagsBits, TextBasedChannel
} from "discord.js";
import { LavalinkManager } from "lavalink-client";
import { config } from "./config.js";
import { log } from "./logger.js";
import { patchState, remember, state } from "./state.js";
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

export class MusicService {
  public lavalink: LavalinkManager;
  private lastTrack = new Map<string, any>();
  private autoplayBusy = new Set<string>();
  private emptyTimers = new Map<string, NodeJS.Timeout>();
  private npMessages = new Map<string, Message>();

  constructor(private client: Client) {
    this.lavalink = new LavalinkManager({
      nodes: [
        {
          id: "ANTIMUSIC-MAIN",
          host: config.lavalink.host,
          port: config.lavalink.port,
          authorization: config.lavalink.authorization,
          secure: config.lavalink.secure,
          retryAmount: 30,
          retryDelay: 3000,
          requestSignalTimeoutMS: 15000,
        },
      ],
      sendToShard: (guildId: string, payload: any) => {
        const guild = this.client.guilds.cache.get(guildId);
        (guild?.shard ?? this.client.ws.shards.first())?.send(payload);
      },
      autoSkip: true,
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
      node.updateSession?.(true, 300_000).catch?.(() => {});
    });

    this.lavalink.nodeManager.on("error", (node: any, error: any) => {
      log.error({ node: node.id, error: error?.message || error }, "Lavalink node error");
    });

    this.lavalink.nodeManager.on("disconnect", (node: any, reason: any) => {
      log.warn({ node: node.id, reason }, "Lavalink disconnected");
    });

    this.lavalink.on("trackStart", async (player: any, track: any) => {
      this.stopNowPlayingUpdater(player.guildId);
      player.lastPosition = 0;
      player.lastPositionChange = Date.now();

      this.cancelEmptyChannelTimer(player.guildId);
      this.lastTrack.set(player.guildId, track);
      remember(player.guildId, track?.info?.identifier || trackUri(track) || trackTitle(track));

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
      );

    const art = trackArtwork(track);
    if (art) e.setThumbnail(art);

    return e;
  }

  private voiceChannel(ctx: Ctx) {
    return ctx.member.voice?.channel;
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
    const activeNodes = allNodes.filter(n => n.connected);
    if (!activeNodes.length) {
      const anyNode = allNodes[0];
      throw new Error(
        `Server audio (Lavalink) belum terhubung atau sedang offline.\n` +
        `• Host: \`${config.lavalink.host}:${config.lavalink.port}\`\n` +
        `• Status: ${anyNode ? (anyNode.connected ? "Connected" : "Disconnected / Reconnecting") : "Tidak ada node"}\n` +
        `Pastikan server Lavalink aktif dan kredensial di .env sudah benar.`
      );
    }

    const targetNode = this.lavalink.nodeManager.leastUsedNodes()[0] || activeNodes[0];

    let player = this.getPlayer(ctx.guildId);

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

    return player;
  }

  private sameVoice(ctx: Ctx, player: any) {
    const v = this.voiceChannel(ctx);
    if (!v) return false;
    if (!player?.connected) return true;
    return !player.voiceChannelId || player.voiceChannelId === v.id;
  }

  async play(ctx: Ctx, query: string) {
    if (!query?.trim()) {
      return ctx.reply({ content: "❌ Masukkan link atau kata kunci lagu. Contoh: `?play Bohemian Rhapsody` atau `/play query: <link>`." });
    }

    try {
      const player = await this.ensurePlayer(ctx);
      const currentQueueSize = player.queue?.tracks?.length ?? 0;
      if (currentQueueSize >= config.maxQueueSize) {
        throw new Error(`Queue sudah mencapai batas maksimal ${config.maxQueueSize} track.`);
      }

      const searchQuery = normalizeQuery(query);
      const isDirectUrl = isUrl(searchQuery);

      let result: any = null;
      try {
        result = await player.search(
          { query: searchQuery, source: isDirectUrl ? undefined : "ytmsearch" },
          ctx.user
        );
      } catch (err: any) {
        result = { loadType: "error", exception: { message: err?.message || String(err) } };
      }

      const isYoutubeBlocked = result?.loadType === "error" && (
        /login|all clients failed|sign in/i.test(result.exception?.message || "")
      );

      // Jika pencarian YouTube diblokir IP/login atau tidak ditemukan, otomatis fallback ke SoundCloud (scsearch)
      if ((!result || result.loadType === "empty" || isYoutubeBlocked) && !isDirectUrl) {
        log.warn({ query: searchQuery }, "YouTube terblokir / requires login. Mencoba fallback ke SoundCloud (scsearch)...");
        try {
          const scResult: any = await player.search(
            { query: searchQuery, source: "scsearch" },
            ctx.user
          );
          if (scResult && scResult.loadType !== "error" && scResult.tracks?.length) {
            result = scResult;
          }
        } catch {}
      }

      if (result?.loadType === "error") {
        const errMsg = result.exception?.message || "Gagal memuat lagu dari sumber audio.";
        if (/login|all clients failed|sign in/i.test(errMsg)) {
          throw new Error(
            `Server Lavalink terkena blokir IP YouTube (This video requires login).\n` +
            `💡 **Solusi:** Aktifkan YouTube OAuth di Lavalink, atau coba ketik: \`?play sc:${searchQuery}\` untuk memutar lewat SoundCloud.`
          );
        }
        throw new Error(errMsg);
      }

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
        await player.play();
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

      return ctx.reply({
        embeds: [
          baseEmbed("✅ Ditambahkan ke Queue")
            .setDescription(uri ? `**[${truncate(title, 80)}](${uri})**\n${author}` : `**${truncate(title, 80)}**\n${author}`)
            .setFooter({ text: `Posisi di antrean: #${player.queue?.tracks?.length ?? 1}` }),
        ],
      });
    } catch (e: any) {
      return ctx.reply({ content: `❌ ${e.message || "Gagal memutar track."}` });
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

    await p.queue.splice(0, count);
    await p.queue.utils?.save?.();
    return ctx.reply({ content: `🧹 Berhasil membersihkan **${count}** lagu dari antrean.` });
  }

  async autoplay(ctx: Ctx, enabled?: boolean | null) {
    const current = state(ctx.guildId).autoplay;
    const nextState = enabled == null ? !current : !!enabled;

    patchState(ctx.guildId, { autoplay: nextState });

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
            "• `?leave` / `/leave` — Memerintahkan bot keluar dari voice channel\n" +
            "• `?ping` / `/ping` — Menampilkan latensi bot"
          )
          .setFooter({ text: "Gunakan prefix ? atau Slash Commands (/)" }),
      ],
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
      const author = trackAuthor(seed);
      const cleanAuthor = (!author || author.toLowerCase() === "unknown")
        ? ""
        : author.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();

      const cleanTitle = trackTitle(seed)
        .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
        .replace(/(official\s*(music)?\s*video|official\s*audio|lyrics?|full\s*album)/gi, "")
        .trim();

      const query = cleanAuthor ? `${cleanAuthor} ${cleanTitle}` : cleanTitle;
      if (!query) return false;

      let result: any = await player.search(
        { query, source: "ytmsearch" },
        this.client.user
      ).catch(() => null);

      if (!result?.tracks?.length || result?.loadType === "error") {
        result = await player.search(
          { query, source: "scsearch" },
          this.client.user
        ).catch(() => null);
      }

      const seedId = seed?.info?.identifier;
      const candidates = (result?.tracks || []).filter((t: any) => {
        const id = t?.info?.identifier || trackUri(t) || trackTitle(t);
        return id && !s.history.includes(id) && id !== seedId;
      });

      const next = candidates[0] || result?.tracks?.find((t: any) => (t?.info?.identifier || trackTitle(t)) !== seedId);
      if (!next) return false;

      await player.queue.add(next);
      player.lastPosition = 0;
      player.lastPositionChange = Date.now();
      await player.play();

      const ch: any = this.client.channels.cache.get(player.textChannelId);
      await ch?.send?.(`♾️ **Smart Autoplay:** Memutar rekomendasi lagu berikutnya: **[${truncate(trackTitle(next), 80)}](${trackUri(next)})**`).catch?.(() => {});

      return true;
    } catch (e) {
      log.warn({ e, guildId }, "Smart autoplay search failed");
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
