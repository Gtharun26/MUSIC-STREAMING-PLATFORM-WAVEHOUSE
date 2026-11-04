import http from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { getCatalog } from "./_lib/catalog.js";
import { readyRedis } from "./_lib/redis.js";
import { sessionUser } from "./_lib/auth.js";

const server = http.createServer();
const io = new Server(server, {
  // Vercel maps this function file to /api/socket-io. Keep Socket.IO on the
  // function route itself so the upgrade request reaches this serverless function.
  path: "/api/socket-io",
  addTrailingSlash: false,
  transports: ["websocket"],
  cors: { origin: true, credentials: false },
});

if (process.env.REDIS_URL) {
  const pubClient = new Redis(process.env.REDIS_URL, { lazyConnect: true });
  const subClient = pubClient.duplicate({ lazyConnect: true });
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
}

const keyFor = (code) => `wavehouse:jam:${code}`;
const lockFor = (code) => `wavehouse:jam-lock:${code}`;
const ack = (callback, result) => {
  if (typeof callback === "function") callback(result);
};
const readRoom = async (code) => {
  const db = await readyRedis();
  const value = await db.get(keyFor(code));
  return value ? JSON.parse(value) : null;
};
const saveRoom = async (room) => {
  const db = await readyRedis();
  await db.set(keyFor(room.code), JSON.stringify(room), "EX", 60 * 60 * 6);
};
const mutateRoom = async (code, mutate) => {
  const db = await readyRedis();
  const token = randomBytes(12).toString("hex");
  const lock = lockFor(code);
  const until = Date.now() + 2500;
  while (!(await db.set(lock, token, "PX", 5000, "NX"))) {
    if (Date.now() > until) throw new Error("The room is busy. Try again.");
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  try {
    const room = await readRoom(code);
    if (!room) return null;
    const result = await mutate(room);
    await saveRoom(room);
    return result === undefined ? room : result;
  } finally {
    await db.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lock,
      token,
    );
  }
};
const roomView = async (room) => {
  const tracks = await getCatalog();
  return {
    ...room,
    participants: Object.values(room.participants),
    queue: room.queue
      .map((id) => tracks.find((track) => track.id === id))
      .filter(Boolean),
  };
};
const broadcast = async (code) => {
  const room = await readRoom(code);
  if (room) io.to(code).emit("room:state", await roomView(room));
};
const isMember = (room, socket) => Boolean(room?.participants?.[socket.id]);
const broadcastChanged = () => io.emit("rooms:changed");

