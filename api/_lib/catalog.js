import { randomUUID } from "node:crypto";
import { readyRedis, withRedisLock } from "./redis.js";

const KEY = "wavehouse:catalog:v1";
export const starterTracks = [
  {
    id: "sample-quiet-hours",
    title: "Quiet Hours",
    artist: "Keynata Commons",
    genre: "Classical",
    duration: "2:17",
    plays: 0,
    audioUrl: "/starter-music/classical_piano_5702.mp3",
    coverUrl: "/starter-music/quiet-hours.svg",
    isSample: true,
    license: "CC0 1.0",
    sourceUrl: "https://github.com/carf-coder/keynata-commons",
  },
  {
    id: "sample-afterglow",
    title: "Afterglow",
    artist: "Keynata Commons",
    genre: "J-Pop",
    duration: "2:36",
    plays: 0,
    audioUrl: "/starter-music/jpop_3piece_11001.mp3",
    coverUrl: "/starter-music/afterglow.svg",
    isSample: true,
    license: "CC0 1.0",
    sourceUrl: "https://github.com/carf-coder/keynata-commons",
  },
  {
    id: "sample-open-road",
    title: "Open Road",
    artist: "Keynata Commons",
    genre: "Rock",
    duration: "2:05",
    plays: 0,
    audioUrl: "/starter-music/rock_standard_10001.mp3",
    coverUrl: "/starter-music/open-road.svg",
    isSample: true,
    license: "CC0 1.0",
    sourceUrl: "https://github.com/carf-coder/keynata-commons",
  },
];

const normalize = (track) => ({
  ...track,
  plays: Number(track.plays || 0),
});

export async function getCatalog() {
  const db = await readyRedis();
  const saved = await db.get(KEY);
  if (!saved) {
    await db.set(KEY, JSON.stringify(starterTracks));
    return starterTracks;
  }
  return normalizeCatalog(JSON.parse(saved));
}

const normalizeCatalog = (saved = []) => {
  const byId = new Map(saved.map((track) => [track.id, track]));
  const samples = starterTracks.map((track) => ({
    ...track,
    plays: Number(byId.get(track.id)?.plays ?? track.plays),
  }));
  const uploaded = saved.filter((track) => !track.isSample).map(normalize);
  return [...samples, ...uploaded];
};

export async function addTrack(input) {
  const track = {
    id: randomUUID(),
    title: String(input.title || "").trim().slice(0, 100),
    artist: String(input.artist || "").trim().slice(0, 100),
    genre: String(input.genre || "").trim().slice(0, 40),
    audioUrl: input.audioUrl,
    coverUrl: input.coverUrl,
    plays: 0,
    addedAt: Date.now(),
  };
  if (!track.title || !track.artist || !track.genre)
    throw new Error("Title, artist, and genre are required.");
  await withRedisLock(KEY, async (db) => {
    const saved = await db.get(KEY);
    const list = normalizeCatalog(saved ? JSON.parse(saved) : starterTracks);
    const next = [track, ...list.filter((item) => !item.isSample)];
    await db.set(KEY, JSON.stringify(next));
  });
  return track;
}

export async function addTracks(inputs) {
  const tracks = inputs.map((input) => ({
    id: randomUUID(),
    title: String(input.title || "").trim().slice(0, 100),
    artist: String(input.artist || "").trim().slice(0, 100),
    genre: String(input.genre || "").trim().slice(0, 40),
    audioUrl: input.audioUrl,
    coverUrl: input.coverUrl,
    plays: 0,
    addedAt: Date.now(),
  }));
  if (!tracks.length || tracks.some((track) => !track.title || !track.artist || !track.genre))
    throw new Error("Each track needs a title, artist, and genre.");
  await withRedisLock(KEY, async (db) => {
    const saved = await db.get(KEY);
    const list = normalizeCatalog(saved ? JSON.parse(saved) : starterTracks);
    await db.set(KEY, JSON.stringify([...tracks, ...list.filter((item) => !item.isSample)]));
  });
  return tracks;
}

export async function replaceCatalog(tracks) {
  await withRedisLock(KEY, (db) => db.set(KEY, JSON.stringify(tracks)));
}

export async function incrementPlays(id) {
  return withRedisLock(KEY, async (db) => {
    const saved = await db.get(KEY);
    const list = normalizeCatalog(saved ? JSON.parse(saved) : starterTracks);
    const track = list.find((item) => item.id === id);
    if (!track) return null;
    track.plays = Number(track.plays || 0) + 1;
    await db.set(KEY, JSON.stringify(list));
    return track;
  });
}
