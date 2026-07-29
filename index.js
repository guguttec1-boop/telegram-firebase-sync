const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");   // built‑in

// For Node < 18, install node-fetch. For Node 18+, you can remove this require.
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Validate environment variables ---
if (!process.env.FIREBASE_KEY || !process.env.FIREBASE_URL) {
  console.error("Missing FIREBASE_KEY or FIREBASE_URL");
  process.exit(1);
}

// --- Initialize Firebase ---
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});
const db = admin.database();

// --- Telegram Bot token (optional, needed for image URLs) ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
console.log("TOKEN FOUND:", !!BOT_TOKEN);
// --- In‑memory cache to reduce Firebase reads (expires after 1 minute) ---
const recentlySeenHashes = new Set();
setInterval(() => recentlySeenHashes.clear(), 60000);

// ------------------------------------------------------------
// Helper: strip emojis and markdown formatting from keys
// ------------------------------------------------------------
function cleanKey(str) {
  let cleaned = str.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
  cleaned = cleaned.replace(/\*\*/g, "").replace(/__/g, "").trim();
  return cleaned;
}

// ------------------------------------------------------------
// Helper: extract numeric price (first number with optional commas/dots)
// ------------------------------------------------------------
function extractPrice(raw) {
  const match = raw.match(/(\d+[\d,.]*\d+|\d+)/);
  if (!match) return "";
  return match[1].replace(/,/g, ""); // keep as string
}

// ------------------------------------------------------------
// Get a downloadable URL for a Telegram file (photo/video)
// ------------------------------------------------------------
async function getTelegramFileUrl(fileId) {
  if (!BOT_TOKEN) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.ok) {
      console.error("Telegram getFile error:", data.description);
      return null;
    }
    const filePath = data.result.file_path;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  } catch (err) {
    console.error("Failed to get file URL:", err.message);
    return null;
  }
}

// ------------------------------------------------------------
// Extract structured data (with multiline support)
// ------------------------------------------------------------
function extractDetails(text) {
  const data = {
    description: "",
    name: "",
    category: "",
    brand: "",
    type: "",
    price: "",
    condition: "",
    processor: "",
    display: "",
    ram: "",
    graphics: "",
    battery_life: "",
    life_features: "",
    best_for: "",
    telegram: "",
    memory: "",
    storage: "",
    location: "",
    website: "",
    phone: "",
  };

  const fieldMap = {
    name: "name",
    category: "category",
    brand: "brand",
    type: "type",
    price: "price",
    condition: "condition",
    processor: "processor",
    display: "display",
    ram: "ram",
    graphics: "graphics",
    "battery life": "battery_life",
    "life features": "life_features",
    "best for": "best_for",
    telegram: "telegram",
    memory: "memory",
    storage: "storage",
    location: "location",
    website: "website",
    "call us": "phone",
    phone: "phone",
    contact: "phone",
  };

  const lines = text.split("\n");
  const descriptionLines = [];
  let currentField = null;
  let currentValue = [];
  let foundFirstIdentity = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    let isField = false;
    let key = null;
    let value = "";

    if (separator !== -1) {
      const rawKey = trimmed.substring(0, separator).trim();
      const cleaned = cleanKey(rawKey).toLowerCase();
      const possibleValue = trimmed.substring(separator + 1).trim();
      if (fieldMap[cleaned]) {
        isField = true;
        key = fieldMap[cleaned];
        value = possibleValue;
      }
    }

    if (isField) {
      if (currentField) {
        data[currentField] = currentValue.join("\n").trim();
        currentValue = [];
      }
      currentField = key;
      if (value) currentValue.push(value);
      if (!foundFirstIdentity) foundFirstIdentity = true;
    } else {
      if (currentField) {
        currentValue.push(trimmed);
      } else {
        descriptionLines.push(trimmed);
      }
    }
  }

  if (currentField) {
    data[currentField] = currentValue.join("\n").trim();
  }

  data.description = descriptionLines.join("\n");

  // Price extraction
  if (data.price) {
    const numeric = extractPrice(data.price);
    if (numeric) data.price = numeric;
    else data.price = "";
  }

  // Storage → memory fallback
  if (data.storage && !data.memory) {
    data.memory = data.storage;
  }

  // Trim all fields
  for (const k of Object.keys(data)) {
    if (typeof data[k] === "string") data[k] = data[k].trim();
  }

  return data;
}

// ------------------------------------------------------------
// Compute a content hash for deduplication
// ------------------------------------------------------------
function computeContentHash(text, photoFileId, videoFileId) {
  const payload = [text || "", photoFileId || "", videoFileId || ""].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------
// Webhook endpoint
// ------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.channel_post;

    if (!msg) {
      console.log("Ignored update type:", Object.keys(update));
      return res.sendStatus(200);
    }

    const messageText = msg.text || msg.caption || "";

    // --- NEW: Skip if there is no text content ---
    if (!messageText) {
      console.log("⏩ Skipping: empty text/caption");
      return res.sendStatus(200);
    }

    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // --- Extract media file IDs (if any) ---
    let photoFileId = null;
    let videoFileId = null;
    if (msg.photo) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id;
    }
    if (msg.video) {
      videoFileId = msg.video.file_id;
    }

    // --- Content‑based deduplication ---
    const contentHash = computeContentHash(messageText, photoFileId, videoFileId);

    // Check in‑memory cache first
    if (recentlySeenHashes.has(contentHash)) {
      console.log(`⏩ Skipping duplicate content (hash ${contentHash.slice(0,8)})`);
      return res.sendStatus(200);
    }

    // Then check Firebase
    const hashRef = db.ref(`processed_hashes/${contentHash}`);
    const snapshot = await hashRef.once("value");
    if (snapshot.exists()) {
      console.log(`⏩ Content already processed (hash ${contentHash.slice(0,8)}) – skipping`);
      recentlySeenHashes.add(contentHash);
      return res.sendStatus(200);
    }

    // --- Not seen before – proceed with saving ---
    const details = extractDetails(messageText);

    const post = {
      message_id: messageId,
      chat_id: chatId,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };

    // Attach photo/video info
    if (photoFileId) {
      post.photo_file_id = photoFileId;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(photoFileId);
        if (url) post.photo_url = url;
      }
    }
    if (videoFileId) {
      post.video_file_id = videoFileId;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(videoFileId);
        if (url) post.video_url = url;
      }
    }

    // Save to Firebase under telegram_posts (with message_id as key)
    await db.ref(`telegram_posts/${messageId}`).set(post);

    // Mark hash as processed
    await hashRef.set({
      first_seen: admin.database.ServerValue.TIMESTAMP,
      message_id: messageId,
      chat_id: chatId,
    });

    // Add to in‑memory cache
    recentlySeenHashes.add(contentHash);

    console.log(`✅ Saved new post ${messageId} (hash ${contentHash.slice(0,8)})`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Telegram Firebase Sync Running ✅");
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
