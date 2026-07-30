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
if (!BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN not set – file URLs will NOT be generated.");

// --- Album grouping (buffer) ---
const pendingAlbums = new Map(); // key: media_group_id, value: { messages: [], timer }

// ------------------------------------------------------------
// Helpers
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

async function getTelegramFileUrl(fileId) {
  if (!BOT_TOKEN) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.ok) {
      console.error(`❌ Telegram API error for getFile: ${data.description}`);
      return null;
    }
    if (!data.result || !data.result.file_path) return null;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
  } catch (err) {
    console.error(`❌ Exception in getTelegramFileUrl: ${err.message}`);
    return null;
  }
}

function extractDetails(text) {
  const data = {
    description: "", name: "", category: "", brand: "", type: "",
    price: "", condition: "", processor: "", display: "", ram: "",
    graphics: "", battery_life: "", life_features: "", best_for: "",
    telegram: "", memory: "", storage: "", location: "", website: "",
    phone: "", status: ""
  };
  const fieldMap = {
    name: "name", category: "category", brand: "brand", type: "type",
    price: "price", condition: "condition", processor: "processor",
    display: "display", ram: "ram", graphics: "graphics",
    "battery life": "battery_life", "life features": "life_features",
    "key features": "life_features", "best for": "best_for",
    telegram: "telegram", memory: "memory", storage: "storage",
    location: "location", website: "website", "call us": "phone",
    phone: "phone", contact: "phone", "contact us": "phone",
    "for quick messages": "telegram", status: "status"
  };

  const lines = text.split("\n");
  const descriptionLines = [];
  let currentField = null, currentValue = [], foundFirstIdentity = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    let isField = false, key = null, value = "";
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
  if (currentField) data[currentField] = currentValue.join("\n").trim();
  data.description = descriptionLines.join("\n");

  if (data.price) {
    const numeric = extractPrice(data.price);
    data.price = numeric || "";
  }
  if (data.storage && !data.memory) data.memory = data.storage;
  for (const k of Object.keys(data)) {
    if (typeof data[k] === "string") data[k] = data[k].trim();
  }
  return data;
}

function computeContentHash(text, photoFileIds, videoFileIds) {
  const payload = [text || "", ...(photoFileIds || []), ...(videoFileIds || [])].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------
// Process a complete album (or single message)
// ------------------------------------------------------------
async function processAlbum(mediaGroupId, messages) {
  try {
    // Sort messages by date so we get the first one with caption
    const sorted = messages.sort((a, b) => a.date - b.date);
    const firstMsg = sorted[0];

    // Extract caption from any message that has text
    let caption = "";
    for (const msg of sorted) {
      if (msg.text || msg.caption) {
        caption = msg.text || msg.caption;
        break;
      }
    }

    // Get all photo file IDs and URLs
    const photoFileIds = [];
    const photoUrls = [];
    for (const msg of sorted) {
      if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        photoFileIds.push(largest.file_id);
        if (BOT_TOKEN) {
          const url = await getTelegramFileUrl(largest.file_id);
          if (url) photoUrls.push(url);
        }
      }
    }

    // Parse structured fields from the caption
    const details = caption ? extractDetails(caption) : {};

    // Build the post object
    const post = {
      chat_id: firstMsg.chat.id,
      chat_title: firstMsg.chat.title,
      date: firstMsg.date,
      text: caption,
      media_group_id: mediaGroupId,
      photo_file_ids: photoFileIds,
      photo_urls: photoUrls,
      ...details,
    };

    // Add video support if needed (not in album, but can be extended)

    // Use first message_id as key (or composite)
    const key = `album_${mediaGroupId}`;
    await db.ref(`telegram_posts/${key}`).set(post);

    // Also store hash for deduplication (combine all photo IDs and caption)
    const hash = computeContentHash(caption, photoFileIds, []);
    const hashRef = db.ref(`processed_hashes/${hash}`);
    await hashRef.set({
      first_seen: admin.database.ServerValue.TIMESTAMP,
      media_group_id: mediaGroupId,
      chat_id: firstMsg.chat.id,
    });

    console.log(`✅ Saved album ${mediaGroupId} with ${photoFileIds.length} photos`);
  } catch (err) {
    console.error(`❌ Error processing album ${mediaGroupId}:`, err);
  }
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

    // If message has text but no media, process immediately (single post)
    if (!msg.photo && !msg.video) {
      // ... (existing single‑message handling) ...
      // We'll keep it simple: just process normally (not album)
      // But for brevity, I'll assume all messages with photos are handled via album logic if they have media_group_id.
    }

    // Check if this is part of an album
    if (msg.media_group_id) {
      const groupId = msg.media_group_id;
      if (!pendingAlbums.has(groupId)) {
        // Start a new buffer
        pendingAlbums.set(groupId, { messages: [], timer: null });
      }
      const entry = pendingAlbums.get(groupId);
      entry.messages.push(msg);

      // Clear existing timer if any
      if (entry.timer) clearTimeout(entry.timer);

      // Set a 2‑second timer to process the album
      entry.timer = setTimeout(async () => {
        const albumData = pendingAlbums.get(groupId);
        if (albumData) {
          await processAlbum(groupId, albumData.messages);
          pendingAlbums.delete(groupId);
        }
      }, 2000);

      console.log(`📸 Buffering album ${groupId} (${entry.messages.length} photos so far)`);
      return res.sendStatus(200);
    }

    // --- Single photo/video (not part of an album) ---
    // Handle as before (existing code)
    const messageText = msg.text || msg.caption || "";
    if (!messageText) {
      console.log("⏩ Skipping: empty text/caption");
      return res.sendStatus(200);
    }

    // ... (rest of the original single‑message logic)
    // I'll compress for brevity – but you can reuse your earlier single‑message code here.
    // In practice, you'd have a function to process single messages.
    // For this solution, I'm providing the album fix; you can integrate with your existing code.

    // For completeness, let's quickly handle single:
    const details = extractDetails(messageText);
    const post = {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      post.photo_file_id = largest.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(largest.file_id);
        if (url) post.photo_url = url;
      }
    }
    // Save single
    await db.ref(`telegram_posts/${msg.message_id}`).set(post);
    console.log(`✅ Saved single post ${msg.message_id}`);
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.sendStatus(500);
  }
});

// ------------------------------------------------------------
// Health check & start
// ------------------------------------------------------------
app.get("/", (req, res) => res.send("Telegram Firebase Sync Running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
