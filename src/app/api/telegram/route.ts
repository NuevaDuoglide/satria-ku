// src/app/api/telegram/route.ts
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- Konstanta ----------
const TG = process.env.TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  : "";

const ID_SATS: { id: number; name: string }[] = [
  { id: 65588, name: "PSN N5" },
  { id: 58995, name: "TELKOMSAT 113BT" },
  { id: 57045, name: "NUSANTARA TIGA" },
  { id: 44048, name: "NUSANTARA SATU" },
  { id: 43587, name: "TELKOM-4" },
  { id: 41944, name: "TELKOM 3S" },
  { id: 41603, name: "LAPAN A3" },
  { id: 41591, name: "BRISAT" },
  { id: 40931, name: "LAPAN A2" },
];

// Tombol
const BTN_GLOBAL = "🌍 3 Terdekat (Global)";
const BTN_ID3 = "🇮🇩 3 Terdekat (Indonesia)";
const BTN_IDALL = "🇮🇩 Semua Posisi (Indonesia)";
const BTN_LOC = "📍 Kirim Lokasi Saya";

// Simpan state *sementara* (production: pindah ke DB/KV)
const lastLocation = new Map<number, { lat: number; lon: number }>();
const pendingAction = new Map<number, "GLOBAL3" | "ID3" | "IDALL">();

// ---------- Handler utama ----------
type TgLocation = { latitude: number; longitude: number };
type TgMessage = {
  chat: { id: number };
  text?: string;
  location?: TgLocation;
};

export async function POST(req: NextRequest) {
  const u: any = await req.json().catch(() => null);
  const m: TgMessage | undefined = u?.edited_message ?? u?.message;
  if (!m) return ok();

  const chatId = m.chat.id;

  // 1) Jika user kirim lokasi
  if (m.location) {
    lastLocation.set(chatId, { lat: m.location.latitude, lon: m.location.longitude });
    const action = pendingAction.get(chatId);
    if (!action) {
      await sendMessage(chatId, "Lokasi diterima. Pilih salah satu menu di bawah.", keyboardMain());
      return ok();
    }
    // jalankan aksi yang tertunda
    if (action === "GLOBAL3") await handleNearestGlobal(chatId);
    if (action === "ID3") await handleNearestIndonesia(chatId);
    if (action === "IDALL") await handleAllIndonesiaPositions(chatId);
    pendingAction.delete(chatId);
    return ok();
  }

  const text = (m.text ?? "").trim();

  // 2) Perintah /start
  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      "SATRIAKU siap.\nPilih menu atau kirim lokasi via tombol.",
      keyboardMain()
    );
    return ok();
  }

  // 3) Tekan tombol menu
  if (text === BTN_GLOBAL) {
    if (!ensureLocation(chatId)) return askLocation(chatId, "Butuh lokasi untuk cari 3 satelit terdekat (global).");
    await handleNearestGlobal(chatId);
    return ok();
  }
  if (text === BTN_ID3) {
    if (!ensureLocation(chatId)) return askLocation(chatId, "Butuh lokasi untuk cari 3 satelit Indonesia terdekat.");
    await handleNearestIndonesia(chatId);
    return ok();
  }
  if (text === BTN_IDALL) {
    if (!ensureLocation(chatId)) return askLocation(chatId, "Butuh lokasi untuk daftar posisi semua satelit Indonesia.");
    await handleAllIndonesiaPositions(chatId);
    return ok();
  }

  // 4) Perintah manual /near lat lon [radius] [category] tetap didukung
  if (text.startsWith("/near")) {
    const [, a, b, c, d] = text.split(/\s+/);
    const lat = Number(a), lon = Number(b);
    const radius = Number(c ?? 30), category = Number(d ?? 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      await sendMessage(chatId, "Format: /near <lat> <lon> [radiusDeg] [category]\nContoh: /near -6.9 107.6 30 0");
      return ok();
    }
    await handleManualNear(chatId, lat, lon, radius, category);
    return ok();
  }

  // 5) Default: tampilkan keyboard
  await sendMessage(chatId, "Pilih menu:", keyboardMain());
  return ok();
}

