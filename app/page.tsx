"use client";
import { useEffect, useRef, useState } from "react";

type StyleOverlay = {
  id: string;
  url: string;
  xPct: number;
  yPct: number;
  scale: number;
  flipX: boolean;
};

/** Numéro WhatsApp (format international sans +) pour ouvrir le chat après envoi. */
const WHATSAPP_PHONE_E164 = "212710046071";

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch?.[1] ?? "image/png";
  const binary = atob(parts[1] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function resultImageToBlob(result: string): Promise<Blob> {
  if (result.startsWith("data:")) return dataUrlToBlob(result);
  const res = await fetch(result);
  return res.blob();
}

function openWhatsAppChat() {
  const wa = `https://wa.me/${WHATSAPP_PHONE_E164}?text=${encodeURIComponent(
    "Photo AI Mixer — joindre le fichier téléchargé (Téléchargements / Fichiers)."
  )}`;
  window.open(wa, "_blank", "noopener,noreferrer");
}

export default function Home() {
  const [styles, setStyles] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [overlays, setOverlays] = useState<StyleOverlay[]>([]);
  const [activeOverlayId, setActiveOverlayId] = useState<string | null>(null);
  const [draggingOverlayId, setDraggingOverlayId] = useState<string | null>(null);
  const [touchDraggingStyle, setTouchDraggingStyle] = useState<string | null>(null);
  const [touchPoint, setTouchPoint] = useState<{ x: number; y: number } | null>(null);

  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextClickRef = useRef(false);

  const applyImageFile = (f: File) => {
    setPreview(URL.createObjectURL(f));
    setOverlays([]);
  };

  useEffect(() => {
    fetch("/api/styles")
      .then((res) => res.json())
      .then((data) => setStyles(data.styles || []));
  }, []);

  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      // Avoid forcing CORS mode for blob/data/local URLs on mobile browsers.
      if (/^https?:\/\//i.test(src)) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Unable to load image: ${src}`));
      img.src = src;
    });

  const addOverlayAtClientPoint = (url: string, x: number, y: number) => {
    const rect = previewBoxRef.current?.getBoundingClientRect();
    if (!rect) return;

    const overlay: StyleOverlay = {
      id: Date.now().toString(),
      url,
      xPct: ((x - rect.left) / rect.width) * 100,
      yPct: ((y - rect.top) / rect.height) * 100,
      scale: 1,
      flipX: false,
    };

    setOverlays((prev) => [...prev, overlay]);
    setActiveOverlayId(overlay.id);
  };

  const isPointInsidePreview = (x: number, y: number) => {
    const rect = previewBoxRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  const saveImageAndOpenWhatsApp = async (resultDataUrlOrUrl: string) => {
    const blob = await resultImageToBlob(resultDataUrlOrUrl);
    const ext = blob.type.includes("jpeg") ? "jpg" : "png";
    const filename = `ai-mixer-${Date.now()}.${ext}`;

    try {
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.warn("Download failed", e);
    }

    let shared = false;
    try {
      const file = new File([blob], filename, { type: blob.type || "image/png" });
      if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "AI Mixer",
          text: `À envoyer à +${WHATSAPP_PHONE_E164}`,
        });
        shared = true;
      }
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name !== "AbortError") console.warn("Share failed", e);
    }

    if (!shared) openWhatsAppChat();
  };

  const renderCompositeImage = async () => {
    if (!preview) throw new Error("No base image selected.");

    const base = await loadImage(preview);
    const previewWidth = previewImageRef.current?.clientWidth ?? base.naturalWidth;

    const canvas = document.createElement("canvas");
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable.");

    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    const ratio = canvas.width / previewWidth;

    for (const overlay of overlays) {
      try {
        const sticker = await loadImage(overlay.url);
        const centerX = (overlay.xPct / 100) * canvas.width;
        const centerY = (overlay.yPct / 100) * canvas.height;
        const drawW = 80 * overlay.scale * ratio;
        const drawH = drawW * (sticker.naturalHeight / sticker.naturalWidth);

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.scale(overlay.flipX ? -1 : 1, 1);
        ctx.drawImage(sticker, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      } catch (e) {
        // Keep generating even if one sticker cannot be drawn.
        console.warn("Overlay render failed", overlay.url, e);
      }
    }

    return canvas.toDataURL("image/png");
  };

  const generate = async () => {
    if (!preview || overlays.length === 0) {
      return alert("Choisissez une image et ajoutez au moins un style.");
    }

    setLoading(true);

    try {
      let out: string;
      try {
        out = await renderCompositeImage();
      } catch (e) {
        console.warn("Composite render failed, fallback to base preview", e);
        out = preview;
      }
      setResult(out);
      try {
        await saveImageAndOpenWhatsApp(out);
      } catch (e) {
        console.warn("Save/share failed, fallback to WhatsApp chat", e);
        openWhatsAppChat();
      }
    } catch (e) {
      console.error(e);
      alert("Échec de la génération ou de l'envoi. Réessayez.");
    } finally {
      setLoading(false);
    }
  };

  const zoomActive = (direction: "in" | "out") => {
    if (!activeOverlayId) return;
    setOverlays((prev) =>
      prev.map((o) => {
        if (o.id !== activeOverlayId) return o;
        const factor = direction === "in" ? 1.15 : 1 / 1.15;
        const nextScale = o.scale * factor;
        return { ...o, scale: Math.max(0.2, Math.min(4, nextScale)) };
      })
    );
  };

  const deleteActive = () => {
    if (!activeOverlayId) return;
    setOverlays((prev) => prev.filter((o) => o.id !== activeOverlayId));
    setActiveOverlayId(null);
  };

  const flipHorizontalActive = () => {
    if (!activeOverlayId) return;
    setOverlays((prev) =>
      prev.map((o) =>
        o.id === activeOverlayId ? { ...o, flipX: !o.flipX } : o
      )
    );
  };

  return (
    <main className="p-6 text-center">
      <h1 className="text-3xl font-bold">AI Image Mixer</h1>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        <label className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm cursor-pointer hover:bg-slate-50">
          Choisir une image
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) applyImageFile(f);
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          Prendre une photo
        </button>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-hidden={true}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) applyImageFile(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => zoomActive("out")}
          disabled={!activeOverlayId}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          - Zoom
        </button>
        <button
          type="button"
          onClick={() => zoomActive("in")}
          disabled={!activeOverlayId}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Zoom
        </button>
        <button
          type="button"
          onClick={flipHorizontalActive}
          disabled={!activeOverlayId}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Miroir horizontal
        </button>
        <button
          type="button"
          onClick={deleteActive}
          disabled={!activeOverlayId}
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 shadow-sm transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete
        </button>
      </div>

      {preview && (
        <div
          ref={previewBoxRef}
          className="relative mt-4 mx-auto w-72 rounded-2xl border border-slate-200 bg-white p-2 shadow-md overflow-hidden"
        >
          <img ref={previewImageRef} src={preview} className="rounded-xl w-full" />

          {overlays.map((o) => (
            <img
              key={o.id}
              src={o.url}
              onPointerDown={() => setDraggingOverlayId(o.id)}
              onClick={() => setActiveOverlayId(o.id)}
              onPointerMove={(e) => {
                if (draggingOverlayId !== o.id) return;
                const rect = previewBoxRef.current!.getBoundingClientRect();
                setOverlays((prev) =>
                  prev.map((x) =>
                    x.id === o.id
                      ? {
                          ...x,
                          xPct: ((e.clientX - rect.left) / rect.width) * 100,
                          yPct: ((e.clientY - rect.top) / rect.height) * 100,
                        }
                      : x
                  )
                );
              }}
              onPointerUp={() => setDraggingOverlayId(null)}
              style={{
                position: "absolute",
                left: `${o.xPct}%`,
                top: `${o.yPct}%`,
                transform: `translate(-50%, -50%) scale(${o.flipX ? -o.scale : o.scale}, ${o.scale})`,
                transformOrigin: "center",
                width: 80,
                touchAction: "none",
              }}
              className="rounded-lg shadow-lg"
            />
          ))}
        </div>
      )}

      {touchDraggingStyle && touchPoint && (
        <img
          src={touchDraggingStyle}
          alt=""
          style={{
            position: "fixed",
            left: touchPoint.x,
            top: touchPoint.y,
            transform: "translate(-50%, -50%)",
            width: 72,
            height: 72,
            borderRadius: 12,
            pointerEvents: "none",
            zIndex: 50,
            opacity: 0.75,
          }}
          className="shadow-xl"
        />
      )}

      <div className="flex gap-3 flex-wrap justify-center mt-6">
        {styles.map((style) => (
          <img
            key={style}
            src={style}
            className="w-20 h-20 rounded-lg cursor-pointer"
            style={{ touchAction: "none" }}
            onClick={() => {
              if (skipNextClickRef.current) {
                skipNextClickRef.current = false;
                return;
              }
              if (!previewBoxRef.current) return;
              const rect = previewBoxRef.current.getBoundingClientRect();
              addOverlayAtClientPoint(
                style,
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
              );
            }}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              setTouchDraggingStyle(style);
              setTouchPoint({ x: touch.clientX, y: touch.clientY });
            }}
            onTouchMove={(e) => {
              if (!touchDraggingStyle) return;
              e.preventDefault();
              const touch = e.touches[0];
              setTouchPoint({ x: touch.clientX, y: touch.clientY });
            }}
            onTouchEnd={(e) => {
              if (!touchDraggingStyle) return;
              skipNextClickRef.current = true;
              const touch = e.changedTouches[0];
              if (isPointInsidePreview(touch.clientX, touch.clientY)) {
                addOverlayAtClientPoint(style, touch.clientX, touch.clientY);
              }
              setTouchDraggingStyle(null);
              setTouchPoint(null);
            }}
            onTouchCancel={() => {
              setTouchDraggingStyle(null);
              setTouchPoint(null);
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", style);
            }}
          />
        ))}
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const style = e.dataTransfer.getData("text/plain");
          addOverlayAtClientPoint(style, e.clientX, e.clientY);
        }}
        className="mt-4"
      />

      <button
        type="button"
        onClick={generate}
        disabled={loading}
        className="mt-6 rounded-xl bg-blue-600 px-6 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Envoi…" : "Envoyer"}
      </button>

      {result && (
        <div className="mt-4">
          <img src={result} alt="Résultat" className="mx-auto w-72 rounded-xl" />
          <p className="mx-auto mt-2 max-w-sm text-xs text-slate-500">
            Sur téléphone, choisissez WhatsApp puis le contact +212 710 046 071 si le
            partage le propose. Sinon le chat WhatsApp s’ouvre : joignez le fichier
            téléchargé (icône trombone).
          </p>
        </div>
      )}
    </main>
  );
}