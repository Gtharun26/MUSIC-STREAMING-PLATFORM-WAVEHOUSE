export default function handler(_req, res) {
  const storageReady = Boolean(process.env.REDIS_URL);
  const authReady = storageReady && Boolean(process.env.WAVEHOUSE_SESSION_SECRET?.length >= 32);
  const adminConfigured = Boolean(
    process.env.WAVEHOUSE_ADMIN_EMAIL && process.env.WAVEHOUSE_ADMIN_PASSWORD?.length >= 12,
  );
  const uploadsReady = authReady && Boolean(process.env.BLOB_READ_WRITE_TOKEN) && adminConfigured;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    catalog: storageReady,
    uploads: uploadsReady,
    jams: authReady,
    auth: authReady,
    adminConfigured,
  });
}
