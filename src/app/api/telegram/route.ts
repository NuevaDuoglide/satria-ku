// src/app/api/telegram/route.ts
import type { NextRequest } from "next/server";

// Paksa runtime Node & non-cache untuk keamanan webhook
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TG_BASE = process.env.TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  : "";

// Minimal tipe Update agar enak dipakai
type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
  };
};

export async function POST(req: NextRequest) {
  // Baca update Telegram; kalau gagal parse, jangan bikin 500 loop
  const u = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const m = u?.message;
  if (!m) return Response.json({ ok: true });

  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();

  // /start
  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      [
        "SATRIAKU siap! Perintah:",
        "/near <lat> <lon> [radiusDeg=30] [category=0]",
        "Contoh: /near -6.9 107.6 30 0",
      ].join("\n")
    );
    return Response.json({ ok: true });
  }

  // /near <lat> <lon> [radiusDeg] [category]
  if (text.startsWith("/near")) {
    const [, a, b, c, d] = text.split(/\s+/);
    const lat = Number(a);
    const lon = Number(b);
    const radius = Number.isFinite(Number(c)) ? Number(c) : 30;
    const category = Number.isFinite(Number(d)) ? Number(d) : 0;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      await sendMessage(
        chatId,
        "Format: /near <lat> <lon> [radiusDeg] [category]\nContoh: /near -6.9 107.6 30 0"
      );
      return Response.json({ ok: true });
    }

    try {
      const data = await n2yoAbove(lat, lon, 0, radius, category); // alt=0 m (permukaan laut)
      const arr: any[] = (data as any)?.above ?? [];
      if (!Array.isArray(arr) || arr.length === 0) {
        await sendMessage(chatId, "Tidak ada objek dalam radius itu.");
        return Response.json({ ok: true });
      }

      const top = arr
        .slice(0, 5)
        .map(
          (s: any, i: number) =>
            `${i + 1}. ${s.satname} (#${s.satid})
   lat=${fmt2(s.satlat)}, lon=${fmt2(s.satlng)}, alt=${fmt1(s.satalt)} km`
        )
        .join("\n\n");

      await sendMessage(
        chatId,
        `Top objek di atasmu (radius ${radius}°):\n\n${top}`
      );
    } catch (e: any) {
      await sendMessage(
        chatId,
        `Gagal ambil data N2YO: ${e?.message ?? String(e)}`
      );
    }
    return Response.json({ ok: true });
  }

  // Fallback
  await sendMessage(chatId, "Kirim /start untuk bantuan.");
  return Response.json({ ok: true });
}

// ---------- Helpers ----------

function fmt2(n: any) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "?";
}
function fmt1(n: any) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(1) : "?";
}

async function sendMessage(chat_id: number, text: string) {
  if (!TG_BASE) return; // biar build aman meski env belum di-set
  await fetch(`${TG_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
    cache: "no-store",
  });
}

async function n2yoAbove(
  lat: number,
  lon: number,
  altM: number,
  radiusDeg: number,
  category: number
) {
  const key = process.env.N2YO_API_KEY;
  if (!key) throw new Error("N2YO_API_KEY belum di-set");
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/${radiusDeg}/${category}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`N2YO error ${res.status} ${msg}`);
  }
  return res.json();
}
