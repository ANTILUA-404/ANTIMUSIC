import { SlashCommandBuilder } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder().setName("play").setDescription("Play / queue YouTube, YouTube Music, playlist, URL, or search")
    .addStringOption(o => o.setName("query").setDescription("Link or search query").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop, clear queue, and leave voice channel"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("queue").setDescription("Show queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show current track"),
  new SlashCommandBuilder().setName("volume").setDescription("Check or set volume (0-200)")
    .addIntegerOption(o => o.setName("level").setDescription("Volume level 0-200").setMinValue(0).setMaxValue(200).setRequired(false)),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle upcoming queue"),
  new SlashCommandBuilder().setName("clear").setDescription("Clear upcoming queue"),
  new SlashCommandBuilder().setName("autoplay").setDescription("Toggle or set smart autoplay")
    .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable autoplay").setRequired(false)),
  new SlashCommandBuilder().setName("loop").setDescription("Set or check loop mode")
    .addStringOption(o => o.setName("mode").setDescription("Loop mode").setRequired(false).addChoices(
      { name: "Off", value: "off" },
      { name: "Track", value: "track" },
      { name: "Queue", value: "queue" }
    )),
  new SlashCommandBuilder().setName("remove").setDescription("Remove queue item")
    .addIntegerOption(o => o.setName("position").setDescription("Queue position (1-based)").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName("seek").setDescription("Seek to seconds or mm:ss (e.g. 90 or 1:30)")
    .addStringOption(o => o.setName("time").setDescription("Time in seconds or mm:ss (e.g. 90 or 1:30)").setRequired(true)),
  new SlashCommandBuilder().setName("leave").setDescription("Leave voice channel"),
  new SlashCommandBuilder().setName("ultrahd").setDescription("Audio Engine Ultra HD Studio (Status & EQ Profiles)")
    .addStringOption(o => o.setName("profile").setDescription("Pilih profil audio").setRequired(false).addChoices(
      { name: "💎 Ultra HD Studio Master (Default)", value: "ultrahd" },
      { name: "🔊 Ultra Bass Boost", value: "bassboost" },
      { name: "🎤 Vocal & Acoustic Clarity", value: "vocal" },
      { name: "⚪ Standard Flat (Off)", value: "off" }
    )),
  new SlashCommandBuilder().setName("nodes").setDescription("Tampilkan status cluster node Lavalink & auto-failover"),
  new SlashCommandBuilder().setName("changenode").setDescription("Pindahkan pemutaran musik ke host/node Lavalink lain")
    .addStringOption(o => o.setName("target").setDescription("Nomor atau nama host/node").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show ANTIMUSIC commands"),
  new SlashCommandBuilder().setName("ping").setDescription("Show bot latency")
].map(x => x.toJSON());

