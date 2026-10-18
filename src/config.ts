import "dotenv/config";

const req = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};
const bool = (v: string | undefined, fallback = false) => v == null ? fallback : /^(1|true|yes|on)$/i.test(v);
const num = (v: string | undefined, fallback: number) => Number.isFinite(Number(v)) ? Number(v) : fallback;

const rawHost = process.env.LAVALINK_HOST?.trim() || "lavalink";
const isHttps = /^https:\/\//i.test(rawHost) || num(process.env.LAVALINK_PORT, 2333) === 443;
const cleanHost = rawHost.replace(/^https?:\/\//i, "").replace(/\/+$/, "").replace(/:\d+$/, "");

export const config = {
  token: req("DISCORD_TOKEN"),
  clientId: req("CLIENT_ID"),
  guildId: process.env.GUILD_ID?.trim() || undefined,
  prefix: process.env.PREFIX?.trim() || "?",
  defaultVolume: Math.max(0, Math.min(200, num(process.env.DEFAULT_VOLUME, 70))),
  maxQueueSize: Math.max(1, num(process.env.MAX_QUEUE_SIZE, 500)),
  idleDestroyMs: Math.max(0, num(process.env.IDLE_DESTROY_MS, 15000)),
  autoplayDefault: bool(process.env.AUTOPLAY_DEFAULT, false),
  healthPort: Math.max(1, num(process.env.HEALTH_PORT, 3000)),
  lavalink: {
    host: cleanHost,
    port: num(process.env.LAVALINK_PORT, isHttps ? 443 : 2333),
    authorization: (process.env.LAVALINK_PASSWORD?.trim() || "antimusic-super-secret").replace(/^["']|["']$/g, ""),
    secure: bool(process.env.LAVALINK_SECURE, isHttps),
  },
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
};

