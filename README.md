# Wavehouse music and listening rooms

## Start the app

1. Install Node.js (LTS).
2. Open a terminal in this project folder.
3. Run `npm install` once.
4. Run `npm run dev`.
5. Open the local address shown by Vite, usually `http://localhost:5173`.

The development command starts the React + Vite website and the local API/Jam server together.

## Try the local demo accounts

- Admin: `admin@melodify.com` / `admin123`
- Listener: `user@melodify.com` / `user123`

The local demo sign-in and accounts use that browser's Local Storage. Profiles, settings, personal likes, and playlists stay in Local Storage. The local Admin can upload single MP3s or import a folder with cover artwork from Admin studio. During local development, uploads are saved in `data/` on the computer running the app.

The starter library includes three locally bundled demo tracks with cover banners and track details. These tracks are released under CC0 1.0; see `STARTER-MUSIC-LICENSE.txt` for the source and license information. This demo does not include Spotify's catalog.

## Listen together on another device

For devices on the same Wi-Fi network, open the app from the other device using the host computer's local network address and port `5173` (for example, `http://192.168.x.x:5173`). Create a Jam, then share its room code. Both devices need access to the host computer while listening because its local server supplies the uploaded MP3s. Allow Node.js through the computer's private-network firewall if prompted.

Jam rooms and playback state live in server memory, so they reset if the server restarts. The music catalog and uploaded media are saved locally under `data/`.

## Hosted Vercel setup

The Vercel version uses Vercel Functions for the API and Socket.IO WebSocket endpoint, Vercel Blob for uploaded MP3s and artwork, and Upstash Redis for the shared catalog, accounts, and Jam room state.

Connect these environment variables to the Vercel project:

- `BLOB_READ_WRITE_TOKEN` — created when a **public** Vercel Blob store is connected. Uploaded songs and artwork are available to anyone with their Blob URL so Jam participants can play them.
- `REDIS_URL` — the Upstash Redis **TCP** connection URL (`rediss://...`), used by the shared catalog and room adapter.
- `WAVEHOUSE_SESSION_SECRET` — a random secret with at least 32 characters for signed, HTTP-only sign-in cookies.
- `WAVEHOUSE_ADMIN_EMAIL` and `WAVEHOUSE_ADMIN_PASSWORD` — hosted administrator credentials. Use a password with at least 12 characters. Optional: `WAVEHOUSE_ADMIN_NAME` and `WAVEHOUSE_ADMIN_USERNAME`.

After connecting the stores and adding the variables, redeploy the project. Signup and sign-in are validated by the hosted API; the profile and library preferences are still cached in Local Storage. The admin upload endpoints and Jam controls require a valid hosted session.

Vercel's WebSocket support is in beta. Hobby-plan connections close after five minutes, so the client reconnects and rejoins the active room. Jam state and participants are shared through Redis.

## Vercel preview

Without Blob, Redis, and the hosted session settings, the deployed preview still plays the bundled demo library but disables hosted MP3 uploads and Jam rooms. It explains which setup is missing instead of presenting broken controls.
"# MUSIC-STREAMING-PLATFORM-WAVEHOUSE" 
"# MUSIC-STREAMING-PLATFORM-WAVEHOUSE" 
"# MUSIC-STREAMING-PLATFORM-WAVEHOUSE" 
