import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Proxy upload vers ImgBB (la clé reste côté serveur).
 * Body JSON : { "image": "<data URL complète ou base64 brut>" }
 */
export async function POST(req: Request) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "IMGBB_API_KEY manquant (variables d’environnement)." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide." }, { status: 400 });
  }

  const image =
    typeof body === "object" &&
    body !== null &&
    "image" in body &&
    typeof (body as { image: unknown }).image === "string"
      ? (body as { image: string }).image
      : null;

  if (!image) {
    return NextResponse.json({ error: "Champ « image » requis." }, { status: 400 });
  }

  const base64Payload = image.includes(",") ? image.split(",")[1] : image;
  if (!base64Payload?.trim()) {
    return NextResponse.json({ error: "Image base64 vide." }, { status: 400 });
  }

  const formData = new FormData();
  formData.append("image", base64Payload.replace(/\s/g, ""));

  const response = await fetch(
    `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`,
    { method: "POST", body: formData }
  );

  const data = (await response.json()) as {
    success?: boolean;
    data?: { url?: string };
    error?: { message?: string };
  };

  if (!data.success || !data.data?.url) {
    return NextResponse.json(
      { error: data.error?.message ?? "Échec upload ImgBB.", detail: data },
      { status: 502 }
    );
  }

  return NextResponse.json({ url: data.data.url });
}
