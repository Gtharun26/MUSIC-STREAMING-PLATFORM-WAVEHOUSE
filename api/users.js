import { readyRedis } from "./_lib/redis.js";
import { sessionUser, publicUser } from "./_lib/auth.js";

export default async function handler(req, res) {
  const current = sessionUser(req);
  if (current?.role !== "admin") return res.sendStatus(403);
  try {
    const db = await readyRedis();
    if (req.method === "GET") {
      const ids = await db.smembers("wavehouse:user:ids");
      const users = await Promise.all(ids.map(async (id) => {
        const saved = await db.get(id === "admin" ? "wavehouse:user:admin" : `wavehouse:user:${id}`);
        return saved ? publicUser(JSON.parse(saved)) : null;
      }));
      return res.status(200).json(users.filter(Boolean));
    }
    if (req.method === "DELETE") {
      const url = new URL(req.url, "https://wavehouse.invalid");
      const id = url.searchParams.get("id") || url.pathname.split("/").filter(Boolean).at(-1);
      if (!id || id === "admin") return res.status(400).json({ error: "The administrator account cannot be removed." });
      const key = `wavehouse:user:${id}`;
      const saved = await db.get(key);
      if (!saved) return res.sendStatus(404);
      const account = JSON.parse(saved);
      await db.del(key, `wavehouse:user:email:${account.email}`, `wavehouse:user:username:${account.username}`);
      await db.srem("wavehouse:user:ids", id);
      return res.sendStatus(204);
    }
    return res.sendStatus(405);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Account management failed." });
  }
}
