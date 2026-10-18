import net from "node:net";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

let lavalinkProc: ChildProcess | null = null;

function isPortOpen(port: number, host: string, timeout = 1200): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host === "localhost" ? "127.0.0.1" : host);
  });
}

export async function ensureLavalinkRunning(): Promise<void> {
  const host = config.lavalink.host;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  if (!isLocal) return;

  const port = config.lavalink.port;
  const alreadyUp = await isPortOpen(port, host);
  if (alreadyUp) {
    log.info({ host, port }, "Server Lavalink lokal sudah aktif.");
    return;
  }

  const lavalinkDir = path.resolve(process.cwd(), "lavalink");
  const jarPath = path.join(lavalinkDir, "Lavalink.jar");
  if (!fs.existsSync(jarPath)) {
    log.warn({ jarPath }, "Lavalink.jar tidak ditemukan di folder lavalink.");
    return;
  }

  const localJava = path.join(lavalinkDir, "jre", "bin", "java.exe");
  const javaBin = fs.existsSync(localJava) ? localJava : "java";

  log.info("Menjalankan server Lavalink lokal secara otomatis di latar belakang...");

  try {
    lavalinkProc = spawn(javaBin, ["-jar", "Lavalink.jar"], {
      cwd: lavalinkDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    lavalinkProc.stdout?.on("data", data => {
      const msg = data.toString();
      if (msg.includes("Lavalink is ready to accept connections")) {
        log.info("Server Lavalink siap menerima koneksi (Ready).");
      }
    });

    lavalinkProc.stderr?.on("data", data => {
      const err = data.toString();
      if (err.includes("ERROR") || err.includes("Exception")) {
        log.warn({ err: err.trim() }, "Lavalink log");
      }
    });

    lavalinkProc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        log.warn({ code, signal }, "Proses Lavalink lokal telah berhenti.");
      }
      lavalinkProc = null;
    });
  } catch (err) {
    log.error({ err }, "Gagal menjalankan proses Lavalink otomatis.");
  }
}

export function stopLavalinkProcess(): void {
  if (lavalinkProc && !lavalinkProc.killed) {
    try {
      lavalinkProc.kill();
    } catch {}
    lavalinkProc = null;
  }
}
