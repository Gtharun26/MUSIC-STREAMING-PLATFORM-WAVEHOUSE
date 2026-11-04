import { getCatalog, addTrack, addTracks, replaceCatalog, starterTracks, incrementPlays } from "./_lib/catalog.js";
import { redis, readyRedis } from "./_lib/redis.js";
import { sessionUser } from "./_lib/auth.js";

const isBlobUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
};

export default async function handler(req, res) {
  const url = new URL(req.url, "https://wavehouse.invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  const id = url.searchParams.get("id") || parts[2];
  const action = url.searchParams.get("action") || parts[3];
  try {
    if (req.method === "GET" && !id) {
      const tracks = redis ? await getCatalog() : starterTracks;
      return res.status(200).json(tracks);
    }
    if (req.method === "POST" && !id) {
      if (!process.env.BLOB_READ_WRITE_TOKEN)
        return res.status(503).json({ error: "Hosted MP3 storage is not configured." });
      if (sessionUser(req)?.role !== "admin")
        return res.status(403).json({ error: "Only the hosted administrator can add tracks." });
      const payload = req.body || {};
      const items = Array.isArray(payload.tracks) ? payload.tracks : [payload];
      if (items.length > 200 || items.some((item) => !isBlobUrl(item.audioUrl) || !isBlobUrl(item.coverUrl)))
        return res.status(400).json({ error: "Upload MP3 files and cover artwork first." });
      const created = items.length === 1
        ? [await addTrack(items[0])]
        : await addTracks(items);
      return res.status(201).json(Array.isArray(payload.tracks) ? created : created[0]);
    }
    if (req.method === "POST" && id && action === "play") {
      if (!redis) return res.status(200).json({ plays: 0 });
      const track = await incrementPlays(id);
      return track ? res.status(200).json({ plays: track.plays }) : res.sendStatus(404);
    }
    if (req.method === "DELETE" && id) {
      if (!process.env.BLOB_READ_WRITE_TOKEN)
        return res.status(503).json({ error: "Hosted MP3 storage is not configured." });
      if (sessionUser(req)?.role !== "admin")
        return res.status(403).json({ error: "Only the hosted administrator can remove tracks." });
      const tracks = await getCatalog();
      const target = tracks.find((track) => track.id === id && !track.isSample);
      if (!target) return res.sendStatus(404);
      const next = tracks.filter((track) => track.id !== id);
      await replaceCatalog(next);
      const { del } = await import("@vercel/blob");
      const urls = [target.audioUrl];
      if (target.coverUrl && !next.some((track) => track.coverUrl === target.coverUrl))
        urls.push(target.coverUrl);
      await del(urls);
      return res.sendStatus(204);
    }
    return res.sendStatus(405);
  } catch (error) {
    if (!redis && req.method !== "GET")
      return res.status(503).json({ error: "Connect Redis storage to enable hosted features." });
    return res.status(400).json({ error: error.message || "Music request failed." });
  }
}
