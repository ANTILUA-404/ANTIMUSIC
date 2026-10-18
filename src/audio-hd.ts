import { PermissionFlagsBits } from "discord.js";
import { log } from "./logger.js";
import { HDProfile } from "./state.js";

export type EQBand = { band: number; gain: number };

/**
 * 15-Band Studio Master Equalizer Curves for Discord Opus 48kHz:
 * Band 0: 25 Hz   (Sub-bass rumble)
 * Band 1: 40 Hz   (Sub-bass body)
 * Band 2: 63 Hz   (Punchy bass)
 * Band 3: 100 Hz  (Upper bass)
 * Band 4: 160 Hz  (Low-mids transition)
 * Band 5: 250 Hz  (Boxiness filter)
 * Band 6: 400 Hz  (Mid body)
 * Band 7: 630 Hz  (Mids)
 * Band 8: 1.0 kHz (Vocal presence)
 * Band 9: 1.6 kHz (Vocal articulation)
 * Band 10: 2.5 kHz (Transient crispness)
 * Band 11: 4.0 kHz (Acoustic presence)
 * Band 12: 6.3 kHz (Hi-hat/cymbals brilliance)
 * Band 13: 10.0 kHz (Air & shimmer)
 * Band 14: 16.0 kHz (Studio high-frequency sheen)
 */
export const EQ_PROFILES: Record<HDProfile, EQBand[]> = {
  ultrahd: [
    { band: 0, gain: 0.15 },
    { band: 1, gain: 0.12 },
    { band: 2, gain: 0.07 },
    { band: 3, gain: 0.02 },
    { band: 4, gain: -0.02 },
    { band: 5, gain: -0.02 },
    { band: 6, gain: 0.00 },
    { band: 7, gain: 0.00 },
    { band: 8, gain: 0.03 },
    { band: 9, gain: 0.05 },
    { band: 10, gain: 0.08 },
    { band: 11, gain: 0.10 },
    { band: 12, gain: 0.13 },
    { band: 13, gain: 0.16 },
    { band: 14, gain: 0.20 },
  ],
  bassboost: [
    { band: 0, gain: 0.25 },
    { band: 1, gain: 0.22 },
    { band: 2, gain: 0.16 },
    { band: 3, gain: 0.08 },
    { band: 4, gain: 0.02 },
    { band: 5, gain: -0.02 },
    { band: 6, gain: -0.04 },
    { band: 7, gain: 0.00 },
    { band: 8, gain: 0.02 },
    { band: 9, gain: 0.04 },
    { band: 10, gain: 0.06 },
    { band: 11, gain: 0.08 },
    { band: 12, gain: 0.10 },
    { band: 13, gain: 0.12 },
    { band: 14, gain: 0.14 },
  ],
  vocal: [
    { band: 0, gain: -0.05 },
    { band: 1, gain: -0.05 },
    { band: 2, gain: 0.00 },
    { band: 3, gain: 0.02 },
    { band: 4, gain: 0.00 },
    { band: 5, gain: 0.02 },
    { band: 6, gain: 0.05 },
    { band: 7, gain: 0.08 },
    { band: 8, gain: 0.12 },
    { band: 9, gain: 0.14 },
    { band: 10, gain: 0.12 },
    { band: 11, gain: 0.10 },
    { band: 12, gain: 0.08 },
    { band: 13, gain: 0.05 },
    { band: 14, gain: 0.02 },
  ],
  off: [
    { band: 0, gain: 0 },
    { band: 1, gain: 0 },
    { band: 2, gain: 0 },
    { band: 3, gain: 0 },
    { band: 4, gain: 0 },
    { band: 5, gain: 0 },
    { band: 6, gain: 0 },
    { band: 7, gain: 0 },
    { band: 8, gain: 0 },
    { band: 9, gain: 0 },
    { band: 10, gain: 0 },
    { band: 11, gain: 0 },
    { band: 12, gain: 0 },
    { band: 13, gain: 0 },
    { band: 14, gain: 0 },
  ],
};

export const PROFILE_INFO: Record<HDProfile, { label: string; description: string; emoji: string }> = {
  ultrahd: {
    label: "Ultra HD Studio Master",
    description: "Keseimbangan sempurna: bass hangat & bertenaga, vokal jernih, dan treble berkilau kristal.",
    emoji: "💎",
  },
  bassboost: {
    label: "Ultra Bass Boost",
    description: "Sub-bass & mid-bass bertenaga ekstra untuk lagu EDM, Phonk, Trap, & Hip-Hop.",
    emoji: "🔊",
  },
  vocal: {
    label: "Vocal & Acoustic Clarity",
    description: "Fokus pada kejelasan vokal dan detail instrumen akustik tanpa dengung frekuensi rendah.",
    emoji: "🎤",
  },
  off: {
    label: "Standard Flat (Off)",
    description: "Audio original tanpa pemrosesan equalizer studio.",
    emoji: "⚪",
  },
};

/**
 * Menerapkan profil audio HD ke Lavalink player
 */
export async function applyAudioQualityProfile(player: any, profile: HDProfile): Promise<boolean> {
  if (!player?.filterManager) return false;

  try {
    if (profile === "off") {
      await player.filterManager.clearEQ().catch(() => {});
    } else {
      const bands = EQ_PROFILES[profile] ?? EQ_PROFILES.ultrahd;
      await player.filterManager.setEQ(bands).catch(() => {});
    }
    log.debug({ guildId: player.guildId, profile }, "Audio HD profile applied");
    return true;
  } catch (err: any) {
    log.warn({ guildId: player.guildId, error: err?.message || err }, "Failed to apply Audio HD profile");
    return false;
  }
}

/**
 * Secara otomatis meningkatkan bitrate Voice Channel Discord ke batas tertinggi server (hingga 384 kbps)
 */
export async function optimizeVoiceChannelBitrate(voiceChannel: any): Promise<{
  previousBitrate: number;
  currentBitrate: number;
  maxBitrate: number;
  boosted: boolean;
  canManage: boolean;
}> {
  try {
    if (!voiceChannel || !voiceChannel.guild) {
      return { previousBitrate: 0, currentBitrate: 0, maxBitrate: 0, boosted: false, canManage: false };
    }

    const currentBitrate = voiceChannel.bitrate ?? 64000;
    const maxBitrate = voiceChannel.guild.maximumBitrate ?? 96000;
    const botMember = voiceChannel.guild.members.me;
    const canManage = Boolean(botMember && voiceChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels));

    if (currentBitrate < maxBitrate && canManage) {
      await voiceChannel.setBitrate(maxBitrate, "ANTIMUSIC Ultra HD Studio Engine • Auto Bitrate Maximizer").catch(() => {});
      return { previousBitrate: currentBitrate, currentBitrate: maxBitrate, maxBitrate, boosted: true, canManage: true };
    }

    return { previousBitrate: currentBitrate, currentBitrate, maxBitrate, boosted: false, canManage };
  } catch (err: any) {
    log.warn({ channelId: voiceChannel?.id, error: err?.message || err }, "Error optimizing voice bitrate");
    return {
      previousBitrate: voiceChannel?.bitrate ?? 0,
      currentBitrate: voiceChannel?.bitrate ?? 0,
      maxBitrate: voiceChannel?.guild?.maximumBitrate ?? 96000,
      boosted: false,
      canManage: false,
    };
  }
}
