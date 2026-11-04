import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import { upload as uploadBlob } from "@vercel/blob/client";
import "../style.css";
const DB = "melodify_jam_v1",
  DEFAULT_PREFERENCES = {
    brandVersion: 4,
    theme: "dark",
    accent: "lime",
    autoplayNext: true,
    compactRows: false,
    reduceMotion: false,
  },
  ACCENTS = {
    lime: ["#cef46b", "#a8ce4b"],
    violet: ["#c5a6ff", "#a483ec"],
    coral: ["#ff9b83", "#e77d64"],
    blue: ["#39d9ff", "#12b8df"],
  },
  DEMO = [
    {
      id: "admin-demo",
      name: "Studio Admin",
      email: "admin@melodify.com",
      password: "admin123",
      role: "admin",
      username: "studioadmin",
      dob: "",
      bio: "",
    },
    {
      id: "listener-demo",
      name: "Demo Listener",
      email: "user@melodify.com",
      password: "user123",
      role: "user",
      username: "demolistener",
      dob: "",
      bio: "",
    },
  ];
const readDB = () => {
  try {
    const d = JSON.parse(localStorage.getItem(DB));
    if (d?.users) {
      const reserved = new Set();
      d.users = d.users.map((account) => {
        const source =
          account.username ||
          account.email?.split("@")[0] ||
          account.name ||
          "listener";
        const base =
          source
            .toLowerCase()
            .replace(/[^a-z0-9_.]/g, "")
            .slice(0, 17) || "listener";
        let username = base;
        let suffix = 2;
        while (reserved.has(username)) username = `${base}${suffix++}`;
        reserved.add(username);
        return {
          ...account,
          username,
          dob: account.dob || "",
          bio: account.bio || "",
        };
      });
      return d;
    }
  } catch {}
  const d = {
    users: import.meta.env.DEV ? DEMO : [],
    session: null,
    likes: {},
    playlists: {},
    preferences: {},
  };
  localStorage.setItem(DB, JSON.stringify(d));
  return d;
};
const normalizePreferences = (saved = {}) => ({
  ...DEFAULT_PREFERENCES,
  ...saved,
  ...(saved.brandVersion === DEFAULT_PREFERENCES.brandVersion
    ? {}
    : { accent: "lime" }),
  brandVersion: DEFAULT_PREFERENCES.brandVersion,
});
const time = (n) =>
  `${Math.floor((n || 0) / 60)}:${String(Math.floor((n || 0) % 60)).padStart(2, "0")}`;
