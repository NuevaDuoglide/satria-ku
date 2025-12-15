// src/app/api/telegram/route.ts
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ====== Konstanta tombol & teks ======
const BTN_GLOBAL = "🌍 3 Terdekat (Global)";
const BTN_ID3    = "🇮🇩 3 Terdekat (Indonesia)";
const BTN_IDALL  = "🇮🇩 Semua Posisi (Indonesia)";
const BTN_LOC    = "📍 Kirim Lokasi Saya";

const WELCOME = [
  "Selamat datang di *SaTTriO* — Satelite Tracker & Intel Ops 🚀",
  "Bot pengembangan *tracking satelit* untuk edukasi & riset.",
  "Hubungi *Wisnu Duoglide (ET22 – STEI ITB)* untuk saran/masukan.",
  "",
  "• Kirim lokasi dulu untuk mengaktifkan menu.",
  "• Setelah itu, pilih: 🌍 Global / 🇮🇩 Indonesia / 📋 Posisi Semua 🇮🇩",
].join("\n");

const FAREWELL = "Terima kasih telah menggunakan *SaTTriO*. Semoga harimu menyenangkan! ✨";

// ====== Konfigurasi API Telegram ======
const TG = process.env.TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  : "";

// ====== Daftar Satelit Indonesia (ringkas) ======
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

// ====== State sederhana (in-memory) ======
const lastLocation  = new Map<number, { lat: number; lon: number }>();
const pendingAction = new Map<number, { kind: "GLOBAL3"|"ID3"|"IDALL", ts: number }>();
const lastPromptAt  = new Map<number, number>(); // anti-spam “butuh lokasi”
const sentByBot     = new Map<number, number[]>(); // catat message_id yang bot kirim

// ====== Util Keyboard ======
function keyboardAskLoc() {
  return {
    keyboard: [[{ text: BTN_LOC, request_location: true }]],
    resize_keyboard: true, one_time_keyboard: false,
  };
}
function keyboardMain() {
  return {
    keyboard: [[{ text: BTN_GLOBAL }, { text: BTN_ID3 }], [{ text: BTN_IDALL }]],
    resize_keyboard: true, one_time_keyboard: false,
  };
}
function ok() { return Response.json({ ok: true }); }
function hasLoc(chatId: number) { return lastLocation.has(chatId); }
function recordMsg(chatId: number, msgId?: number, keep = true) {
  if (!keep || !msgId) return;
  const arr = sentByBot.get(chatId) ?? [];
  arr.push(msgId);
  // batasi buffer supaya tidak membengkak
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  sentByBot.set(chatId, arr);
}

// ====== HTTP helpers ======
async function sendMessage(chat_id: number, text: string, opts?: {
  reply_markup?: any; parse_mode?: "Markdown"|"MarkdownV2"|"HTML";
  record?: boolean; // default true
}) {
  if (!TG) return;
  const body: any = { chat_id, text, parse_mode: opts?.parse_mode ?? "Markdown" };
  if (opts?.reply_markup) body.reply_markup = opts.reply_markup;
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  const msgId: number | undefined = data?.result?.message_id;
  recordMsg(chat_id, msgId, opts?.record !== false);
  return msgId;
}

// Hapus keyboard dengan mengirim satu pesan yang menyertakan ReplyKeyboardRemove
async function sendAndRemoveKeyboard(chat_id: number, text: string) {
  return sendMessage(chat_id, text, {
    reply_markup: { remove_keyboard: true }, // ReplyKeyboardRemove
    parse_mode: "Markdown",
    record: false, // pesan pamit tidak kita simpan agar tidak ikut terhapus
  });
}

// Delete messages (bulk bila tersedia)
async function deleteMany(chat_id: number, ids: number[]) {
  if (!ids.length || !TG) return;
  // coba deleteMessages (1..100 sekaligus)
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(`${TG}/deleteMessages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, message_ids: chunk }),
    });
    const ok = res.ok && (await res.json().catch(() => ({}))).ok;
    if (!ok) {
      // fallback: deleteMessage satuan
      for (const mid of chunk) {
        await fetch(`${TG}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, message_id: mid }),
        });
      }
    }
  }
}

