import { EmbedBuilder } from "discord.js";

export function ms(ms = 0) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function parseSeconds(input: string | number | undefined | null): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : null;
  const str = String(input).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);
  const parts = str.split(":").map(Number);
  if (parts.some(p => isNaN(p) || p < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}


export function truncate(s = "", n = 80) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

export function normalizeQuery(q: string) {
  const trimmed = q.trim();
  if (/^(www\.|youtube\.com|youtu\.be|music\.youtube\.com)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function isUrl(s: string) {
  try {
    const url = new URL(normalizeQuery(s));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function trackTitle(track: any) { return track?.info?.title || track?.title || "Unknown track"; }
export function trackUri(track: any) { return track?.info?.uri || track?.uri || null; }
export function trackAuthor(track: any) { return track?.info?.author || track?.author || "Unknown"; }
export function trackLength(track: any) { return track?.info?.duration ?? track?.info?.length ?? track?.duration ?? 0; }
export function trackArtwork(track: any): string | null {
  if (track?.info?.artworkUrl) return track.info.artworkUrl;
  const id = track?.info?.identifier;
  if (id && (track?.info?.sourceName === "youtube" || track?.info?.uri?.includes("youtu"))) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  return null;
}

export function requesterName(track: any, botId?: string) {
  const r = track?.requester;
  if (botId && r?.id === botId) return "Autoplay ♾️";
  return r?.globalName || r?.username || r?.tag || "Unknown";
}

export function baseEmbed(title: string) {
  return new EmbedBuilder().setColor(0x7c3aed).setTitle(title).setTimestamp();
}

