const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function POST(req: Request) {
  const update = await req.json().catch(()=>null);
  const msg = update?.message;
  if (!msg) return Response.json({ ok: true });

  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  await sendMessage(chatId, text ? `✅ Bot aktif.\nKamu kirim: ${text}` : "✅ Bot aktif.");
  return Response.json({ ok: true });
}

async function sendMessage(chat_id: number, text: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
}
