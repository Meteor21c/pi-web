import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { readBodyWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_ATTACHED_IMAGE_BYTES } from "@/lib/image-attachments";
import { isApiRequestAllowed } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }

  if (!request.headers.get("content-type")?.startsWith("image/")) {
    return Response.json({ error: "Select one image to upload" }, { status: 400 });
  }
  let image: Blob | null;
  let name: string;
  try {
    name = decodeURIComponent(request.headers.get("x-image-name") ?? "image");
    image = await readBodyWithinLimit(request, MAX_ATTACHED_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "An image must be 10 MB or smaller" }, { status: 413 });
    }
    return Response.json({ error: "Invalid image upload" }, { status: 400 });
  }

  if (!image?.size) {
    return Response.json({ error: "Select one image to upload" }, { status: 400 });
  }

  try {
    const data = new Uint8Array(await image.arrayBuffer());
    const root = resolve(getAgentDir(), "meteoragent-attachments");
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A fresh directory keeps same-named attachments separate and preserves their names.
    const directory = await mkdtemp(join(root, "image-"));
    const fileName = win32.basename(name).replace(/[\p{C}<>:"|?*]/gu, "_").replace(/[. ]+$/, "") || "image";
    const filePath = join(directory, fileName);
    try {
      await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(filePath).catch(() => {});
      throw error;
    }
    return Response.json({ filePath });
  } catch {
    return Response.json({ error: "Could not save the original image" }, { status: 500 });
  }
}