io.use((socket, next) => {
  const user = sessionUser(socket.request);
  if (!user) return next(new Error("Sign in to join a Jam room."));
  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  socket.on("room:create", async (_payload = {}, callback) => {
    try {
      if (!process.env.REDIS_URL)
        throw new Error("Connect Redis storage to enable Jam rooms.");
      const user = socket.data.user;
      if (!user?.id || !user?.name) throw new Error("Sign in before creating a room.");
      const db = await readyRedis();
      let code;
      do {
        code = randomBytes(3).toString("hex").toUpperCase();
      } while (await db.exists(keyFor(code)));
      const participant = { id: user.id, name: user.name, socketId: socket.id };
      const room = {
        code,
        hostId: user.id,
        hostName: user.name,
        hostSocketId: socket.id,
        participants: { [socket.id]: participant },
        queue: [],
        trackId: null,
        playing: false,
        position: 0,
        updatedAt: Date.now(),
      };
      await saveRoom(room);
      socket.data.roomCode = code;
      await socket.join(code);
      ack(callback, { ok: true, room: await roomView(room) });
      await broadcast(code);
      broadcastChanged();
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("room:join", async ({ code } = {}, callback) => {
    try {
      code = String(code || "").trim().toUpperCase();
      const user = socket.data.user;
      if (!user?.id || !user?.name) throw new Error("Sign in before joining a room.");
      const room = await mutateRoom(code, (current) => {
        current.participants[socket.id] = {
          id: String(user.id).slice(0, 80),
          name: String(user.name).slice(0, 80),
          socketId: socket.id,
        };
        if (current.hostId === user.id || current.hostSocketId == null) {
          current.hostId = String(user.id).slice(0, 80);
          current.hostName = String(user.name).slice(0, 80);
          current.hostSocketId = socket.id;
        }
        return current;
      });
      if (!room) throw new Error("Room code not found. Check it and try again.");
      socket.data.roomCode = code;
      await socket.join(code);
      ack(callback, { ok: true, room: await roomView(room) });
      await broadcast(code);
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("room:leave", ({ code } = {}) => leaveRoom(socket, code, true));

  socket.on("room:queue:add", async ({ code, trackId } = {}, callback) => {
    try {
      code = String(code || "").toUpperCase();
      const tracks = await getCatalog();
      if (!tracks.some((track) => track.id === trackId))
        throw new Error("That track is no longer available.");
      const room = await mutateRoom(code, (current) => {
        if (!isMember(current, socket)) throw new Error("Join a room first.");
        current.queue.push(trackId);
        return current;
      });
      if (!room) throw new Error("Room code not found.");
      await broadcast(code);
      ack(callback, { ok: true });
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("room:queue:remove", async ({ code, index } = {}, callback) => {
    try {
      code = String(code || "").toUpperCase();
      const room = await mutateRoom(code, (current) => {
        if (current.hostSocketId !== socket.id)
          throw new Error("Only the host can manage the queue.");
        if (Number.isInteger(index) && index >= 0 && index < current.queue.length)
          current.queue.splice(index, 1);
        return current;
      });
      if (!room) throw new Error("Room code not found.");
      await broadcast(code);
      ack(callback, { ok: true });
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("room:control", async ({ code, action, trackId, position } = {}, callback) => {
    try {
      code = String(code || "").toUpperCase();
      const tracks = await getCatalog();
      const room = await mutateRoom(code, (current) => {
        if (current.hostSocketId !== socket.id)
          throw new Error("Only the host can control playback.");
        const now = Date.now();
        if (action === "play") {
          if (trackId && tracks.some((track) => track.id === trackId))
            current.trackId = trackId;
          if (!current.trackId && current.queue.length) current.trackId = current.queue[0];
          if (!current.trackId) throw new Error("Add a song to the shared queue first.");
          current.playing = true;
          current.position = Math.max(0, Number(position) || 0);
        } else if (action === "pause" || action === "seek" || action === "sync") {
          current.position = Math.max(0, Number(position) || 0);
          current.playing = action === "pause" ? false : current.playing;
        } else if (action === "next" || action === "previous") {
          const i = current.queue.indexOf(current.trackId);
          const next = action === "next" ? i + 1 : i - 1;
          if (next >= 0 && next < current.queue.length)
            current.trackId = current.queue[next];
          else if (action === "next" && current.queue.length)
            current.trackId = current.queue[0];
          current.position = 0;
          current.playing = Boolean(current.trackId);
        }
        current.updatedAt = now;
        return current;
      });
      if (!room) throw new Error("Room code not found.");
      await broadcast(code);
      ack(callback, { ok: true });
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("disconnect", () => leaveRoom(socket, socket.data.roomCode, false));
});

async function leaveRoom(socket, inputCode, explicit = false) {
  const code = String(inputCode || "").toUpperCase();
  if (!code || !process.env.REDIS_URL) return;
  try {
    const room = await mutateRoom(code, (current) => {
      if (!isMember(current, socket)) return current;
      const wasHost = current.hostSocketId === socket.id;
      delete current.participants[socket.id];
      if (!Object.keys(current.participants).length) {
        if (explicit) return null;
        if (wasHost) current.hostSocketId = null;
        return current;
      }
      if (wasHost && explicit) {
        const nextHost = Object.values(current.participants)[0];
        current.hostSocketId = nextHost.socketId;
        current.hostId = nextHost.id;
        current.hostName = nextHost.name;
      } else if (wasHost) {
        current.hostSocketId = null;
      }
      return current;
    });
    if (!room) {
      const db = await readyRedis();
      await db.del(keyFor(code));
      io.to(code).emit("room:state", null);
    } else await broadcast(code);
    await socket.leave(code);
    socket.data.roomCode = null;
    broadcastChanged();
  } catch (error) {
    console.error("Jam cleanup failed:", error.message);
  }
}

export default server;
