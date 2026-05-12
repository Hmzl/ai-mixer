import { readdir } from "node:fs/promises";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function GET() {
  try {
    const stylesDir = path.join(process.cwd(), "public", "styles");
    const entries = await readdir(stylesDir, { withFileTypes: true });

    const styles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => `/styles/${encodeURIComponent(name)}`);

    return Response.json({ styles });
  } catch {
    // If the folder does not exist yet, return an empty list.
    return Response.json({ styles: [] });
  }
}
