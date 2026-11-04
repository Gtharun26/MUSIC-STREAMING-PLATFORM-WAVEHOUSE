import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const mediaDir = path.join(dataDir, "media");
fs.mkdirSync(mediaDir, { recursive: true });
const catalogFile = path.join(dataDir, "catalog.json");
const starterCatalogFile = path.join(root, "starter-catalog.json");
const starterMediaDir = path.join(root, "public", "starter-music");
const readCatalog = () => {
  try {
    return JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  } catch {
    return JSON.parse(fs.readFileSync(starterCatalogFile, "utf8"));
  }
};
let catalog = readCatalog();
if (!fs.existsSync(catalogFile))
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
const saveCatalog = () =>
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
app.use(express.json());
app.use("/media", express.static(mediaDir));
app.use("/starter-music", express.static(starterMediaDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, mediaDir),
  filename: (_req, file, cb) =>
    cb(
      null,
      `${Date.now()}-${randomBytes(5).toString("hex")}${path.extname(file.originalname).toLowerCase()}`,
    ),
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 201 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const accepted =
      file.fieldname === "audio"
        ? ext === ".mp3"
        : file.fieldname === "cover"
          ? [".jpg", ".jpeg", ".png", ".webp"].includes(ext)
          : false;
    cb(
      accepted
        ? null
        : new Error(
            file.fieldname === "audio"
              ? "Audio must be an MP3 file."
              : "Cover must be JPG, PNG, or WebP.",
          ),
      accepted,
    );
  },
});
const safeTrack = ({ audioFile, coverFile, ...track }) => ({
  ...track,
  audioUrl: track.isSample
    ? `/starter-music/${audioFile}`
    : `/media/${audioFile}`,
  coverUrl: coverFile
    ? `${track.isSample ? "/starter-music" : "/media"}/${coverFile}`
    : null,
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/tracks", (_req, res) => res.json(catalog.map(safeTrack)));
app.post(
  "/api/tracks",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]),
  (req, res) => {
    const audio = req.files?.audio?.[0];
    if (!audio) return res.status(400).json({ error: "Choose an MP3 file." });
    const cover = req.files?.cover?.[0];
    if (!cover) {
      fs.unlinkSync(audio.path);
      return res
        .status(400)
        .json({ error: "Choose cover artwork for this song." });
    }
    const header = Buffer.alloc(3);
    const fd = fs.openSync(audio.path, "r");
    fs.readSync(fd, header, 0, 3, 0);
    fs.closeSync(fd);
    const id3Header = header.toString("ascii", 0, 3) === "ID3";
    const mpegFrame = header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    if (!id3Header && !mpegFrame) {
      fs.unlinkSync(audio.path);
      if (cover) fs.unlinkSync(cover.path);
      return res
        .status(400)
        .json({ error: "The selected file does not contain MP3 audio." });
    }
    const title = String(req.body.title || "").trim();
    const artist = String(req.body.artist || "").trim();
    const genre = String(req.body.genre || "").trim();
    if (!title || !artist || !genre) {
      fs.unlinkSync(audio.path);
      if (cover) fs.unlinkSync(cover.path);
      return res
        .status(400)
        .json({ error: "Title, artist, and genre are required." });
    }
    const track = {
      id: randomBytes(9).toString("hex"),
      title: title.slice(0, 100),
      artist: artist.slice(0, 100),
      genre: genre.slice(0, 40),
      audioFile: audio.filename,
      coverFile: cover?.filename || null,
      plays: 0,
      addedAt: Date.now(),
    };
    catalog.unshift(track);
    saveCatalog();
    res.status(201).json(safeTrack(track));
  },
);
app.post(
  "/api/tracks/bulk",
  upload.fields([
    { name: "audio", maxCount: 200 },
    { name: "cover", maxCount: 1 },
  ]),
  (req, res) => {
    const files = req.files?.audio || [];
    const cover = req.files?.cover?.[0];
    const cleanup = () => {
      for (const file of [...files, ...(cover ? [cover] : [])])
        fs.rmSync(file.path, { force: true });
    };
    if (!files.length || !cover) {
      cleanup();
      return res.status(400).json({
        error: !files.length
          ? "Choose a folder containing MP3 files."
          : "Choose cover artwork for these songs.",
      });
    }
    for (const audio of files) {
      const header = Buffer.alloc(3);
      const fd = fs.openSync(audio.path, "r");
      fs.readSync(fd, header, 0, 3, 0);
      fs.closeSync(fd);
      const valid =
        header.toString("ascii", 0, 3) === "ID3" ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
      if (!valid) {
        cleanup();
        return res.status(400).json({
          error: `“${audio.originalname}” does not contain MP3 audio. No tracks were imported.`,
        });
      }
    }
    const defaultArtist =
      String(req.body.artist || "").trim() || "Unknown artist";
    const defaultGenre = String(req.body.genre || "").trim() || "Uncategorized";
    const imported = files.map((audio) => {
      const basename = path.basename(
        audio.originalname,
        path.extname(audio.originalname),
      );
      const title = basename
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: randomBytes(9).toString("hex"),
        title: (title || "Untitled track").slice(0, 100),
        artist: defaultArtist.slice(0, 100),
        genre: defaultGenre.slice(0, 40),
        audioFile: audio.filename,
        coverFile: cover.filename,
        plays: 0,
        addedAt: Date.now(),
      };
    });
    catalog.unshift(...imported);
    saveCatalog();
    res.status(201).json(imported.map(safeTrack));
  },
);
app.delete("/api/tracks/:id", (req, res) => {
  const track = catalog.find((item) => item.id === req.params.id);
  if (!track) return res.sendStatus(404);
  catalog = catalog.filter((item) => item.id !== track.id);
  saveCatalog();
  if (!track.isSample) {
    fs.rmSync(path.join(mediaDir, track.audioFile), { force: true });
    if (
      track.coverFile &&
      !catalog.some((item) => item.coverFile === track.coverFile)
    )
      fs.rmSync(path.join(mediaDir, track.coverFile), { force: true });
  }
  for (const room of rooms.values())
    room.queue = room.queue.filter((id) => id !== track.id);
  io.emit("rooms:changed");
  res.sendStatus(204);
});
app.post("/api/tracks/:id/play", (req, res) => {
  const track = catalog.find((item) => item.id === req.params.id);
  if (!track) return res.sendStatus(404);
  track.plays = (track.plays || 0) + 1;
  saveCatalog();
  res.json({ plays: track.plays });
});

