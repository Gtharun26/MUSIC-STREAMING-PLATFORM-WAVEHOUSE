import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readyRedis } from "./_lib/redis.js";
import {
  createAccount,
  createSession,
  clearSession,
  findAccountByEmail,
  hashPassword,
  passwordMatches,
  publicUser,
  saveAccount,
  sessionUser,
} from "./_lib/auth.js";

const cleanEmail = (value) => String(value || "").trim().toLowerCase();
const validUsername = (value) => /^[a-z0-9][a-z0-9._]{2,19}$/.test(value);
const adminKey = "wavehouse:user:admin";

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function adminAccount(email, password) {
  const configuredEmail = cleanEmail(process.env.WAVEHOUSE_ADMIN_EMAIL);
  const configuredPassword = process.env.WAVEHOUSE_ADMIN_PASSWORD;
  if (!configuredEmail || !configuredPassword || configuredPassword.length < 12 || email !== configuredEmail || !equalSecret(password, configuredPassword))
    return null;
  const db = await readyRedis();
  const saved = await db.get(adminKey);
  if (saved) {
    const account = JSON.parse(saved);
    const updated = { ...account, email: configuredEmail, ...hashPassword(configuredPassword), role: "admin" };
    if (updated.email !== account.email) await saveAccount(updated, account);
    await db.set(adminKey, JSON.stringify(updated));
    return updated;
  }
  const name = String(process.env.WAVEHOUSE_ADMIN_NAME || "Studio Admin").slice(0, 80);
  const username = String(process.env.WAVEHOUSE_ADMIN_USERNAME || "studioadmin").toLowerCase();
  if (!validUsername(username)) throw new Error("WAVEHOUSE_ADMIN_USERNAME must be a valid 3–20 character username.");
  const account = {
    id: "admin",
    name,
    username,
    email: configuredEmail,
    role: "admin",
    dob: "",
    bio: "",
    favoriteGenre: "",
    ...hashPassword(configuredPassword),
  };
  await createAccount(account);
  await db.set(adminKey, JSON.stringify(account));
  return account;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.REDIS_URL || !process.env.WAVEHOUSE_SESSION_SECRET)
    return res.status(503).json({ error: "Hosted sign-in is not configured yet." });
  try {
    if (req.method === "GET") {
      const user = sessionUser(req);
      if (!user) return res.sendStatus(401);
      const db = await readyRedis();
      const saved = await db.get(user.role === "admin" ? adminKey : `wavehouse:user:${user.id}`);
      return saved ? res.status(200).json({ user: publicUser(JSON.parse(saved)) }) : res.sendStatus(401);
    }
    if (req.method !== "POST") return res.sendStatus(405);
    const body = req.body || {};
    if (body.action === "logout") {
      clearSession(res);
      return res.status(200).json({ ok: true });
    }
    if (body.action === "profile") {
      const currentUser = sessionUser(req);
      if (!currentUser) return res.sendStatus(401);
      const db = await readyRedis();
      const key = currentUser.role === "admin" ? adminKey : `wavehouse:user:${currentUser.id}`;
      const saved = await db.get(key);
      if (!saved) return res.sendStatus(401);
      const previous = JSON.parse(saved);
      const name = String(body.name || "").trim().slice(0, 80);
      const username = String(body.username || "").trim().toLowerCase();
      const email = cleanEmail(body.email);
      if (!name || !validUsername(username) || !/^\S+@\S+\.\S+$/.test(email))
        return res.status(400).json({ error: "Enter a valid name, username, and email." });
      if (currentUser.role === "admin" && email !== previous.email)
        return res.status(400).json({ error: "Change the hosted admin login email in Vercel settings." });
      const updated = {
        ...previous,
        name,
        username,
        email,
        dob: String(body.dob || ""),
        bio: String(body.bio || "").trim().slice(0, 240),
        favoriteGenre: String(body.favoriteGenre || "").slice(0, 40),
      };
      await saveAccount(updated, previous);
      if (currentUser.role === "admin") await db.set(adminKey, JSON.stringify(updated));
      createSession(res, updated);
      return res.status(200).json({ user: publicUser(updated) });
    }
    const email = cleanEmail(body.email);
    const password = String(body.password || "");
    let account;
    if (body.action === "signup") {
      const configuredAdminEmail = cleanEmail(process.env.WAVEHOUSE_ADMIN_EMAIL);
      const name = String(body.name || "").trim().slice(0, 80);
      const username = String(body.username || "").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email))
        return res.status(400).json({ error: "Enter a valid email address." });
      if (email === configuredAdminEmail)
        return res.status(409).json({ error: "This email is reserved for the hosted administrator." });
      if (!name || !validUsername(username))
        return res.status(400).json({ error: "Enter a name and a valid unique username." });
      if (password.length < 8 || password.length > 128)
        return res.status(400).json({ error: "Use a password between 8 and 128 characters." });
      account = await createAccount({
        id: randomUUID(),
        name,
        username,
        email,
        role: "user",
        dob: "",
        bio: "",
        favoriteGenre: "",
        ...hashPassword(password),
      });
    } else if (body.action === "login") {
      const address = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();
      const attemptKey = `wavehouse:auth:attempt:${createHash("sha256").update(`${address}:${email}`).digest("hex")}`;
      const db = await readyRedis();
      if (Number(await db.get(attemptKey) || 0) >= 10)
        return res.status(429).json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." });
      account = await adminAccount(email, password);
      if (!account) account = await findAccountByEmail(email);
      if (!passwordMatches(password, account)) {
        const failures = await db.incr(attemptKey);
        if (failures === 1) await db.expire(attemptKey, 15 * 60);
        return res.status(401).json({ error: "Email or password is incorrect." });
      }
      await db.del(attemptKey);
    } else {
      return res.status(400).json({ error: "Unknown sign-in action." });
    }
    createSession(res, account);
    return res.status(200).json({ user: publicUser(account) });
  } catch (error) {
    const status = /already has|already taken|already used/i.test(error.message) ? 409 : 400;
    return res.status(status).json({ error: error.message || "Sign-in failed." });
  }
}
