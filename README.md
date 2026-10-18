# ANTIMUSIC

Production-oriented Discord music bot built with **Discord.js + Lavalink v4**. Fokus utama: YouTube / YouTube Music, per-guild queue, smart autoplay, hybrid prefix + slash commands, button controls, Docker deployment, health endpoint, graceful shutdown, and persistent per-guild preferences.

## Core behavior requested

- User masuk voice channel lalu `?play <YouTube / YouTube Music URL>` → bot auto join + play.
- `?play` berikutnya → masuk queue.
- `?stop` → stop, clear, bot keluar voice channel.
- `?skip` → next track. Kalau tidak ada next track dan autoplay OFF → bot keluar.
- Queue selesai → bot keluar otomatis. Jika Smart Autoplay ON, ANTIMUSIC mencari kandidat lanjutan dari YouTube Music dan menghindari history terbaru.

## Commands

Prefix default `?`, semua command utama juga tersedia sebagai slash command.

```text
?play <url/query>    ?skip             ?stop
?pause               ?resume           ?queue / ?q
?nowplaying / ?np    ?volume <0-200>   ?shuffle
?clear               ?remove <n>       ?seek <seconds>
?autoplay on|off     ?loop off|track|queue
?leave               ?ping             ?help
```

## Deploy paling gampang: Docker Compose

1. Buat bot di Discord Developer Portal.
2. Aktifkan **Message Content Intent** jika ingin command prefix `?`. Slash commands sendiri tidak membutuhkannya.
3. Invite bot dengan scopes `bot applications.commands`; izin minimal: View Channel, Send Messages, Embed Links, Connect, Speak.
4. Copy env:

```bash
cp .env.example .env
```

5. Isi minimal:

```env
DISCORD_TOKEN=TOKEN_BOT
CLIENT_ID=APPLICATION_ID_BOT
# GUILD_ID=SERVER_ID_TESTING  # optional, slash command lebih cepat muncul saat development
```

6. Jalankan:

```bash
docker compose up -d --build
```

7. Logs:

```bash
docker compose logs -f bot lavalink
```

Health check bot: `http://HOST:3000/health`.

> **Penting:** password Lavalink di `.env` dan `lavalink/application.yml` harus sama. Template ini memakai `antimusic-super-secret`; ganti keduanya sebelum expose Lavalink ke network publik.

## Deploy tanpa Docker

Butuh Node.js 22+, plus Lavalink v4 server sendiri. Setelah Lavalink aktif:

```bash
npm install
npm run build
npm start
```

Atur `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_PASSWORD`, `LAVALINK_SECURE` di `.env`.

## Arsitektur

```text
Discord User
   │ prefix/slash/buttons
   ▼
ANTIMUSIC (Discord.js)
   ├─ command router
   ├─ per-guild state / queue control
   ├─ smart autoplay + history avoidance
   ├─ UI embeds/buttons
   └─ health + graceful shutdown
          │ REST/WebSocket
          ▼
      Lavalink v4
          │
          ├─ youtube-source plugin
          └─ Discord Voice
```

`lavalink/application.yml` disables Lavalink's deprecated built-in YouTube source and uses the maintained `youtube-source` plugin instead.

## Project structure

```text
src/config.ts          env validation
src/logger.ts          structured logging
src/state.ts           persistent guild settings/history
src/utils.ts           formatting helpers
src/commands.ts        slash command schema
src/music.ts           players, queue, autoplay, button controls
src/index.ts           Discord events, prefix/slash routing, health server
lavalink/application.yml
Dockerfile
docker-compose.yml
```

## Smart autoplay

When queue ends and autoplay is enabled, ANTIMUSIC uses the last track as a seed, searches YouTube Music for related candidates, rejects recently-played IDs from local history, queues the best candidate, then continues playback. This is deliberately deterministic and API-key-free; it is not claimed to reproduce YouTube's private recommendation algorithm.

## Production notes

- Keep Lavalink internal to Docker/private network unless you know why you need it public.
- For large multi-instance/sharded deployments, replace local `data/state.json` with Redis/Postgres and use an external queue store.
- Global slash command propagation can take longer than guild-scoped testing commands.
- YouTube extraction changes over time. Keep Lavalink and `youtube-source` current.
- Respect source platform terms, copyright rules, and Discord policies for your deployment.

## Credits / reference patterns

ANTIMUSIC is an original implementation, not a copy of another repo. Design ideas were informed by public projects/docs including LavaMusic, EvoBot, Lavalink, `lavalink-client`, several self-hosted Discord music bots, and the official YouTube source plugin. See the accompanying ChatGPT response for source links/citations.