const rooms = new Map();
const makeCode = () => {
  let code;
  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
};
const viewRoom = (room) => ({
  code: room.code,
  hostId: room.hostId,
  hostName: room.hostName,
  participants: [...room.participants.values()],
  queue: room.queue
    .map((id) => catalog.find((track) => track.id === id))
    .filter(Boolean)
    .map(safeTrack),
  trackId: room.trackId,
  playing: room.playing,
  position: room.position,
  updatedAt: room.updatedAt,
});
const broadcastRoom = (room) =>
  io.to(room.code).emit("room:state", viewRoom(room));
const ack = (cb, value) => {
  if (typeof cb === "function") cb(value);
};
io.on("connection", (socket) => {
  socket.on("room:create", ({ user } = {}, cb) => {
    if (!user?.id || !user?.name)
      return ack(cb, { ok: false, error: "Sign in before creating a room." });
    const code = makeCode();
    const room = {
      code,
      hostId: user.id,
      hostName: user.name,
      hostSocketId: socket.id,
      participants: new Map(),
      queue: [],
      trackId: null,
      playing: false,
      position: 0,
      updatedAt: Date.now(),
    };
    room.participants.set(socket.id, {
      id: user.id,
      name: user.name,
      socketId: socket.id,
    });
    rooms.set(code, room);
    socket.join(code);
    ack(cb, { ok: true, room: viewRoom(room) });
    broadcastRoom(room);
  });
  socket.on("room:join", ({ code, user } = {}, cb) => {
    code = String(code || "")
      .trim()
      .toUpperCase();
    const room = rooms.get(code);
    if (!room)
      return ack(cb, {
        ok: false,
        error: "Room code not found. Check it and try again.",
      });
    if (!user?.id || !user?.name)
      return ack(cb, { ok: false, error: "Sign in before joining a room." });
    room.participants.set(socket.id, {
      id: user.id,
      name: user.name,
      socketId: socket.id,
    });
    socket.join(code);
    ack(cb, { ok: true, room: viewRoom(room) });
    broadcastRoom(room);
  });
  socket.on("room:leave", ({ code } = {}) => leaveRoom(socket, code));
  socket.on("room:queue:add", ({ code, trackId } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !room.participants.has(socket.id))
      return ack(cb, { ok: false, error: "Join a room first." });
    if (!catalog.some((track) => track.id === trackId))
      return ack(cb, {
        ok: false,
        error: "That track is no longer available.",
      });
    room.queue.push(trackId);
    broadcastRoom(room);
    ack(cb, { ok: true });
  });
  socket.on("room:queue:remove", ({ code, index } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostSocketId !== socket.id)
      return ack(cb, {
        ok: false,
        error: "Only the host can manage the queue.",
      });
    if (Number.isInteger(index) && index >= 0 && index < room.queue.length)
      room.queue.splice(index, 1);
    broadcastRoom(room);
    ack(cb, { ok: true });
  });
  socket.on("room:control", ({ code, action, trackId, position } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostSocketId !== socket.id)
      return ack(cb, {
        ok: false,
        error: "Only the host can control playback.",
      });
    const now = Date.now();
    if (action === "play") {
      if (trackId && catalog.some((track) => track.id === trackId))
        room.trackId = trackId;
      if (!room.trackId && room.queue.length) room.trackId = room.queue[0];
      if (!room.trackId)
        return ack(cb, {
          ok: false,
          error: "Add a song to the shared queue first.",
        });
      const selectedTrack = catalog.find((item) => item.id === room.trackId);
      if (
        selectedTrack &&
        (!wasPlaying || selectedTrack.id !== previousTrackId)
      )
        selectedTrack.plays = (selectedTrack.plays || 0) + 1;
      if (selectedTrack) saveCatalog();
      room.playing = true;
      room.position = Math.max(0, Number(position) || 0);
    } else if (action === "pause") {
      room.position = Math.max(0, Number(position) || 0);
      room.playing = false;
    } else if (action === "seek") {
      room.position = Math.max(0, Number(position) || 0);
    } else if (action === "sync") {
      room.position = Math.max(0, Number(position) || 0);
    } else if (action === "next" || action === "previous") {
      const i = room.queue.indexOf(room.trackId);
      const next = action === "next" ? i + 1 : i - 1;
      if (next >= 0 && next < room.queue.length)
        room.trackId = room.queue[next];
      else if (action === "next" && room.queue.length)
        room.trackId = room.queue[0];
      room.position = 0;
      room.playing = Boolean(room.trackId);
    }
    room.updatedAt = now;
    broadcastRoom(room);
    ack(cb, { ok: true });
  });
  socket.on("disconnect", () => {
    for (const room of rooms.values()) leaveRoom(socket, room.code);
  });
});
function leaveRoom(socket, code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room || !room.participants.has(socket.id)) return;
  const wasHost = room.hostSocketId === socket.id;
  room.participants.delete(socket.id);
  socket.leave(room.code);
  if (room.participants.size === 0) rooms.delete(room.code);
  else {
    if (wasHost) {
      const nextHost = room.participants.values().next().value;
      room.hostSocketId = nextHost.socketId;
      room.hostId = nextHost.id;
      room.hostName = nextHost.name;
    }
    broadcastRoom(room);
  }
}

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || "Upload failed." });
});

const port = Number(process.env.API_PORT || 3010);
server.listen(port, "0.0.0.0", () =>
  console.log(`Melodify API and Jam server listening on ${port}`),
);
