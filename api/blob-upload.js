import { handleUpload } from "@vercel/blob/client";
import { sessionUser } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "DELETE") return res.sendStatus(405);
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.REDIS_URL)
    return res.status(503).json({ error: "Connect Vercel Blob and Redis before uploading." });
  if (req.method === "DELETE") {
    if (sessionUser(req)?.role !== "admin") return res.sendStatus(403);
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.filter((url) => {
      try { return new URL(url).hostname.endsWith(".public.blob.vercel-storage.com"); }
      catch { return false; }
    }).slice(0, 202) : [];
    if (!urls.length) return res.status(400).json({ error: "No uploaded media was provided." });
    try {
      const { del } = await import("@vercel/blob");
      await del(urls);
      return res.sendStatus(204);
    } catch (error) {
      return res.status(400).json({ error: error.message || "Unused upload cleanup failed." });
    }
  }
  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => {
        if (sessionUser(req)?.role !== "admin")
          throw new Error("Sign in as the hosted administrator to upload music.");
        return {
          allowedContentTypes: ["audio/mpeg", "image/jpeg", "image/png", "image/webp"],
          maximumSizeInBytes: 100 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ app: "wavehouse" }),
        };
      },
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Upload authorization failed." });
  }
}
