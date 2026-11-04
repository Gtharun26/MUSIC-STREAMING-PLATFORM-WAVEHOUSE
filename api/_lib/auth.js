import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readyRedis, withRedisLock } from "./redis.js";

const COOKIE = "wavehouse_session";
const EMAIL_KEY = (email) => `wavehouse:user:email:${email}`;
const USER_KEY = (id) => `wavehouse:user:${id}`;
const USERNAME_KEY = (username) => `wavehouse:user:username:${username}`;
const sessionSecret = () => {
  const secret = process.env.WAVEHOUSE_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
};

const base64url = (text) => Buffer.from(text).toString("base64url");
const signature = (payload) =>
  createHmac("sha256", sessionSecret()).update(payload).digest("base64url");

export function publicUser(user) {
  const { passwordHash, passwordSalt, ...safe } = user;
  return safe;
}

export function createSession(res, user) {
  if (!sessionSecret()) throw new Error("Hosted authentication is not configured.");
  const payload = base64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }));
  const token = `${payload}.${signature(payload)}`;
  const secure = process.env.VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
}

export function clearSession(res) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export function sessionUser(req) {
  if (!sessionSecret()) return null;
  const cookie = String(req.headers?.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const token = cookie.slice(COOKIE.length + 1);
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return null;
  const expected = signature(payload);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!session.sub || session.exp < Date.now()) return null;
    return {
      id: session.sub,
      email: session.email,
      name: session.name,
      username: session.username,
      role: session.role === "admin" ? "admin" : "user",
    };
  } catch {
    return null;
  }
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { passwordSalt: salt, passwordHash: scryptSync(password, salt, 64).toString("hex") };
}

export function passwordMatches(password, account) {
  if (!account?.passwordSalt || !account?.passwordHash) return false;
  const candidate = Buffer.from(scryptSync(password, account.passwordSalt, 64).toString("hex"));
  const stored = Buffer.from(account.passwordHash);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export async function findAccountByEmail(email) {
  const db = await readyRedis();
  const id = await db.get(EMAIL_KEY(email));
  if (!id) return null;
  const account = await db.get(USER_KEY(id));
  return account ? JSON.parse(account) : null;
}

export async function createAccount(account) {
  return withRedisLock("wavehouse:users", async (db) => {
    const [emailExists, usernameExists] = await Promise.all([
      db.exists(EMAIL_KEY(account.email)),
      db.exists(USERNAME_KEY(account.username)),
    ]);
    if (emailExists) throw new Error("That email already has an account.");
    if (usernameExists) throw new Error("That username is already taken.");
    await db.set(USER_KEY(account.id), JSON.stringify(account));
    await db.set(EMAIL_KEY(account.email), account.id);
    await db.set(USERNAME_KEY(account.username), account.id);
    await db.sadd("wavehouse:user:ids", account.id);
    return account;
  });
}

export async function saveAccount(account, previous) {
  return withRedisLock("wavehouse:users", async (db) => {
    if (account.email !== previous.email && await db.exists(EMAIL_KEY(account.email)))
      throw new Error("That email is already used by another account.");
    if (account.username !== previous.username && await db.exists(USERNAME_KEY(account.username)))
      throw new Error("That username is already taken.");
    if (account.email !== previous.email) {
      await db.del(EMAIL_KEY(previous.email));
      await db.set(EMAIL_KEY(account.email), account.id);
    }
    if (account.username !== previous.username) {
      await db.del(USERNAME_KEY(previous.username));
      await db.set(USERNAME_KEY(account.username), account.id);
    }
    await db.set(USER_KEY(account.id), JSON.stringify(account));
    await db.sadd("wavehouse:user:ids", account.id);
    return account;
  });
}
