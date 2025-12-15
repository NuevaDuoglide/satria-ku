export const runtime = "nodejs"; // aman di Vercel

type TgMessage = {
  chat: { id: number };
  text?: string;
  location?: { latitude: number; longitude: number };
};

function jsonOk(v?: unknown) { return Response.json({ ok: true, v }); }

async function sendMessage(chat_id: number, text: string, reply_markup?: any) {
  const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, reply_markup }),
  });
}

async function sendShareLocationKeyboard(chat_id: number) {
  await sendMessage(
    chat_id,
    "Kirim lokasi kamu (GPS) untuk cek satelit terdekat.",
    {
      keyboard: [[{ text: "📍 Kirim Lokasi Saya", request_location: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
      selective: true,
    }
  );
}

async function n2yoAbove(lat: number, lon: number, altM: number, radiusDeg: number, category: number) {
  const key = process.env.N2YO_API_KEY!;
  const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/${radiusDeg}/${category}/?apiKey=${key}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`N2YO error ${res.status}`);
  return res.json();
}

function toRad(d: number) { return (d * Math.PI) / 180; }
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const la1 = toRad(aLat), la2 = toRad(bLat);
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Opsional: whitelist satelit Indonesia (NORAD IDs) — isi belakangan
const ID_SATS = new Set<number>([
  // contoh: 43587, 41608, 40931, 41603, /* Telkom-4, BRIsat, LAPAN-A2, LAPAN-A3, ... */
]);

export async function POST(req: Request) {
  const u = await req.json();
  // dukung live location (datang sebagai edited_message), atau pesan biasa
  const m: TgMessage | undefined = u?.edited_message ?? u?.message;
  if (!m) return jsonOk();

  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();

  // 1) Jika user kirim lokasi
  if (m.location) {
    const { latitude: lat, longitude: lon } = m.location;
    const RADIUS = 45;      // derajat dari zenith
    const CATEGORY = 0;     // 0 = semua kategori (lihat docs)
    try {
      const data = await n2yoAbove(lat, lon, 0, RADIUS, CATEGORY);
      let list: any[] = data?.above ?? [];
      // Bila ingin hanya “satelit Indonesia”, aktifkan filter ini:
      if (ID_SATS.size) list = list.filter((s: any) => ID_SATS.has(Number(s.satid)));
      if (!list.length) {
        await sendMessage(chatId, "Tidak ada objek dalam radius itu. Coba /radius 90 untuk semua di atas horizon.");
        return jsonOk();
      }
      // pilih 5 terdekat berdasar jarak tanah user ↔ subpoint satelit
      const withDist = list.map((s: any) => ({
        ...s,
        distKm: haversineKm(lat, lon, s.satlat, s.satlng),
      }));
      withDist.sort((a: any, b: any) => a.distKm - b.distKm);
      const top = withDist.slice(0, 5)
        .map((s: any, i: number) =>
          `${i+1}. ${s.satname} (#${s.satid})\n` +
          `   d≈ ${s.distKm.toFixed(0)} km | alt ${Number(s.satalt).toFixed(0)} km\n` +
          `   subpoint: ${s.satlat.toFixed(2)}, ${s.satlng.toFixed(2)}`
        ).join("\n\n");
      await sendMessage(chatId, `Satelit terdekat di atas lokasimu (radius ${RADIUS}°):\n\n${top}`);
    } catch (e: any) {
      await sendMessage(chatId, `Gagal ambil data N2YO: ${e?.message ?? e}`);
    }
    return jsonOk();
  }

  // 2) Perintah teks
  if (text.startsWith("/start")) {
    await sendMessage(
      chatId,
      "SATRIAKU siap!\n\n• Tekan tombol di bawah untuk kirim lokasi.\n• Atau: /near <lat> <lon> [radiusDeg=30] [category=0]",
    );
    await sendShareLocationKeyboard(chatId);
    return jsonOk();
  }

  if (text.startsWith("/near")) {
    const [, a, b, c, d] = text.split(/\s+/);
    const lat = Number(a), lon = Number(b);
    const radius = Number(c ?? 30), category = Number(d ?? 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      await sendMessage(chatId, "Format: /near <lat> <lon> [radiusDeg] [category]\nContoh: /near -6.9 107.6 30 0");
      return jsonOk();
    }
    try {
      const data = await n2yoAbove(lat, lon, 0, radius, category);
      const arr: any[] = data?.above ?? [];
      if (!arr.length) { await sendMessage(chatId, "Tidak ada objek dalam radius itu."); return jsonOk(); }
      const top = arr.slice(0, 5).map((s: any, i: number) =>
        `${i+1}. ${s.satname} (#${s.satid})\n   lat=${s.satlat.toFixed(2)}, lon=${s.satlng.toFixed(2)}, alt=${Number(s.satalt).toFixed(1)} km`
      ).join("\n\n");
      await sendMessage(chatId, `Top objek di atasmu (radius ${radius}°):\n\n${top}`);
    } catch (e: any) {
      await sendMessage(chatId, `Gagal ambil data N2YO: ${e.message ?? e}`);
    }
    return jsonOk();
  }

  // fallback
  await sendShareLocationKeyboard(chatId);
  return jsonOk();
}
