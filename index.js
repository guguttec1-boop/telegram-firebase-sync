const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

// For Node < 18, install node-fetch; for Node 18+, remove this require.
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Validate environment
if (!process.env.FIREBASE_KEY || !process.env.FIREBASE_URL) {
  console.error("Missing FIREBASE_KEY or FIREBASE_URL");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});
const db = admin.database();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN not set – file URLs will NOT be generated.");

// --- Album buffer ---
const pendingAlbums = new Map();

// ------------------------------------------------------------
// Helper: clean keys, extract price, get file URL
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

// ------------------------------------------------------------
// Extract structured fields from text
// ------------------------------------------------------------
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

function computeContentHash(text, photoFileIds) {
  const payload = [text || "", ...(photoFileIds || [])].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------
// Process an album (group of photos)
// ------------------------------------------------------------
async function processAlbum(mediaGroupId, messages) {
  console.log(`🔄 Processing album ${mediaGroupId} with ${messages.length} messages...`);
  try {
    // Sort by date, use first as base
    const sorted = messages.sort((a, b) => a.date - b.date);
    const firstMsg = sorted[0];

    // Find a caption among messages
    let caption = "";
    for (const msg of sorted) {
      if (msg.text || msg.caption) {
        caption = msg.text || msg.caption;
        break;
      }
    }

    // Collect all photo file IDs and generate URLs
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

    console.log(`📸 Album ${mediaGroupId}: found ${photoFileIds.length} photos, caption length: ${caption.length}`);

    // Parse structured data from caption
    const details = caption ? extractDetails(caption) : {};

    // Build post object
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

    // Save under a composite key based on media_group_id (or first message_id)
    const key = `album_${mediaGroupId}`;
    await db.ref(`telegram_posts/${key}`).set(post);

    // Deduplicate: store hash
    const hash = computeContentHash(caption, photoFileIds);
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
// Process a single message (not part of album)
// ------------------------------------------------------------
async function processSingleMessage(msg) {
  try {
    const messageText = msg.text || msg.caption || "";
    if (!messageText) {
      console.log("⏩ Skipping: empty text/caption");
      return;
    }

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
    if (msg.video) {
      post.video_file_id = msg.video.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(msg.video.file_id);
        if (url) post.video_url = url;
      }
    }

    await db.ref(`telegram_posts/${msg.message_id}`).set(post);
    console.log(`✅ Saved single post ${msg.message_id}`);
  } catch (err) {
    console.error(`❌ Error processing single message ${msg.message_id}:`, err);
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

    // If there is a media_group_id, buffer it
    if (msg.media_group_id) {
      const groupId = msg.media_group_id;
      if (!pendingAlbums.has(groupId)) {
        pendingAlbums.set(groupId, { messages: [], timer: null });
      }
      const entry = pendingAlbums.get(groupId);
      entry.messages.push(msg);

      // Clear existing timer
      if (entry.timer) clearTimeout(entry.timer);

      // Set a new timer to process after 3 seconds (give time for all photos)
      entry.timer = setTimeout(() => {
        console.log(`⏰ Timer fired for album ${groupId}`);
        const albumData = pendingAlbums.get(groupId);
        if (albumData) {
          // Process album
          processAlbum(groupId, albumData.messages).then(() => {
            pendingAlbums.delete(groupId);
            console.log(`🧹 Album ${groupId} removed from buffer`);
          }).catch(err => {
            console.error(`❌ Timer processing error for album ${groupId}:`, err);
          });
        } else {
          console.warn(`⚠️ Album ${groupId} not found in buffer when timer fired.`);
        }
      }, 3000); // increased to 3 seconds

      console.log(`📸 Buffering album ${groupId} (${entry.messages.length} photos so far)`);
      return res.sendStatus(200);
    }

    // Not an album: process single message immediately
    await processSingleMessage(msg);
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
