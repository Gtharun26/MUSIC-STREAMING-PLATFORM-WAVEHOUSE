import Redis from "ioredis";
import { randomBytes } from "node:crypto";

const url = process.env.REDIS_URL;

export const redis = url
  ? new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    })
  : null;

export async function readyRedis() {
  if (!redis) throw new Error("Hosted storage is not configured yet.");
  if (redis.status === "wait") await redis.connect();
  return redis;
}

export async function withRedisLock(key, callback) {
  const db = await readyRedis();
  const lockKey = `${key}:lock`;
  const token = randomBytes(12).toString("hex");
  const expiresAt = Date.now() + 3000;
  while (!(await db.set(lockKey, token, "PX", 8000, "NX"))) {
    if (Date.now() > expiresAt) throw new Error("Storage is busy. Try again.");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  try {
    return await callback(db);
  } finally {
    await db.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      token,
    );
  }
}