// ====== N2YO helpers ======
async function n2yoAbove(lat:number, lon:number, altM:number, radiusDeg:number, categoryId:number) {
  const key = process.env.N2YO_API_KEY!;
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/${radiusDeg}/${categoryId}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`N2YO above ${res.status}`);
  return res.json();
}
async function n2yoPositions(id:number, lat:number, lon:number, altM:number, seconds:number) {
  const key = process.env.N2YO_API_KEY!;
  const url = `https://api.n2yo.com/rest/v1/satellite/positions/${id}/${lat}/${lon}/${altM}/${seconds}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`N2YO positions ${res.status}`);
  return res.json();
}

// ====== Math & format ======
const toRad = (d:number)=>d*Math.PI/180;
function haversineKm(aLat:number,aLon:number,bLat:number,bLon:number){
  const R=6371, dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const la1=toRad(aLat), la2=toRad(bLat);
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
const num1=(n:any)=>Number.isFinite(+n)?(+n).toFixed(1):"?";
const num2=(n:any)=>Number.isFinite(+n)?(+n).toFixed(2):"?";
function flagGuess(name:string){const t=name.toUpperCase();
  if (t.includes("STARLINK")||t.includes("NAVSTAR")||t.startsWith("NOAA")||t.startsWith("GOES")||t.includes("IRIDIUM")) return "🇺🇸";
  if (t.includes("ONEWEB")) return "🇬🇧";
  if (t.includes("GALILEO")) return "🇪🇺";
  if (t.includes("GLONASS")||t.includes("COSMOS")||t.includes("KOSMOS")) return "🇷🇺";
  if (t.includes("BEIDOU")||t.includes("YAOGAN")||t.includes("GAOFEN")) return "🇨🇳";
  if (t.includes("QZSS")||t.includes("HIMAWARI")) return "🇯🇵";
  if (t.includes("BRISAT")||t.includes("TELKOM")||t.includes("NUSANTARA")||t.includes("LAPAN")||t.includes("PSN")) return "🇮🇩";
  return "🌐";
}

// ====== Types ======
type TgLocation = { latitude:number; longitude:number };
type TgMsg = { message_id?: number; chat:{id:number}; text?:string; location?:TgLocation };

// ====== Handler ======
export async function POST(req: NextRequest) {
  const u:any = await req.json().catch(()=>null);
  const m: TgMsg|undefined = u?.edited_message ?? u?.message;
  if (!m) return ok();
  const chatId = m.chat.id;

  // simpan message_id user agar bisa dihapus saat /tutup (bila dalam 48 jam & di private chat)
  // catatan: ini *tidak menjamin* bisa dihapus di semua konteks; biarkan API yang menentukan.
  if (u?.message?.message_id) {
    const arr = sentByBot.get(chatId) ?? [];
    // kita tidak menambah message_id user ke sentByBot, karena itu khusus pesan bot.
    // kalau ingin hapus pesan user juga, perlu daftar terpisah + pastikan konteks private chat.
  }

  // 1) Lokasi diterima
  if (m.location) {
    lastLocation.set(chatId, { lat: m.location.latitude, lon: m.location.longitude });
    await sendMessage(chatId, "Lokasi tersimpan. Pilih menu di bawah.", { reply_markup: keyboardMain() });
    const pending = pendingAction.get(chatId);
    if (pending && Date.now() - pending.ts < 5*60_000) {
      if (pending.kind === "GLOBAL3") await handleNearestGlobal(chatId);
      if (pending.kind === "ID3")     await handleNearestIndonesia(chatId);
      if (pending.kind === "IDALL")   await handleAllIndonesiaPositions(chatId);
    }
    pendingAction.delete(chatId);
    return ok();
  }

  const text = (m.text ?? "").trim();

  // 2) Perintah tutup / bye / close
  if (/^\/(tutup|bye|close)\b/i.test(text)) {
    // hapus riwayat pesan bot (<=48 jam, per batas Bot API) lalu pamit + tutup keyboard
    const ids = (sentByBot.get(chatId) ?? []).slice(); // copy
    sentByBot.delete(chatId);
    pendingAction.delete(chatId);
    lastPromptAt.delete(chatId);
    lastLocation.delete(chatId);
    try { await deleteMany(chatId, ids); } catch {}
    await sendAndRemoveKeyboard(chatId, FAREWELL);
    return ok();
  }

  // 3) /start — tampilkan welcome + gate menu jika belum ada lokasi
  if (text.startsWith("/start")) {
    if (!hasLoc(chatId)) {
      await sendMessage(chatId, WELCOME, { reply_markup: keyboardAskLoc() });
      return ok();
    }
    await sendMessage(chatId, WELCOME, { reply_markup: keyboardMain() });
    return ok();
  }

  // 4) Tekan tombol menu
  if (text === BTN_GLOBAL || text === BTN_ID3 || text === BTN_IDALL) {
    if (!hasLoc(chatId)) {
      const now = Date.now();
      const last = lastPromptAt.get(chatId) ?? 0;
      if (now - last > 60_000) {
        await sendMessage(chatId, "Butuh lokasi agar bisa memproses. Tap tombol di bawah.", { reply_markup: keyboardAskLoc() });
        lastPromptAt.set(chatId, now);
      }
      pendingAction.set(chatId, {
        kind: text === BTN_GLOBAL ? "GLOBAL3" : text === BTN_ID3 ? "ID3" : "IDALL",
        ts: now,
      });
      return ok();
    }
    if (text === BTN_GLOBAL) await handleNearestGlobal(chatId);
    if (text === BTN_ID3)    await handleNearestIndonesia(chatId);
    if (text === BTN_IDALL)  await handleAllIndonesiaPositions(chatId);
    return ok();
  }

  // 5) /near manual (tetap ada)
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

  // 6) Default UX
  if (!hasLoc(chatId)) await sendMessage(chatId, "Kirim lokasi dulu ya.", { reply_markup: keyboardAskLoc() });
  else await sendMessage(chatId, "Pilih menu:", { reply_markup: keyboardMain() });
  return ok();
}

// ====== Aksi ======
async function handleNearestGlobal(chatId:number){
  const loc = lastLocation.get(chatId)!;
  const data = await n2yoAbove(loc.lat, loc.lon, 0, 90, 0);
  const arr:any[] = data?.above ?? [];
  if (!arr.length) { await sendMessage(chatId, "Tidak ada objek di atas horizon saat ini."); return; }
  const top = arr.map(s=>({...s, distKm: haversineKm(loc.lat,loc.lon,s.satlat,s.satlng), flag: flagGuess(s.satname)}))
                 .sort((a,b)=>a.distKm-b.distKm).slice(0,3)
                 .map((s:any,i:number)=>`${i+1}. ${s.flag} ${s.satname} (#${s.satid})\n   d≈ ${s.distKm.toFixed(0)} km | alt ${num1(s.satalt)} km`)
                 .join("\n\n");
  await sendMessage(chatId, `3 satelit terdekat (global):\n\n${top}`);
}
async function handleNearestIndonesia(chatId:number){
  const loc = lastLocation.get(chatId)!;
  const allow=new Set(ID_SATS.map(s=>s.id));
  const data = await n2yoAbove(loc.lat, loc.lon, 0, 90, 0);
  const list:any[] = (data?.above ?? []).filter((s:any)=>allow.has(Number(s.satid)));
  if (!list.length) { await sendMessage(chatId, "Tidak ada satelit Indonesia di atas horizon saat ini."); return; }
  const top = list.map(s=>({...s, distKm: haversineKm(loc.lat,loc.lon,s.satlat,s.satlng)}))
                  .sort((a,b)=>a.distKm-b.distKm).slice(0,3)
                  .map((s:any,i:number)=>`${i+1}. 🇮🇩 ${s.satname} (#${s.satid})\n   d≈ ${s.distKm.toFixed(0)} km | alt ${num1(s.satalt)} km`)
                  .join("\n\n");
  await sendMessage(chatId, `3 satelit Indonesia terdekat:\n\n${top}`);
}
async function handleAllIndonesiaPositions(chatId:number){
  const loc = lastLocation.get(chatId)!;
  const lines:string[] = [];
  for (const s of ID_SATS){
    try{
      const p = await n2yoPositions(s.id, loc.lat, loc.lon, 0, 1);
      const pos = p?.positions?.[0];
      const name = p?.info?.satname ?? s.name;
      if (!pos){ lines.push(`🇮🇩 ${name} (#${s.id}) — tidak ada data`); continue; }
      lines.push(`🇮🇩 ${name} (#${s.id})\n   lat ${num2(pos.satlatitude)}, lon ${num2(pos.satlongitude)}, alt ${num1(pos.sataltitude)} km\n   az ${num1(pos.azimuth)}°, el ${num1(pos.elevation)}°`);
    }catch(e:any){ lines.push(`🇮🇩 ${s.name} (#${s.id}) — error: ${e?.message ?? e}`); }
  }
  await sendMessage(chatId, `Posisi semua satelit Indonesia (relatif pengamat):\n\n${lines.join("\n\n")}`);
}
async function handleManualNear(chatId:number, lat:number, lon:number, radius:number, category:number){
  const data = await n2yoAbove(lat, lon, 0, radius, category);
  const arr:any[] = data?.above ?? [];
  if (!arr.length) { await sendMessage(chatId, "Tidak ada objek dalam radius itu."); return; }
  const txt = arr.slice(0,5).map((s:any,i:number)=>`${i+1}. ${s.satname} (#${s.satid})\n   lat=${num2(s.satlat)}, lon=${num2(s.satlng)}, alt=${num1(s.satalt)} km`).join("\n\n");
  await sendMessage(chatId, `Top objek di atasmu (radius ${radius}°):\n\n${txt}`);
}