// ---------- Aksi ----------
async function handleNearestGlobal(chatId: number) {
  const loc = lastLocation.get(chatId)!;
  const RADIUS = 90;  // 0..90 (90 = semua di atas horizon)
  const CATEGORY = 0; // 0 = semua kategori
  const data = await n2yoAbove(loc.lat, loc.lon, 0, RADIUS, CATEGORY);
  const arr: any[] = data?.above ?? [];
  if (!arr.length) return sendMessage(chatId, "Tidak ada objek di atas horizon saat ini.");

  const withDist = arr.map(s => ({
    ...s,
    distKm: haversineKm(loc.lat, loc.lon, s.satlat, s.satlng),
    flag: flagGuess(s.satname)
  }));
  withDist.sort((a, b) => a.distKm - b.distKm);
  const top = withDist.slice(0, 3).map((s: any, i: number) =>
    `${i + 1}. ${s.flag} ${s.satname} (#${s.satid})\n   d≈ ${s.distKm.toFixed(0)} km | alt ${num1(s.satalt)} km`
  ).join("\n\n");
  await sendMessage(chatId, `3 satelit terdekat (global):\n\n${top}`);
}

async function handleNearestIndonesia(chatId: number) {
  const loc = lastLocation.get(chatId)!;
  const RADIUS = 90, CATEGORY = 0;
  const allow = new Set(ID_SATS.map(s => s.id));
  const data = await n2yoAbove(loc.lat, loc.lon, 0, RADIUS, CATEGORY);
  let list: any[] = (data?.above ?? []).filter((s: any) => allow.has(Number(s.satid)));
  if (!list.length) return sendMessage(chatId, "Tidak ada satelit Indonesia di atas horizon saat ini.");

  const withDist = list.map(s => ({
    ...s,
    distKm: haversineKm(loc.lat, loc.lon, s.satlat, s.satlng)
  }));
  withDist.sort((a, b) => a.distKm - b.distKm);
  const top = withDist.slice(0, 3).map((s: any, i: number) =>
    `${i + 1}. 🇮🇩 ${s.satname} (#${s.satid})\n   d≈ ${s.distKm.toFixed(0)} km | alt ${num1(s.satalt)} km`
  ).join("\n\n");
  await sendMessage(chatId, `3 satelit Indonesia terdekat:\n\n${top}`);
}

async function handleAllIndonesiaPositions(chatId: number) {
  const loc = lastLocation.get(chatId)!;
  const seconds = 1;
  const lines: string[] = [];
  for (const s of ID_SATS) {
    try {
      const p = await n2yoPositions(s.id, loc.lat, loc.lon, 0, seconds);
      const pos = p?.positions?.[0];
      const name = p?.info?.satname ?? s.name;
      if (!pos) { lines.push(`🇮🇩 ${name} (#${s.id}) — tidak ada data`); continue; }
      lines.push(`🇮🇩 ${name} (#${s.id})\n   lat ${num2(pos.satlatitude)}, lon ${num2(pos.satlongitude)}, alt ${num1(pos.sataltitude)} km\n   az ${num1(pos.azimuth)}°, el ${num1(pos.elevation)}°`);
    } catch (e: any) {
      lines.push(`🇮🇩 ${s.name} (#${s.id}) — error: ${e?.message ?? e}`);
    }
  }
  await sendMessage(chatId, `Posisi semua satelit Indonesia (relatif pengamat):\n\n${lines.join("\n\n")}`);
}

async function handleManualNear(chatId: number, lat: number, lon: number, radius: number, category: number) {
  const data = await n2yoAbove(lat, lon, 0, radius, category);
  const arr: any[] = data?.above ?? [];
  if (!arr.length) { await sendMessage(chatId, "Tidak ada objek dalam radius itu."); return; }
  const top = arr.slice(0, 5).map((s: any, i: number) =>
    `${i + 1}. ${s.satname} (#${s.satid})\n   lat=${num2(s.satlat)}, lon=${num2(s.satlng)}, alt=${num1(s.satalt)} km`
  ).join("\n\n");
  await sendMessage(chatId, `Top objek di atasmu (radius ${radius}°):\n\n${top}`);
}

