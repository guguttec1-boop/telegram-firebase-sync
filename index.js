const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

// For Node < 18, install node-fetch; for Node 18+, remove this require.
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Validate environment variables
if (!process.env.FIREBASE_KEY || !process.env.FIREBASE_URL) {
  console.error("Missing FIREBASE_KEY or FIREBASE_URL");
  process.exit(1);
}

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});
const db = admin.database();

// Telegram Bot token (required for file URLs)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN not set – file URLs will NOT be generated.");
} else {
  console.log("✅ TELEGRAM_BOT_TOKEN is set.");
}

// In‑memory dedup cache
const recentlySeenHashes = new Set();
setInterval(() => recentlySeenHashes.clear(), 60000);

// ------------------------------------------------------------
// Helpers (cleanKey, extractPrice, etc.)
// ------------------------------------------------------------
function cleanKey(str) {
  let cleaned = str.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
  cleaned = cleaned.replace(/\*\*/g, "").replace(/__/g, "").trim();
  return cleaned;
}

function extractPrice(raw) {
  const match = raw.match(/(\d+[\d,.]*\d+|\d+)/);
  if (!match) return "";
  return match[1].replace(/,/g, "");
}

// ------------------------------------------------------------
// Get downloadable URL for a Telegram file (with logging)
// ------------------------------------------------------------
async function getTelegramFileUrl(fileId) {
  if (!BOT_TOKEN) {
    console.log("⏩ getTelegramFileUrl: BOT_TOKEN missing, returning null");
    return null;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
    console.log(`🔍 Fetching file URL for file_id: ${fileId}`);
    const response = await fetch(url);
    const data = await response.json();

    if (!data.ok) {
      console.error(`❌ Telegram API error for getFile: ${data.description}`);
      return null;
    }

    if (!data.result || !data.result.file_path) {
      console.error("❌ No file_path in Telegram response:", data);
      return null;
    }

    const filePath = data.result.file_path;
    const fullUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    console.log(`✅ Generated file URL: ${fullUrl}`);
    return fullUrl;
  } catch (err) {
    console.error(`❌ Exception in getTelegramFileUrl: ${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------
// Extract structured data
// ------------------------------------------------------------
function extractDetails(text) {
  // ... (same as before) ...
  const data = {
    description: "",
    name: "", category: "", brand: "", type: "", price: "", condition: "",
    processor: "", display: "", ram: "", graphics: "", battery_life: "",
    life_features: "", best_for: "", telegram: "", memory: "", storage: "",
    location: "", website: "", phone: "",
  };

  const fieldMap = {
    name: "name", category: "category", brand: "brand", type: "type",
    price: "price", condition: "condition", processor: "processor",
    display: "display", ram: "ram", graphics: "graphics",
    "battery life": "battery_life", "life features": "life_features",
    "best for": "best_for", telegram: "telegram", memory: "memory",
    storage: "storage", location: "location", website: "website",
    "call us": "phone", phone: "phone", contact: "phone",
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

  for (const k of Object.keys(data)) {
    if (typeof data[k] === "string") data[k] = data[k].trim();
  }

  return data;
}

// ------------------------------------------------------------
// Content hash
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

    // Skip empty text
    if (!messageText) {
      console.log("⏩ Skipping: empty text/caption");
      return res.sendStatus(200);
    }

    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // --- Extract media file IDs ---
    let photoFileId = null;
    let videoFileId = null;
    if (msg.photo) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id;
      console.log(`📸 Photo file_id: ${photoFileId}`);
    }
    if (msg.video) {
      videoFileId = msg.video.file_id;
      console.log(`🎬 Video file_id: ${videoFileId}`);
    }

    // --- Content deduplication ---
    const contentHash = computeContentHash(messageText, photoFileId, videoFileId);

    if (recentlySeenHashes.has(contentHash)) {
      console.log(`⏩ Skipping duplicate content (hash ${contentHash.slice(0,8)})`);
      return res.sendStatus(200);
    }

    const hashRef = db.ref(`processed_hashes/${contentHash}`);
    const snapshot = await hashRef.once("value");
    if (snapshot.exists()) {
      console.log(`⏩ Content already processed (hash ${contentHash.slice(0,8)}) – skipping`);
      recentlySeenHashes.add(contentHash);
      return res.sendStatus(200);
    }

    // --- Parse the text ---
    const details = extractDetails(messageText);

    const post = {
      message_id: messageId,
      chat_id: chatId,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };

    // --- Attach photo/video info (including URL) ---
    if (photoFileId) {
      post.photo_file_id = photoFileId;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(photoFileId);
        if (url) {
          post.photo_url = url;
          console.log(`✅ Added photo_url: ${url}`);
        } else {
          console.warn(`⚠️ Could not generate photo URL for file_id: ${photoFileId}`);
        }
      } else {
        console.warn("⚠️ BOT_TOKEN missing – skipping photo URL generation.");
      }
    }

    if (videoFileId) {
      post.video_file_id = videoFileId;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(videoFileId);
        if (url) {
          post.video_url = url;
          console.log(`✅ Added video_url: ${url}`);
        } else {
          console.warn(`⚠️ Could not generate video URL for file_id: ${videoFileId}`);
        }
      } else {
        console.warn("⚠️ BOT_TOKEN missing – skipping video URL generation.");
      }
    }

    // --- Save to Firebase ---
    await db.ref(`telegram_posts/${messageId}`).set(post);

    // Mark hash as processed
    await hashRef.set({
      first_seen: admin.database.ServerValue.TIMESTAMP,
      message_id: messageId,
      chat_id: chatId,
    });

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
