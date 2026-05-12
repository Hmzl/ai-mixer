import { NextResponse } from "next/server";

export const runtime = "nodejs";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v21.0";
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  const mime = m[1];
  try {
    const b64 = m[2].replace(/\s/g, "");
    const buffer = Buffer.from(b64, "base64");
    return { mime, buffer };
  } catch {
    return null;
  }
}

/**
 * Envoie une image vers un numéro via WhatsApp Cloud API (Meta).
 * Variables Vercel / .env :
 * - WHATSAPP_CLOUD_ACCESS_TOKEN
 * - WHATSAPP_CLOUD_PHONE_NUMBER_ID (ID du numéro WhatsApp Business dans Meta, pas le numéro lui-même)
 * - WHATSAPP_RECIPIENT_E164 (optionnel, défaut 212710046071)
 */
export async function POST(req: Request) {
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  const recipientRaw =
    process.env.WHATSAPP_RECIPIENT_E164 ?? "212710046071";
  const recipient = recipientRaw.replace(/\D/g, "");

  if (!token || !phoneNumberId) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        error:
          "WhatsApp Cloud API non configurée (WHATSAPP_CLOUD_ACCESS_TOKEN, WHATSAPP_CLOUD_PHONE_NUMBER_ID).",
      },
      { status: 503 }
    );
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Image trop volumineuse." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Corps JSON invalide." }, { status: 400 });
  }

  const imageBase64 =
    typeof body === "object" &&
    body !== null &&
    "imageBase64" in body &&
    typeof (body as { imageBase64: unknown }).imageBase64 === "string"
      ? (body as { imageBase64: string }).imageBase64
      : null;

  if (!imageBase64) {
    return NextResponse.json({ ok: false, error: "imageBase64 requis." }, { status: 400 });
  }

  const parsed = parseDataUrl(imageBase64);
  if (!parsed || parsed.buffer.length === 0) {
    return NextResponse.json({ ok: false, error: "imageBase64 invalide." }, { status: 400 });
  }

  if (parsed.buffer.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Image trop volumineuse." }, { status: 413 });
  }

  const uploadUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`;
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append("type", parsed.mime);
  formData.append(
    "file",
    new File([parsed.buffer], "ai-mixer.png", { type: parsed.mime })
  );

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const uploadJson = (await uploadRes.json()) as { id?: string; error?: unknown };
  if (!uploadRes.ok || !uploadJson.id) {
    return NextResponse.json(
      {
        ok: false,
        error: "Échec upload média WhatsApp.",
        detail: uploadJson,
      },
      { status: uploadRes.status >= 400 ? uploadRes.status : 502 }
    );
  }

  const messagesUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const sendRes = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "image",
      image: { id: uploadJson.id },
    }),
  });

  const sendJson = await sendRes.json();
  if (!sendRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "Échec envoi message WhatsApp.",
        detail: sendJson,
      },
      { status: sendRes.status >= 400 ? sendRes.status : 502 }
    );
  }

  return NextResponse.json({ ok: true, configured: true, detail: sendJson });
}
