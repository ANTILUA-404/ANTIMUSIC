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

export type LavalinkNodeConfig = {
  id: string;
  host: string;
  port: number;
  authorization: string;
  secure: boolean;
  retryAmount?: number;
  retryDelay?: number;
  requestSignalTimeoutMS?: number;
};

const primaryNode: LavalinkNodeConfig = {
  id: "Lavalink-Primary",
  host: cleanHost,
  port: num(process.env.LAVALINK_PORT, isHttps ? 443 : 2333),
  authorization: (process.env.LAVALINK_PASSWORD?.trim() || "antimusic-super-secret").replace(/^["']|["']$/g, ""),
  secure: bool(process.env.LAVALINK_SECURE, isHttps),
  retryAmount: 1000,
  retryDelay: 5000,
  requestSignalTimeoutMS: 7500,
};

const builtInFallbacks: LavalinkNodeConfig[] = [
  {
    id: "Lavalink-Nazha",
    host: "lavalink.nazha.online",
    port: 443,
    authorization: "nazhafreelava",
    secure: true,
    retryAmount: 1000,
    retryDelay: 5000,
    requestSignalTimeoutMS: 7500,
  },
  {
    id: "Lavalink-Jirayu",
    host: "lavalink.jirayu.net",
    port: 443,
    authorization: "youshallnotpass",
    secure: true,
    retryAmount: 1000,
    retryDelay: 5000,
    requestSignalTimeoutMS: 7500,
  },
  {
    id: "Lavalink-Backup-Serenetia",
    host: "lavalinkv4.serenetia.com",
    port: 443,
    authorization: "https://seretia.link/discord",
    secure: true,
    retryAmount: 1000,
    retryDelay: 5000,
    requestSignalTimeoutMS: 7500,
  },
];

function parseCustomNodes(raw?: string): LavalinkNodeConfig[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => ({
        id: item.id || `Lavalink-Custom-${idx + 1}`,
        host: String(item.host).replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
        port: num(item.port, 443),
        authorization: String(item.authorization || item.password || ""),
        secure: bool(item.secure, true),
        retryAmount: 1000,
        retryDelay: 5000,
        requestSignalTimeoutMS: 7500,
      }));
    }
  } catch {}
  return [];
}

const customFallbacks = parseCustomNodes(process.env.LAVALINK_FALLBACKS || process.env.LAVALINK_NODES);
const enableFallbacks = bool(process.env.LAVALINK_ENABLE_FALLBACKS, true);

const allNodes: LavalinkNodeConfig[] = [primaryNode];
if (enableFallbacks) {
  for (const node of [...customFallbacks, ...builtInFallbacks]) {
    const isDuplicate = allNodes.some(
      n => n.host.toLowerCase() === node.host.toLowerCase() && n.port === node.port
    );
    if (!isDuplicate) {
      allNodes.push(node);
    }
  }
}

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
  lavalink: primaryNode,
  lavalinkNodes: allNodes,
  autoFailover: bool(process.env.LAVALINK_AUTO_FAILOVER, true),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
};

