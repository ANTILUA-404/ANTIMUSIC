import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

type GuildState = { autoplay: boolean; loop: "off" | "track" | "queue"; volume: number; history: string[] };
type DB = { guilds: Record<string, GuildState> };
const file = path.resolve("data/state.json");
let db: DB = { guilds: {} };
try {
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.guilds && typeof parsed.guilds === "object") {
        db = parsed;
      }
    }
  }
} catch (e) {
  log.warn({ e }, "Failed to load state.json; initializing empty state");
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log.error({ e }, "Failed to save state.json");
  }
}

export function state(guildId: string): GuildState {
  if (!db.guilds) db.guilds = {};
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      autoplay: config.autoplayDefault,
      loop: "off",
      volume: config.defaultVolume,
      history: [],
    };
  }
  const s = db.guilds[guildId];
  if (!Array.isArray(s.history)) s.history = [];
  if (!["off", "track", "queue"].includes(s.loop)) s.loop = "off";
  if (typeof s.volume !== "number" || isNaN(s.volume)) s.volume = config.defaultVolume;
  return s;
}

export function patchState(guildId: string, patch: Partial<GuildState>) {
  db.guilds[guildId] = { ...state(guildId), ...patch };
  save();
  return db.guilds[guildId];
}

export function remember(guildId: string, id: string) {
  if (!id) return;
  const s = state(guildId);
  s.history = [id, ...s.history.filter(x => x !== id)].slice(0, 50);
  save();
}