const initials = (n) =>
  (n || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
async function uploadHostedFile(file, kind) {
  if (!(file instanceof File)) throw Error("Choose the file to upload.");
  const imageTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  const extension = file.name.split(".").pop().toLowerCase();
  const contentType = kind === "audio" ? "audio/mpeg" : imageTypes[extension];
  if (!contentType) throw Error("Artwork must be JPG, PNG, or WebP.");
  if (kind === "audio" && !file.name.toLowerCase().endsWith(".mp3"))
    throw Error("Choose an MP3 file.");
  const maxBytes = kind === "audio" ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
  if (file.size > maxBytes)
    throw Error(kind === "audio" ? "Each MP3 must be 100 MB or smaller." : "Artwork must be 15 MB or smaller.");
  const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_").slice(-100);
  const normalizedFile = file.type === contentType
    ? file
    : new File([file], safeName, { type: contentType });
  return uploadBlob(`${kind}/${crypto.randomUUID()}-${safeName}`, normalizedFile, {
    access: "public",
    handleUploadUrl: "/api/blob-upload",
    multipart: file.size > 5 * 1024 * 1024,
  });
}
function App() {
  const db = useMemo(readDB, []),
    [users, setUsers] = useState(db.users),
    [user, setUser] = useState(() =>
      db.session ? db.users.find((x) => x.id === db.session.id) || null : null,
    ),
    [auth, setAuth] = useState("login"),
    [authError, setAuthError] = useState(""),
    [page, setPage] = useState("library"),
    [tracks, setTracks] = useState([]),
    [features, setFeatures] = useState({ uploads: false, jams: false, auth: false, adminConfigured: false }),
    [featuresChecked, setFeaturesChecked] = useState(false),
    [likes, setLikes] = useState(db.likes || {}),
    [playlists, setPlaylists] = useState(db.playlists || {}),
    [preferences, setPreferences] = useState(() => ({
      ...normalizePreferences(db.preferences?.[db.session?.id]),
    })),
    [track, setTrack] = useState(null),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [volume, setVolume] = useState(0.8),
    [search, setSearch] = useState(""),
    [genre, setGenre] = useState("All"),
    [toast, setToast] = useState(""),
    [upload, setUpload] = useState(false),
    [busy, setBusy] = useState(false),
    [jam, setJam] = useState(null),
    [code, setCode] = useState(""),
    [roomBusy, setRoomBusy] = useState(false),
    [queue, setQueue] = useState([]),
    [queueOpen, setQueueOpen] = useState(false),
    [newList, setNewList] = useState(""),
    [selected, setSelected] = useState(null);
  const audio = useRef(null),
    sock = useRef(null),
    userRef = useRef(user),
    jamRef = useRef(jam),
    timer = useRef(),
    seeking = useRef(false),
    isAdmin = user?.role === "admin",
    myLikes = likes[user?.id] || [],
    myLists = playlists[user?.id] || [],
    host = Boolean(jam && jam.hostId === user?.id),
    jamTrack =
      jam?.queue?.find((x) => x.id === jam.trackId) ||
      tracks.find((x) => x.id === jam?.trackId);
  const note = useCallback((m) => {
    setToast(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 3200);
  }, []);
  useEffect(() => {
    userRef.current = user;
    jamRef.current = jam;
  }, [user, jam]);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tracks");
      if (!r.ok) throw Error("Music server is unavailable.");
      const catalog = await r.json();
      const status = await fetch("/api/health").then((response) => response.json()).catch(() => ({ ok: true }));
      setFeatures({
        uploads: status.uploads ?? true,
        jams: status.jams ?? true,
        auth: Boolean(status.auth),
        adminConfigured: Boolean(status.adminConfigured),
      });
      setFeaturesChecked(true);
      setTracks(catalog);
      if (status.auth) {
        const session = await fetch("/api/auth").catch(() => null);
        if (!session?.ok) {
          setUser(null);
        } else {
          const data = await session.json();
          if (data.user) {
            const cached = readDB().session;
            const hydrated = {
              ...data.user,
              avatar: cached?.id === data.user.id ? cached.avatar || "" : "",
            };
            setUser(hydrated);
            setUsers((accounts) => [
              ...accounts.filter((account) => account.id !== hydrated.id),
              hydrated,
            ]);
            if (hydrated.role === "admin") {
              const response = await fetch("/api/users").catch(() => null);
              if (response?.ok) setUsers(await response.json());
            }
          }
        }
      }
    } catch {
      setFeatures({ uploads: false, jams: false, auth: false, adminConfigured: false });
      setFeaturesChecked(true);
      try {
        const r = await fetch("/starter-catalog.json");
        if (!r.ok) throw Error("Starter catalog is unavailable.");
        setTracks(await r.json());
      } catch {
        setTracks([]);
        note("The music catalog could not be loaded.");
      }
    }
  }, [note]);
  useEffect(() => {
    load();
    const s = io({
      autoConnect: false,
      path: import.meta.env.PROD ? "/api/socket-io" : "/socket.io",
      ...(import.meta.env.PROD ? { transports: ["websocket"] } : {}),
    });
    sock.current = s;
    s.on("room:state", setJam);
    s.on("rooms:changed", load);
    s.on("connect", () => {
      const activeRoom = jamRef.current;
      const activeUser = userRef.current;
      if (!activeRoom || !activeUser) return;
      s.emit(
        "room:join",
        {
          code: activeRoom.code,
          user: { id: activeUser.id, name: activeUser.name },
        },
        (result) => {
          if (result?.ok) setJam(result.room);
          else if (result?.error) {
            setJam(null);
            note("The Jam room ended while reconnecting.");
          }
        },
      );
    });
    s.on("connect_error", () => note("Could not connect to the Jam server."));
    return () => s.disconnect();
  }, [load, note]);
  useEffect(() => {
    const saved = readDB();
    const nextPreferences = user
      ? { ...(saved.preferences || {}), [user.id]: preferences }
      : saved.preferences || {};
    localStorage.setItem(
      DB,
      JSON.stringify({
        ...saved,
        users,
        session: user,
        likes,
        playlists,
        preferences: nextPreferences,
      }),
    );
  }, [users, user, likes, playlists, preferences]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    const a = audio.current;
    if (!a || !jam) return;
    const t = jamTrack;
    if (!t) {
      a.pause();
      return;
    }
    if (!a.src.endsWith(t.audioUrl)) a.src = t.audioUrl;
    const target =
      (jam.position || 0) +
      (jam.playing ? (Date.now() - (jam.updatedAt || Date.now())) / 1000 : 0);
    if (Math.abs(a.currentTime - target) > 1.4)
      a.currentTime = Math.max(0, target);
    setTrack(t);
    setPlaying(jam.playing);
    if (jam.playing)
      a.play().catch(() => note("Tap play once to enable audio."));
    else a.pause();
  }, [jam?.trackId, jam?.playing, jam?.updatedAt, jamTrack, note]);
  useEffect(() => {
    if (!jam || !host || !jam.playing) return;
    const id = setInterval(() => {
      if (audio.current && sock.current?.connected)
        sock.current.emit("room:control", {
          code: jam.code,
          action: "sync",
          position: audio.current.currentTime,
        });
    }, 5000);
    return () => clearInterval(id);
  }, [jam?.code, jam?.playing, host]);
  const connect = useCallback(async () => {
    const s = sock.current;
    if (s.connected) return;
    await new Promise((ok, no) => {
      const t = setTimeout(
        () => no(Error("Jam server did not respond.")),
        7000,
      );
      s.once("connect", () => {
        clearTimeout(t);
        ok();
      });
      s.once("connect_error", (e) => {
        clearTimeout(t);
        no(e);
      });
      s.connect();
    });
  }, []);
  const emit = useCallback(
    async (event, payload) => {
      const s = sock.current;
      if (!s?.connected) await connect();
      return new Promise((ok, no) => {
        s.emit(event, payload, (r) =>
          r?.ok ? ok(r) : no(Error(r?.error || "Jam action failed.")),
        );
        setTimeout(() => no(Error("Jam server timed out.")), 7000);
      });
    },
    [connect],
  );
  const create = async () => {
    setRoomBusy(true);
    try {
      const r = await emit("room:create", {
        user: { id: user.id, name: user.name },
      });
      setJam(r.room);
      setPage("jam");
      note("Jam created. Share the room code.");
    } catch (e) {
      note(e.message);
    } finally {
      setRoomBusy(false);
    }
  };
  const join = async (e) => {
    e.preventDefault();
    setRoomBusy(true);
    try {
      const r = await emit("room:join", {
        code,
        user: { id: user.id, name: user.name },
      });
      setJam(r.room);
      setPage("jam");
      note("You joined the Jam.");
    } catch (e2) {
      note(e2.message);
    } finally {
      setRoomBusy(false);
    }
  };
  const leave = () => {
    if (jam) sock.current?.emit("room:leave", { code: jam.code });
    setJam(null);
    setPage("jam");
  };
  const control = (action, id, pos) =>
    emit("room:control", {
      code: jam.code,
      action,
      trackId: id,
      position: pos ?? audio.current?.currentTime ?? 0,
    }).catch((e) => note(e.message));
  const play = async (t) => {
    if (!t) return;
    if (jam) {
      if (host) await control("play", t.id, 0);
      else addJam(t);
      return;
    }
    setTrack(t);
    setPlaying(true);
    setQueue((q) => (q.length ? q : tracks));
    audio.current.src = t.audioUrl;
    audio.current.currentTime = 0;
    audio.current.play().catch(() => {
      setPlaying(false);
      note("Could not play that MP3.");
    });
    fetch(`/api/tracks/${t.id}/play`, { method: "POST" })
      .then(() =>
        setTracks((items) =>
          items.map((item) =>
            item.id === t.id ? { ...item, plays: (item.plays || 0) + 1 } : item,
          ),
        ),
      )
      .catch(() => {});
  };
  const toggle = () => {
    if (jam) {
      if (host)
        control(
          playing ? "pause" : "play",
          jam.trackId,
          audio.current.currentTime,
        );
      else note("Only the host controls playback.");
      return;
    }
    if (!track)
      return tracks[0] ? play(tracks[0]) : note("Upload an MP3 to begin.");
    if (playing) {
      audio.current.pause();
      setPlaying(false);
    } else audio.current.play().catch(() => note("Audio could not play."));
  };
  const skip = (d) => {
    if (jam) {
      if (host) control(d > 0 ? "next" : "previous");
      else note("Only the host controls playback.");
      return;
    }
    const q = queue.length ? queue : tracks;
    if (!q.length) return;
    const i = q.findIndex((x) => x.id === track?.id);
    play(q[(i + d + q.length) % q.length]);
  };
  const addJam = async (t) => {
    if (!jam) return note("Create or join a Jam first.");
    try {
      await emit("room:queue:add", { code: jam.code, trackId: t.id });
      note("Added to shared queue.");
    } catch (e) {
      note(e.message);
    }
  };
  const seek = (n) => {
    const p = Number(n);
    setPosition(p);
    if (jam) {
      if (host && !seeking.current) {
        seeking.current = true;
        control("seek", jam.trackId, p).finally(
          () => (seeking.current = false),
        );
      }
    } else if (audio.current) audio.current.currentTime = p;
  };
  const authSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    if (!featuresChecked) return setAuthError("Connecting to Wavehouse… try again in a moment.");
    const f = new FormData(e.currentTarget),
      email = String(f.get("email")).trim().toLowerCase(),
      password = String(f.get("password"));
    if (features.auth) {
      try {
        const payload = { action: auth, email, password };
        if (auth === "signup") {
          payload.name = String(f.get("name")).trim();
          payload.username = String(f.get("username")).trim().toLowerCase();
        }
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) return setAuthError(result.error || "Sign-in failed.");
        const account = result.user;
        setUsers((accounts) => [
          ...accounts.filter((entry) => entry.id !== account.id),
          account,
        ]);
        setUser(account);
        setPreferences(normalizePreferences(readDB().preferences?.[account.id]));
        setPage("library");
        return;
      } catch {
        return setAuthError("Hosted sign-in is unavailable. Check the Vercel service setup.");
      }
    }
    if (auth === "signup") {
      const name = String(f.get("name")).trim();
      const username = String(f.get("username")).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._]{2,19}$/.test(username))
        return setAuthError(
          "Use 3–20 characters: lowercase letters, numbers, dots, or underscores.",
        );
      if (password.length < 6)
        return setAuthError("Use at least 6 characters.");
      if (users.some((x) => x.email.toLowerCase() === email))
        return setAuthError("That email already has an account.");
      if (users.some((x) => x.username.toLowerCase() === username))
        return setAuthError("That username is already taken.");
      const u = {
          id: crypto.randomUUID(),
          name,
          username,
          email,
          password,
          dob: "",
          bio: "",
          role: "user",
        },
        next = [...users, u];
      setUsers(next);
      localStorage.setItem(DB, JSON.stringify({ ...readDB(), users: next }));
      setAuth("login");
      setAuthError("Account created. Sign in to continue.");
      return;
    }
    const u = users.find(
      (x) => x.email.toLowerCase() === email && x.password === password,
    );
    if (!u) return setAuthError("Email or password is incorrect.");
    setUser(u);
    setPreferences(normalizePreferences(readDB().preferences?.[u.id]));
    setPage("library");
  };
  const saveProfile = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name")).trim();
    const username = String(form.get("username")).trim().toLowerCase();
    const email = String(form.get("email")).trim().toLowerCase();
    const dob = String(form.get("dob") || "");
    const bio = String(form.get("bio") || "")
      .trim()
      .slice(0, 240);
    const favoriteGenre = String(form.get("favoriteGenre") || "");
    if (!/^[a-z0-9][a-z0-9._]{2,19}$/.test(username))
      return note(
        "Username must be 3–20 letters, numbers, dots, or underscores.",
      );
    if (
      !features.auth &&
      users.some(
        (account) =>
          account.id !== user.id && account.username.toLowerCase() === username,
      )
    )
      return note("That username is already taken. Choose another one.");
    if (
      !features.auth &&
      users.some(
        (account) =>
          account.id !== user.id && account.email.toLowerCase() === email,
      )
    )
      return note("That email is already used by another account.");
    if (dob && dob > new Date().toISOString().slice(0, 10))
      return note("Date of birth cannot be in the future.");
    let updated = { ...user, name, username, email, dob, bio, favoriteGenre };
    if (features.auth) {
      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "profile", name, username, email, dob, bio, favoriteGenre }),
        });
        const result = await response.json();
        if (!response.ok) return note(result.error || "Profile could not be saved.");
        updated = { ...result.user, avatar: user.avatar };
      } catch {
        return note("Hosted profile storage is unavailable.");
      }
    }
    setUser(updated);
    setUsers((accounts) =>
      accounts.map((account) => (account.id === user.id ? updated : account)),
    );
    note("Profile saved.");
  };
  const changeProfilePhoto = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/"))
      return note("Choose a JPG, PNG, or WebP image.");
    if (file.size > 8 * 1024 * 1024)
      return note("Choose an image smaller than 8 MB.");
    try {
      const image = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 320;
      const context = canvas.getContext("2d");
      const side = Math.min(image.width, image.height);
      context.drawImage(
        image,
        (image.width - side) / 2,
        (image.height - side) / 2,
        side,
        side,
        0,
        0,
        320,
        320,
      );
      image.close();
      const avatar = canvas.toDataURL("image/jpeg", 0.82);
      const updated = { ...user, avatar };
      setUser(updated);
      setUsers((accounts) =>
        accounts.map((account) => (account.id === user.id ? updated : account)),
      );
      note("Profile photo updated.");
    } catch {
      note("That image could not be opened. Try another one.");
    }
  };
  const removeProfilePhoto = () => {
    const updated = { ...user, avatar: "" };
    setUser(updated);
    setUsers((accounts) =>
      accounts.map((account) => (account.id === user.id ? updated : account)),
    );
    note("Profile photo removed.");
  };
  const changePreference = (key, value) =>
    setPreferences((current) => ({ ...current, [key]: value }));
  const logout = async () => {
    leave();
    if (features.auth) await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    }).catch(() => {});
    setUser(null);
    audio.current?.pause();
  };
  const like = (t) => {
    const next = {
      ...likes,
      [user.id]: myLikes.includes(t.id)
        ? myLikes.filter((id) => id !== t.id)
        : [...myLikes, t.id],
    };
    setLikes(next);
  };
  const createList = (e) => {
    e.preventDefault();
    if (!newList.trim()) return;
    setPlaylists({
      ...playlists,
      [user.id]: [
        ...myLists,
        { id: crypto.randomUUID(), name: newList.trim(), trackIds: [] },
      ],
    });
    setNewList("");
    note("Playlist created.");
  };
  const addList = (pl, id) =>
    setPlaylists({
      ...playlists,
      [user.id]: myLists.map((x) =>
        x.id === pl
          ? {
              ...x,
              trackIds: x.trackIds.includes(id)
                ? x.trackIds
                : [...x.trackIds, id],
            }
          : x,
      ),
    });
  const uploadSong = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const hostedUrls = [];
    setBusy(true);
    try {
      let r, data;
      if (import.meta.env.PROD) {
        const fields = new FormData(form);
        const audioFile = fields.get("audio");
        const coverFile = fields.get("cover");
        const audioBlob = await uploadHostedFile(audioFile, "audio");
        hostedUrls.push(audioBlob.url);
        const coverBlob = await uploadHostedFile(coverFile, "artwork");
        hostedUrls.push(coverBlob.url);
        r = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: fields.get("title"),
            artist: fields.get("artist"),
            genre: fields.get("genre"),
            audioUrl: audioBlob.url,
            coverUrl: coverBlob.url,
          }),
        });
        data = await r.json();
        if (!r.ok) throw Error(data.error);
        hostedUrls.length = 0;
      } else {
        r = await fetch("/api/tracks", {
          method: "POST",
          body: new FormData(form),
        });
        data = await r.json();
      }
      if (!r.ok) throw Error(data.error);
      await load();
      setUpload(false);
      note(import.meta.env.PROD ? "MP3 added to the shared library." : "MP3 added to the local library.");
    } catch (e2) {
      if (hostedUrls.length)
        await fetch("/api/blob-upload", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: hostedUrls }),
        }).catch(() => {});
      note(e2.message);
    } finally {
      setBusy(false);
    }
  };
  const uploadFolder = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const songs = Array.from(form.elements.namedItem("audio").files).filter(
      (file) => file.name.toLowerCase().endsWith(".mp3"),
    );
    if (!songs.length) return note("The selected folder has no MP3 files.");
    if (songs.length > 200)
      return note("Choose a folder with no more than 200 MP3 files.");
    const formData = new FormData();
    songs.forEach((file) => formData.append("audio", file, file.name));
    formData.append("cover", form.elements.namedItem("cover").files[0]);
    formData.append("artist", form.elements.namedItem("artist").value);
    formData.append("genre", form.elements.namedItem("genre").value);
    const hostedUrls = [];
    setBusy(true);
    try {
      let r, data;
      if (import.meta.env.PROD) {
        const coverBlob = await uploadHostedFile(
          form.elements.namedItem("cover").files[0],
          "artwork",
        );
        hostedUrls.push(coverBlob.url);
        const artist = String(form.elements.namedItem("artist").value).trim() || "Unknown artist";
        const genre = String(form.elements.namedItem("genre").value).trim() || "Uncategorized";
        const imported = [];
        for (let index = 0; index < songs.length; index += 4) {
          const group = songs.slice(index, index + 4);
          const results = await Promise.allSettled(group.map((file) => uploadHostedFile(file, "audio")));
          results.forEach((result) => {
            if (result.status === "fulfilled") hostedUrls.push(result.value.url);
          });
          const failedUpload = results.find((result) => result.status === "rejected");
          if (failedUpload) throw failedUpload.reason;
          const blobs = results.map((result) => result.value);
          blobs.forEach((blob, offset) => {
            const file = group[offset];
            const title = file.name
              .replace(/\.[^.]+$/, "")
              .replace(/[._-]+/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            imported.push({ title: title || "Untitled track", artist, genre, audioUrl: blob.url, coverUrl: coverBlob.url });
          });
        }
        r = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: imported }),
        });
        data = await r.json();
        if (!r.ok) throw Error(data.error);
        hostedUrls.length = 0;
      } else {
        r = await fetch("/api/tracks/bulk", {
          method: "POST",
          body: formData,
        });
        data = await r.json();
      }
      if (!r.ok) throw Error(data.error);
      await load();
      setUpload(false);
      note(`${data.length} MP3 tracks added to the ${import.meta.env.PROD ? "shared" : "local"} library.`);
    } catch (e2) {
      if (hostedUrls.length)
        await fetch("/api/blob-upload", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: hostedUrls }),
        }).catch(() => {});
      note(e2.message);
    } finally {
      setBusy(false);
    }
  };
  const removeTrack = async (t) => {
    if (confirm(`Remove “${t.title}” and its MP3?`)) {
      await fetch(`/api/tracks/${t.id}`, { method: "DELETE" });
      load();
    }
  };
  const removeUser = async (id) => {
    if (!confirm("Remove this listener account? This cannot be undone.")) return;
    if (features.auth) {
      const response = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) return note("That account could not be removed.");
    }
    const next = users.filter((x) => x.id !== id);
    setUsers(next);
  };
  const filtered = useMemo(
      () =>
        tracks.filter(
          (t) =>
            `${t.title} ${t.artist} ${t.genre}`
              .toLowerCase()
              .includes(search.toLowerCase()) &&
            (genre === "All" || t.genre === genre),
        ),
      [tracks, search, genre],
    ),
    genres = useMemo(
      () => ["All", ...new Set(tracks.map((x) => x.genre))],
      [tracks],
    );
  if (!user)
    return (
      <Auth
        mode={auth}
        setMode={setAuth}
        submit={authSubmit}
        error={authError}
        hostedAuth={features.auth}
        adminConfigured={features.adminConfigured}
        checking={!featuresChecked}
      />
    );
  const nav = [
    ["library", "▤", "My Library"],
    ["profile", "♙", "Profile"],
    ["liked", "♡", "Liked tracks"],
    ["discover", "⌕", "Discover"],
    ["jam", "◉", "Jam rooms"],
    ["playlists", "▧", "Playlists"],
    ["settings", "⚙", "Settings"],
    ...(isAdmin ? [["admin", "◈", "Admin studio"]] : []),
  ];
  return (
    <div
      className={`app-shell theme-${preferences.theme}${preferences.compactRows ? " compact-rows" : ""}${preferences.reduceMotion ? " reduce-motion" : ""}`}
      style={{
        "--lime": ACCENTS[preferences.accent]?.[0] || ACCENTS.lime[0],
        "--lime-dark": ACCENTS[preferences.accent]?.[1] || ACCENTS.lime[1],
      }}
    >
      <aside className="sidebar">
        <Brand onClick={() => setPage("library")} />
        <span className="side-label">YOUR SPACE</span>
        <nav>
          {nav.map(([id, ico, label]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => {
                setPage(id);
                setSelected(null);
              }}
            >
              <i>{ico}</i>
              {label}
              {id === "jam" && jam && <b className="live-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-rule" />
        <span className="side-label">QUICK ACCESS</span>
        <button
          className="nav-item"
          onClick={() => {
            setPage("library");
            setSearch("");
          }}
        >
          <i>◷</i>Recently added
        </button>
        <button className="nav-item" onClick={() => setPage("liked")}>
          <i>♡</i>Liked tracks <small>{myLikes.length}</small>
        </button>
        <div className="sidebar-spacer" />
        <div className="sidebar-promo">
          <div className="promo-heading">
            <span className="promo-orb">◉</span>
            <strong>Music is better together.</strong>
          </div>
          <p>Start a room and listen in sync.</p>
          <button onClick={() => setPage("jam")}>Explore Jams →</button>
        </div>
        <div className="account-strip">
          <Avatar user={user} className="avatar" />
          <span className="account-meta">
            <b>{user.name}</b>
            <small>@{user.username}</small>
          </span>
          <button className="icon-button" onClick={logout} title="Sign out">
            ↪
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            WAVEHOUSE <i>/</i>{" "}
            {page === "jam"
              ? "JAM ROOMS"
              : page === "admin"
                ? "ADMIN STUDIO"
                : page === "discover"
                  ? "DISCOVER"
                  : page === "playlists"
                    ? "PLAYLISTS"
                    : page === "settings"
                      ? "SETTINGS"
                      : page === "profile"
                        ? "YOUR PROFILE"
                        : page === "liked"
                          ? "LIKED TRACKS"
                          : "YOUR LIBRARY"}
          </div>
          <label className="search-box">
            <span>⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your music"
            />
            <kbd>CTRL K</kbd>
          </label>
          <button
            className="top-avatar"
            title="Open profile"
            onClick={() => setPage("profile")}
          >
            <Avatar user={user} className="avatar" />
          </button>
        </header>
        <div className="page-content">
          {page === "library" && (
            <>
              <section className="welcome-panel">
                <div className="welcome-copy">
                  <span className="eyebrow">YOUR SOUND, YOUR RULES</span>
                  <h1>
                    Make room
                    <br />
                    for <em>good music.</em>
                  </h1>
                  <p>
                    A music space built around your collection, your people, and
                    the moments you share.
                  </p>
                  <button
                    className="btn btn-lime"
                    onClick={() => tracks[0] && play(tracks[0])}
                  >
                    ▶ &nbsp; Play something
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setPage("jam")}
                  >
                    ◉ &nbsp; Join a Jam
                  </button>
                </div>
                <div className="disc-art">
                  <div className="orbit orbit1" />
                  <div className="orbit orbit2" />
                  <div className="vinyl">♫</div>
                  <span className="disc-note">♪</span>
                  <label>
                    LISTEN
                    <br />
                    CLOSER
                  </label>
                </div>
                <span className="welcome-count">
                  01 <i>/</i> 04
                </span>
              </section>
              {filtered[0] && (
                <FeaturedTrack track={filtered[0]} onPlay={play} />
              )}
              <div className="section-title">
                <div>
                  <span className="eyebrow">PICK UP THE RHYTHM</span>
                  <h2>
                    Your collection <small>{tracks.length} tracks</small>
                  </h2>
                </div>
                {isAdmin && (
                  features.uploads ? (
                    <button className="btn btn-lime" onClick={() => setUpload(true)}>
                      ＋ Upload MP3
                    </button>
                  ) : (
                    <span className="deployment-note">MP3 uploads need the music server</span>
                  )
                )}
              </div>
              <TrackTable
                tracks={filtered}
                likes={myLikes}
                onPlay={play}
                onLike={like}
                onAdd={addJam}
                inJam={Boolean(jam)}
                admin={isAdmin}
                onDelete={removeTrack}
                onAddList={addList}
                lists={myLists}
              />
            </>
          )}
          {page === "profile" && (
            <ProfileForm
              user={user}
              onSave={saveProfile}
              onPhoto={changeProfilePhoto}
              onRemovePhoto={removeProfilePhoto}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              preferences={preferences}
              onChange={changePreference}
              onReset={() => {
                setPreferences({ ...DEFAULT_PREFERENCES });
                note("Settings restored to defaults.");
              }}
            />
          )}
          {page === "liked" && (
            <>
              <Intro
                label="YOUR PERSONAL LIBRARY"
                title="Liked tracks"
                text="The songs you want to come back to."
              />
              <TrackTable
                tracks={tracks.filter((t) => myLikes.includes(t.id))}
                likes={myLikes}
                onPlay={play}
                onLike={like}
                onAdd={addJam}
                inJam={Boolean(jam)}
                admin={isAdmin}
                onDelete={removeTrack}
                onAddList={addList}
                lists={myLists}
              />
            </>
          )}
          {page === "discover" && (
            <>
              <Intro
                label="FIND YOUR NEXT REPEAT"
                title="Discover"
                text="Explore the music in your shared local library."
              />
              <div className="chips">
                {genres.map((g) => (
                  <button
                    key={g}
                    className={genre === g ? "chosen" : ""}
                    onClick={() => setGenre(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <TrackTable
                tracks={filtered}
                likes={myLikes}
                onPlay={play}
                onLike={like}
                onAdd={addJam}
                inJam={Boolean(jam)}
                admin={isAdmin}
                onDelete={removeTrack}
                onAddList={addList}
                lists={myLists}
              />
            </>
          )}
          {page === "jam" && (
            <JamView
              jam={jam}
              host={host}
              code={code}
              setCode={setCode}
              create={create}
              join={join}
              leave={leave}
              busy={roomBusy}
              tracks={tracks}
              add={addJam}
              control={control}
              emit={emit}
              note={note}
              available={features.jams}
            />
          )}
          {page === "playlists" && (
            <>
              <Intro
                label="YOUR PERSONAL MIXES"
                title="Playlists"
                text="Make collections for every mood, moment, and person."
              />
              <form className="new-playlist" onSubmit={createList}>
                <input
                  value={newList}
                  onChange={(e) => setNewList(e.target.value)}
                  placeholder="Name a new playlist"
                  required
                />
                <button className="btn btn-lime">＋ Create playlist</button>
              </form>
              {selected ? (
                <>
                  <button
                    className="text-link"
                    onClick={() => setSelected(null)}
                  >
                    ← All playlists
                  </button>
                  <h2>{selected.name}</h2>
                  <TrackTable
                    tracks={tracks.filter((t) =>
                      selected.trackIds.includes(t.id),
                    )}
                    likes={myLikes}
                    onPlay={play}
                    onLike={like}
                    onAdd={addJam}
                    inJam={Boolean(jam)}
                    admin={isAdmin}
                    onDelete={removeTrack}
                    onAddList={addList}
                    lists={myLists}
                  />
                </>
              ) : (
                <div className="playlist-grid">
                  {myLists.map((pl) => (
                    <button
                      className="playlist-card"
                      key={pl.id}
                      onClick={() => setSelected(pl)}
                    >
                      <span>▧</span>
                      <b>{pl.name}</b>
                      <small>{pl.trackIds.length} tracks</small>
                    </button>
                  ))}
                </div>
              )}
              {!myLists.length && (
                <Empty
                  title="No playlists yet"
                  text="Create a playlist above, then add tracks from your library."
                />
              )}
            </>
          )}
          {page === "admin" && isAdmin && (
            <Admin
              users={users}
              tracks={tracks}
              backendAvailable={features.uploads}
              upload={() => setUpload(true)}
              removeTrack={removeTrack}
              removeUser={removeUser}
            />
          )}
        </div>
      </main>
      {jam && (
        <div className="jam-floating">
          <i className="live-dot" /> IN JAM <b>{jam.code}</b>
          <button onClick={() => setPage("jam")}>Open room</button>
        </div>
      )}
      <footer className="player">
        <div className="playing-track">
          {track || jamTrack ? (
            <Cover track={track || jamTrack} />
          ) : (
            <div className="cover empty-cover">♫</div>
          )}
          <span>
            <b>
              {track?.title || jamTrack?.title || "Your next favorite track"}
            </b>
            <small>
              {track?.artist ||
                jamTrack?.artist ||
                "Add an MP3 to your library"}
            </small>
          </span>
          <button
            className={`player-like ${myLikes.includes((track || jamTrack)?.id) ? "liked" : ""}`}
            title="Like track"
            onClick={() => {
              const t = track || jamTrack;
              if (t) like(t);
            }}
          >
            ♡
          </button>
        </div>
        <div className="player-center">
          <div className="player-buttons">
            <button onClick={() => skip(-1)} disabled={jam && !host}>
              |◀
            </button>
            <button
              className="play-toggle"
              onClick={toggle}
              disabled={jam && !host}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button onClick={() => skip(1)} disabled={jam && !host}>
              ▶|
            </button>
          </div>
          <div className="seek">
            <small>{time(position)}</small>
            <input
              type="range"
              min="0"
              max={duration || 1}
              step=".1"
              value={Math.min(position, duration || 1)}
              onChange={(e) => {
                setPosition(+e.target.value);
                if (jam) {
                  if (host) control("seek", jam.trackId, +e.target.value);
                } else audio.current.currentTime = +e.target.value;
              }}
              disabled={(!track && !jamTrack) || (jam && !host)}
            />
            <small>{time(duration)}</small>
          </div>
        </div>
        <div className="player-extra">
          <small>{jam && !host ? "HOST IS PLAYING" : "PLAYBACK"}</small>
          <button onClick={() => setQueueOpen(!queueOpen)}>☷ Queue</button>
          <span>◖</span>
          <input
            type="range"
            min="0"
            max="1"
            step=".01"
            value={volume}
            onChange={(e) => setVolume(+e.target.value)}
          />
        </div>
      </footer>
      {queueOpen && (
        <aside className="queue-drawer">
          <div className="section-title">
            <h2>Up next</h2>
            <button className="icon-button" onClick={() => setQueueOpen(false)}>
              ×
            </button>
          </div>
          {(jam?.queue || queue).map((t, i) => (
            <div className="queue-item" key={`${t.id}-${i}`}>
              <Cover track={t} />
              <span>
                <b>{t.title}</b>
                <small>{t.artist}</small>
              </span>
              <button
                onClick={() =>
                  jam
                    ? emit("room:queue:remove", {
                        code: jam.code,
                        index: i,
                      }).catch((e) => note(e.message))
                    : play(t)
                }
              >
                {jam ? "×" : "▶"}
              </button>
            </div>
          ))}
        </aside>
      )}
      {upload && (
        <UploadModal
          busy={busy}
          hosted={features.uploads}
          close={() => setUpload(false)}
          submit={uploadSong}
          submitFolder={uploadFolder}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      <audio
        ref={audio}
        preload="metadata"
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (jam && host) control("next");
          else if (!jam && preferences.autoplayNext) skip(1);
        }}
      />
    </div>
  );
}
function Brand({ onClick }) {
  return (
    <a className="brand" onClick={onClick} aria-label="Wavehouse home">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        wavehouse<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
function Avatar({ user, className = "avatar" }) {
  return (
    <span className={`${className} avatar-photo`} aria-label={user.name}>
      {user.avatar ? <img src={user.avatar} alt="" /> : initials(user.name)}
    </span>
  );
}
function Auth({ mode, setMode, submit, error, hostedAuth, adminConfigured, checking }) {
  return (
    <div className="auth">
      <section className="auth-art">
        <Brand />
        <div className="auth-graphic">
          <div className="auth-vinyl">♫</div>
          <i />
          <i />
          <b>
            SOUND IS A<br />
            <em>SHARED LANGUAGE.</em>
          </b>
        </div>
        <p>LISTEN DEEPER. &nbsp; CONNECT CLOSER.</p>
      </section>
      <section className="auth-side">
        <div className="auth-box">
          <span className="eyebrow">A SPACE FOR YOUR SOUND</span>
          <h1>{mode === "login" ? "Welcome back." : "Find your people."}</h1>
          <p>
            {mode === "login"
              ? "Your music and rooms are waiting."
              : hostedAuth
                ? "Create your Wavehouse account and start your music space."
                : "Create a local account and start your music space."}
          </p>
          <div className="auth-tabs">
            <button
              className={mode === "login" ? "selected" : ""}
              onClick={() => setMode("login")}
            >
              Sign in
            </button>
            <button
              className={mode === "signup" ? "selected" : ""}
              onClick={() => setMode("signup")}
            >
              Create account
            </button>
          </div>
          <form onSubmit={submit}>
            {mode === "signup" && (
              <>
                <label>
                  Your name
                  <input
                    name="name"
                    placeholder="How should we call you?"
                    minLength="2"
                    required
                  />
                </label>
                <label>
                  Choose a unique username
                  <input
                    name="username"
                    placeholder="e.g. alex.m"
                    pattern="[a-zA-Z0-9][a-zA-Z0-9._]{2,19}"
                    minLength="3"
                    maxLength="20"
                    autoComplete="username"
                    required
                  />
                </label>
              </>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
              placeholder={hostedAuth ? "At least 8 characters" : "At least 6 characters"}
              minLength={hostedAuth ? "8" : "6"}
                required
              />
            </label>
            <button className="btn btn-lime auth-submit" disabled={checking}>
              {checking
                ? "Connecting…"
                : mode === "login"
                  ? "Sign in to Wavehouse →"
                  : "Create my account →"}
            </button>
          </form>
          {error && <p className="auth-error">{error}</p>}
          {!hostedAuth && import.meta.env.DEV && (
            <div className="demo">
              <b>Try the demo</b>
              <small>Admin · admin@melodify.com / admin123</small>
              <small>Listener · user@melodify.com / user123</small>
            </div>
          )}
          <small className="fine-print">
            {hostedAuth
              ? `Wavehouse sign-in is protected online. ${adminConfigured ? "Use the administrator account configured for this deployment." : "The administrator account still needs setup in Vercel."}`
              : "Accounts are stored in Local Storage on this browser."}
          </small>
        </div>
      </section>
    </div>
  );
}
function ProfileForm({ user, onSave, onPhoto, onRemovePhoto }) {
  const maxDate = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Intro
        label="YOUR ACCOUNT, YOUR DETAILS"
        title="Profile"
        text="Keep your listener identity and personal details up to date."
      />
      <div className="profile-layout">
        <section className="profile-banner">
          <div className="profile-banner-glow" />
          <Avatar user={user} className="profile-avatar" />
          <label className="profile-photo-control">
            <span>
              Change profile photo
              <small>Square crop · saved on this device</small>
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                onPhoto(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          {user.avatar && (
            <button
              className="remove-photo"
              type="button"
              onClick={onRemovePhoto}
            >
              Remove photo
            </button>
          )}
          <span className="eyebrow">
            {user.role === "admin" ? "ADMIN ACCOUNT" : "WAVEHOUSE LISTENER"}
          </span>
          <h2>{user.name}</h2>
          <p>@{user.username}</p>
          <div className="profile-banner-rule" />
          <span className="profile-email-preview">{user.email}</span>
          <span className="profile-banner-note">YOUR SPACE. YOUR SOUND.</span>
        </section>
        <form className="profile-form" onSubmit={onSave}>
          <div className="profile-form-heading">
            <div>
              <span className="eyebrow">PERSONAL INFORMATION</span>
              <h2>About you</h2>
            </div>
            <span className="profile-local-tag">SAVED ON THIS DEVICE</span>
          </div>
          <div className="profile-fields">
            <label>
              Full name
              <input
                name="name"
                defaultValue={user.name}
                autoComplete="name"
                minLength="2"
                maxLength="60"
                required
              />
            </label>
            <label>
              Unique username
              <input
                name="username"
                defaultValue={user.username}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._]{2,19}"
                minLength="3"
                maxLength="20"
                autoComplete="username"
                required
              />
              <small>3–20 letters, numbers, dots, or underscores.</small>
            </label>
            <label>
              Email address
              <input
                name="email"
                type="email"
                defaultValue={user.email}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Date of birth
              <input
                name="dob"
                type="date"
                defaultValue={user.dob || ""}
                max={maxDate}
              />
              <small>Optional. Used only for your local profile.</small>
            </label>
            <label className="profile-wide">
              Short bio
              <textarea
                name="bio"
                defaultValue={user.bio || ""}
                maxLength="240"
                rows="3"
                placeholder="A little about your music taste…"
              />
            </label>
            <label>
              Favorite genre
              <select
                name="favoriteGenre"
                defaultValue={user.favoriteGenre || ""}
              >
                <option value="">Choose a genre</option>
                <option>Pop</option>
                <option>Rock</option>
                <option>Classical</option>
                <option>Jazz</option>
                <option>Electronic</option>
                <option>Hip-Hop</option>
                <option>J-Pop</option>
                <option>Other</option>
              </select>
            </label>
          </div>
          <div className="profile-form-footer">
            <span>Changes stay in this browser’s Local Storage.</span>
            <button className="btn btn-lime">Save profile changes →</button>
          </div>
        </form>
      </div>
    </>
  );
}
function SettingsPage({ preferences, onChange, onReset }) {
  return (
    <>
      <Intro
        label="MAKE IT FEEL LIKE YOUR SPACE"
        title="Settings"
        text="Choose how Wavehouse looks and how your player behaves."
      />
      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-heading">
            <span className="eyebrow">APPEARANCE</span>
            <h2>Your look</h2>
            <p>Personalize the colors and density of your listening space.</p>
          </div>
          <div className="settings-row setting-theme-row">
            <div>
              <b>Color theme</b>
              <small>Pick a light or dark workspace.</small>
            </div>
            <div
              className="theme-options"
              role="group"
              aria-label="Color theme"
            >
              {[
                ["dark", "◐", "Dark"],
                ["light", "☼", "Light"],
              ].map(([value, icon, label]) => (
                <button
                  key={value}
                  className={preferences.theme === value ? "selected" : ""}
                  onClick={() => onChange("theme", value)}
                >
                  <span>{icon}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div>
              <b>Accent color</b>
              <small>Used for highlights and player controls.</small>
            </div>
            <div
              className="accent-options"
              role="group"
              aria-label="Accent color"
            >
              {Object.entries({
                lime: "#cef46b",
                violet: "#c5a6ff",
                coral: "#ff9b83",
                blue: "#39d9ff",
              }).map(([name, color]) => (
                <button
                  key={name}
                  className={preferences.accent === name ? "selected" : ""}
                  style={{ "--swatch": color }}
                  aria-label={`${name} accent`}
                  aria-pressed={preferences.accent === name}
                  onClick={() => onChange("accent", name)}
                />
              ))}
            </div>
          </div>
          <ToggleSetting
            title="Compact track list"
            description="Show more songs in the library at once."
            checked={preferences.compactRows}
            onChange={(value) => onChange("compactRows", value)}
          />
          <ToggleSetting
            title="Reduce motion"
            description="Turn off decorative transitions and animations."
            checked={preferences.reduceMotion}
            onChange={(value) => onChange("reduceMotion", value)}
          />
        </section>
        <section className="settings-card">
          <div className="settings-heading">
            <span className="eyebrow">PLAYBACK</span>
            <h2>Your player</h2>
            <p>Control what happens when a track finishes.</p>
          </div>
          <ToggleSetting
            title="Autoplay next track"
            description="Continue to the next song when the current one ends."
            checked={preferences.autoplayNext}
            onChange={(value) => onChange("autoplayNext", value)}
          />
        </section>
        <div className="settings-footer">
          <span>Settings are saved to this account in this browser.</span>
          <button className="btn btn-outline" onClick={onReset}>
            Restore defaults
          </button>
        </div>
      </div>
    </>
  );
}
function ToggleSetting({ title, description, checked, onChange }) {
  return (
    <label className="settings-row setting-toggle-row">
      <span>
        <b>{title}</b>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
function FeaturedTrack({ track, onPlay }) {
  return (
    <section className="featured-track" aria-label="Featured song">
      {track.coverUrl ? (
        <img
          className="featured-track-art"
          src={track.coverUrl}
          alt={`${track.title} cover artwork`}
        />
      ) : (
        <div
          className="featured-track-art featured-track-placeholder"
          aria-hidden="true"
        >
          ♫
        </div>
      )}
      <div className="featured-track-copy">
        <span className="eyebrow">ON YOUR PLAYLIST · FEATURED TRACK</span>
        <h2>{track.title}</h2>
        <p>{track.artist}</p>
        <div className="featured-track-details">
          <span>{track.genre || "Uncategorized"}</span>
          {track.duration && <span>{track.duration}</span>}
          {track.isSample && <span>DEMO TRACK</span>}
        </div>
      </div>
      <button
        className="featured-track-play"
        onClick={() => onPlay(track)}
        aria-label={`Play ${track.title}`}
      >
        ▶ <span>Play track</span>
      </button>
    </section>
  );
}
function Intro({ label, title, text }) {
  return (
    <section className="page-intro">
      <span className="eyebrow">{label}</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  );
}
function Cover({ track }) {
  return track?.coverUrl ? (
    <img className="cover" src={track.coverUrl} alt="" />
  ) : (
    <div className="cover empty-cover">♫</div>
  );
}
function TrackTable({
  tracks,
  likes,
  onPlay,
  onLike,
  onAdd,
  inJam,
  admin,
  onDelete,
  onAddList,
  lists,
}) {
  if (!tracks.length)
    return (
      <Empty
        title="Nothing in the library yet"
        text="An administrator can upload MP3 tracks from Admin studio."
      />
    );
  return (
    <div className="track-table">
      <div className="track-head">
        <span>#</span>
        <span>TRACK</span>
        <span>GENRE</span>
        <span>PLAYS</span>
        <span>ACTIONS</span>
      </div>
      {tracks.map((t, i) => (
        <div className="track-row" key={t.id}>
          <span className="track-number">{String(i + 1).padStart(2, "0")}</span>
          <button className="track-main" onClick={() => onPlay(t)}>
            <Cover track={t} />
            <span>
              <b>{t.title}</b>
              <small>{t.artist}</small>
            </span>
          </button>
          <span className="genre">{t.genre}</span>
          <span className="plays">{t.plays || 0}</span>
          <div className="track-actions">
            <button
              className={likes.includes(t.id) ? "liked" : ""}
              title="Like track"
              onClick={() => onLike(t)}
            >
              {likes.includes(t.id) ? "♥" : "♡"}
            </button>
            {lists?.length > 0 && (
              <select
                title="Add to playlist"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) onAddList(e.target.value, t.id);
                  e.target.value = "";
                }}
              >
                <option value="">＋</option>
                {lists.map((pl) => (
                  <option value={pl.id} key={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
            )}
            {inJam && (
              <button title="Add to shared queue" onClick={() => onAdd(t)}>
                ↗
              </button>
            )}
            <button className="row-play" onClick={() => onPlay(t)} title="Play">
              ▶
            </button>
            {admin && (
              <button
                className="remove"
                onClick={() => onDelete(t)}
                title="Remove"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function Empty({ title, text }) {
  return (
    <div className="empty-state">
      <span>♫</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function JamView({
  jam,
  host,
  code,
  setCode,
  create,
  join,
  leave,
  busy,
  tracks,
  add,
  control,
  emit,
  note,
  available,
}) {
  if (!available)
    return (
      <>
        <Intro
          label="LISTEN TOGETHER, WHEREVER YOU ARE"
          title="Jam rooms"
          text="Create a room, invite friends, and keep playback in sync."
        />
        <div className="deployment-message">
          <b>Jam rooms are not configured yet</b>
          <p>Connect Redis and set the hosted Wavehouse environment variables in Vercel, then redeploy to enable shared rooms and online MP3 uploads.</p>
        </div>
      </>
    );
  if (!jam)
    return (
      <>
        <Intro
          label="LISTEN TOGETHER, WHEREVER YOU ARE"
          title="Jam rooms"
          text="Start a room for your group or join friends with a six character code."
        />
        <div className="jam-options">
          <article className="jam-card featured">
            <small>01 / HOST</small>
            <span className="jam-icon">◉</span>
            <h2>Start a Jam</h2>
            <p>
              Become the host. Control playback and invite people into the room.
            </p>
            <button className="btn btn-lime" disabled={busy} onClick={create}>
              {busy ? "Connecting…" : "＋ Create a room"}
            </button>
            <i>♫</i>
          </article>
          <article className="jam-card">
            <small>02 / LISTENER</small>
            <span className="jam-icon join-icon">↗</span>
            <h2>Join your people</h2>
            <p>Enter the room code from your host and listen in sync.</p>
            <form onSubmit={join}>
              <input
                className="room-code-input"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.toUpperCase().slice(0, 6))
                }
                placeholder="ABC123"
                maxLength="6"
                required
              />
              <button className="btn btn-outline" disabled={busy}>
                {busy ? "Joining…" : "Join room →"}
              </button>
            </form>
          </article>
        </div>
        <div className="how">
          <b>HOW IT WORKS</b>
          <span>
            01 Host creates a room <i>→</i> 02 Share the code <i>→</i> 03 Add
            tracks <i>→</i> 04 Listen in sync
          </span>
        </div>
      </>
    );
  return (
    <>
      <section className="room-hero">
        <div>
          <span className="eyebrow">
            <i className="live-dot" /> LIVE LISTENING ROOM
          </span>
          <h1>{host ? "You’re hosting." : `${jam.hostName} is hosting.`}</h1>
          <p>
            {host
              ? "You control playback for everyone in this room."
              : "Add music to the shared queue. The host controls playback."}
          </p>
          <div className="code-box">
            <small>ROOM CODE</small>
            <b>{jam.code}</b>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(jam.code);
                note("Room code copied.");
              }}
            >
              Copy code
            </button>
          </div>
        </div>
        <div className="wave-art">
          <div>
            {Array.from({ length: 29 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <b>
            IN SYNC
            <br />
            TOGETHER
          </b>
        </div>
      </section>
      <div className="room-columns">
        <section>
          <div className="section-title">
            <div>
              <span className="eyebrow">THE NEXT UP</span>
              <h2>
                Shared queue <small>{jam.queue.length} tracks</small>
              </h2>
            </div>
            <button className="text-link" onClick={leave}>
              Leave room ×
            </button>
          </div>
          {jam.queue.length ? (
            <div className="queue-list">
              {jam.queue.map((t, i) => (
                <div
                  className={`queue-row ${t.id === jam.trackId ? "playing-row" : ""}`}
                  key={`${t.id}-${i}`}
                >
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <Cover track={t} />
                  <span>
                    <b>{t.title}</b>
                    <small>{t.artist}</small>
                  </span>
                  {t.id === jam.trackId && (
                    <small className="live-label">
                      {jam.playing ? "● LIVE" : "PAUSED"}
                    </small>
                  )}
                  {host && (
                    <button onClick={() => control("play", t.id, 0)}>▶</button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="The queue is waiting"
              text="Add tracks below and they’ll appear here."
            />
          )}
          <h3 className="subheading">Add to the queue</h3>
          {tracks.slice(0, 6).map((t) => (
            <div className="add-row" key={t.id}>
              <Cover track={t} />
              <span>
                <b>{t.title}</b>
                <small>{t.artist}</small>
              </span>
              <button onClick={() => add(t)}>＋</button>
            </div>
          ))}
        </section>
        <aside className="people-card">
          <div className="section-title">
            <div>
              <span className="eyebrow">IN THE ROOM</span>
              <h2>
                People <small>{jam.participants.length}</small>
              </h2>
            </div>
            <i className="live-dot" />
          </div>
          {jam.participants.map((p, i) => (
            <div className="person" key={p.socketId || `${p.id}-${i}`}>
              <span className="avatar">{initials(p.name)}</span>
              <span>
                <b>{p.name}</b>
                <small>{p.id === jam.hostId ? "HOST" : "LISTENER"}</small>
              </span>
              {p.id === jam.hostId && <strong>♛</strong>}
            </div>
          ))}
          <div className="host-explain">
            <b>♛ HOST CONTROLS</b>
            <p>
              {host
                ? "Use the player below to play, pause, seek, and skip."
                : "Only the host can change or seek the current track."}
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
function UploadModal({ busy, hosted, close, submit, submitFolder }) {
  const [mode, setMode] = useState("single");
  const [folderCount, setFolderCount] = useState(0);
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        className="modal upload-modal"
        onSubmit={mode === "single" ? submit : submitFolder}
      >
        <div className="section-title">
          <div>
            <span className="eyebrow">GROW YOUR SOUND</span>
            <h2>Upload an MP3</h2>
          </div>
          <button type="button" className="icon-button" onClick={close}>
            ×
          </button>
        </div>
        <div
          className="upload-mode-tabs"
          role="tablist"
          aria-label="Upload method"
        >
          <button
            type="button"
            className={mode === "single" ? "active" : ""}
            onClick={() => setMode("single")}
          >
            One song
          </button>
          <button
            type="button"
            className={mode === "folder" ? "active" : ""}
            onClick={() => setMode("folder")}
          >
            Many songs from a folder
          </button>
        </div>
        {mode === "single" ? (
          <>
            <p>
              {hosted
                ? "Add a track to the shared Wavehouse library. Audio and artwork use public file links, so anyone who has a link can open them."
                : "Your file stays in this computer’s local library and is served to Jam participants from this machine."}
            </p>
            <label className="file-pick">
              <span>↑</span>
              <b>Choose an MP3 file</b>
              <small>MP3 audio · max 100 MB</small>
              <input
                type="file"
                name="audio"
                accept="audio/mpeg,.mp3"
                required
              />
            </label>
            <div className="form-two">
              <label>
                Song title
                <input
                  name="title"
                  maxLength="100"
                  placeholder="Track title"
                  required
                />
              </label>
              <label>
                Artist
                <input
                  name="artist"
                  maxLength="100"
                  placeholder="Artist name"
                  required
                />
              </label>
            </div>
            <div className="form-two">
              <label>
                Genre
                <input
                  name="genre"
                  maxLength="40"
                  placeholder="e.g. Jazz"
                  required
                />
              </label>
              <label>
                Cover artwork <small>REQUIRED · JPG, PNG OR WEBP</small>
                <input
                  className="cover-pick"
                  type="file"
                  name="cover"
                  accept="image/png,image/jpeg,image/webp,.png,.jpg,.webp"
                  required
                />
              </label>
            </div>
          </>
        ) : (
          <>
            <p>
              Choose a folder. Each MP3 becomes a track named from its filename,
              with one shared cover image. You can set a default artist and
              genre for the imported tracks.
            </p>
            <label className="file-pick">
              <span>♫</span>
              <b>Choose a folder of MP3s</b>
              <small>
                {folderCount
                  ? `${folderCount} MP3 file${folderCount === 1 ? "" : "s"} selected`
                  : "MP3 files · up to 200 tracks · 100 MB per track"}
              </small>
              <input
                type="file"
                name="audio"
                accept="audio/mpeg,.mp3"
                multiple
                webkitdirectory=""
                directory=""
                required
                onChange={(event) =>
                  setFolderCount(
                    Array.from(event.target.files || []).filter((file) =>
                      file.name.toLowerCase().endsWith(".mp3"),
                    ).length,
                  )
                }
              />
            </label>
            <div className="form-two">
              <label>
                Default artist
                <input
                  name="artist"
                  maxLength="100"
                  placeholder="Unknown artist"
                />
              </label>
              <label>
                Default genre
                <input
                  name="genre"
                  maxLength="40"
                  placeholder="Uncategorized"
                />
              </label>
            </div>
            <label className="bulk-cover-label">
              Shared cover artwork <small>REQUIRED · JPG, PNG OR WEBP</small>
              <input
                className="cover-pick"
                type="file"
                name="cover"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.webp"
                required
              />
            </label>
          </>
        )}
        <div className="modal-buttons">
          <button type="button" className="btn btn-outline" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-lime" disabled={busy}>
            {busy
              ? "Uploading…"
              : mode === "single"
                ? "Save to library →"
                : "Import selected songs →"}
          </button>
        </div>
      </form>
    </div>
  );
}
function Admin({ users, tracks, upload, removeTrack, removeUser, backendAvailable }) {
  const plays = tracks.reduce((n, t) => n + (t.plays || 0), 0);
  return (
    <>
      <Intro
        label="CATALOG & COMMUNITY"
        title="Admin studio"
        text="Manage the shared music library and demo accounts."
      />
      <div className="stats">
        {[
          ["♫", "Library tracks", tracks.length],
          [
            "♙",
            "Listener accounts",
            users.filter((x) => x.role === "user").length,
          ],
          ["▷", "Total plays", plays.toLocaleString()],
          [
            "◈",
            "Admin accounts",
            users.filter((x) => x.role === "admin").length,
          ],
        ].map(([i, l, v]) => (
          <div key={l}>
            <i>{i}</i>
            <small>{l}</small>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <div className="section-title admin-title">
        <div>
          <span className="eyebrow">LIBRARY MANAGEMENT</span>
          <h2>Music catalog</h2>
        </div>
        {backendAvailable ? (
          <button className="btn btn-lime" onClick={upload}>＋ Upload MP3</button>
        ) : (
          <span className="deployment-note">MP3 uploads need the music server</span>
        )}
      </div>
      <TrackTable
        tracks={tracks}
        likes={[]}
        onPlay={() => {}}
        onLike={() => {}}
        onAdd={() => {}}
        admin
        onDelete={removeTrack}
      />
      <div className="section-title admin-title">
        <div>
          <span className="eyebrow">LOCAL ACCOUNTS</span>
          <h2>
            Listeners <small>{users.length}</small>
          </h2>
        </div>
      </div>
      <div className="users-table">
        {users.map((u) => (
          <div className="user-row" key={u.id}>
            <span className="avatar">{initials(u.name)}</span>
            <span>
              <b>{u.name}</b>
              <small>{u.email}</small>
            </span>
            <span className="genre">{u.role}</span>
            {u.role === "user" && (
              <button
                className="text-link remove"
                onClick={() => removeUser(u.id)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="admin-note">
        This educational demo stores its accounts in this browser’s Local
        Storage.
      </p>
      {!backendAvailable && <p className="admin-note">This Vercel preview includes sample tracks. Catalog management and uploaded MP3 storage require the music server.</p>}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