// ---------- Util, API & UI ----------
function keyboardMain() {
  return {
    keyboard: [
      [{ text: BTN_GLOBAL }, { text: BTN_ID3 }],
      [{ text: BTN_IDALL }],
      [{ text: BTN_LOC, request_location: true }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function ensureLocation(chatId: number) {
  return lastLocation.has(chatId);
}
async function askLocation(chatId: number, msg: string) {
  await sendMessage(chatId, msg, {
    keyboard: [[{ text: BTN_LOC, request_location: true }]],
    resize_keyboard: true, one_time_keyboard: true,
  });
  // tandai aksi yang ditunda berdasar pesan
  if (msg.includes("global")) pendingAction.set(chatId, "GLOBAL3");
  else if (msg.includes("Indonesia terdekat")) pendingAction.set(chatId, "ID3");
  else pendingAction.set(chatId, "IDALL");
}

async function sendMessage(chat_id: number, text: string, reply_markup?: any) {
  if (!TG) return;
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, reply_markup }),
    cache: "no-store",
  });
}

async function n2yoAbove(lat: number, lon: number, altM: number, radiusDeg: number, categoryId: number) {
  const key = process.env.N2YO_API_KEY;
  if (!key) throw new Error("N2YO_API_KEY belum di-set");
  // /above => daftar objek di atas pengamat dalam radius 0-90, category 0=semua
  // Ref: N2YO API docs (request/response fields) dan batasan kuota per jam. :contentReference[oaicite:2]{index=2}
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/${radiusDeg}/${categoryId}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`N2YO above ${res.status}`);
  return res.json();
}

async function n2yoPositions(id: number, lat: number, lon: number, altM: number, seconds: number) {
  const key = process.env.N2YO_API_KEY;
  if (!key) throw new Error("N2YO_API_KEY belum di-set");
  // /positions => satlatitude, satlongitude, azimuth, elevation (relatif pengamat) :contentReference[oaicite:3]{index=3}
  const url = `https://api.n2yo.com/rest/v1/satellite/positions/${id}/${lat}/${lon}/${altM}/${seconds}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`N2YO positions ${res.status}`);
  return res.json();
}

function toRad(d: number) { return (d * Math.PI) / 180; }
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const la1 = toRad(aLat), la2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function num1(n: any) { const x = Number(n); return Number.isFinite(x) ? x.toFixed(1) : "?"; }
function num2(n: any) { const x = Number(n); return Number.isFinite(x) ? x.toFixed(2) : "?"; }

// Heuristik bendera (fallback 🌐). Untuk akurasi penuh, gabungkan dengan katalog satelit (by country) di luar N2YO API.
function flagGuess(name: string): string {
  const t = name.toUpperCase();
  if (t.includes("STARLINK") || t.includes("NAVSTAR") || t.startsWith("NOAA") || t.startsWith("GOES") || t.includes("IRIDIUM")) return "🇺🇸";
  if (t.includes("ONEWEB")) return "🇬🇧";
  if (t.includes("GALILEO")) return "🇪🇺";
  if (t.includes("GLONASS") || t.includes("COSMOS") || t.includes("KOSMOS")) return "🇷🇺";
  if (t.includes("BEIDOU") || t.includes("YAOGAN") || t.includes("GAOFEN")) return "🇨🇳";
  if (t.includes("QZSS") || t.includes("HIMAWARI")) return "🇯🇵";
  if (t.includes("BRISAT") || t.includes("TELKOM") || t.includes("NUSANTARA") || t.includes("LAPAN") || t.includes("PSN")) return "🇮🇩";
  if (t.includes("SES") || t.includes("ASTRA") || t.includes("LUXSAT")) return "🇱🇺"; // kasar
  return "🌐";
}

function ok() { return Response.json({ ok: true }); }
