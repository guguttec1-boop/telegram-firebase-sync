const express = require("express");
const admin = require("firebase-admin");

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

// --- Simple in‑memory deduplication cache (optional) ---
const processedIds = new Set();
// Clear the cache every 10 seconds to avoid memory growth
setInterval(() => processedIds.clear(), 10000);

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
  // Match the first sequence of digits, commas, dots, and maybe a decimal point
  const match = raw.match(/(\d+[\d,.]*\d+|\d+)/);
  if (!match) return "";
  // Remove commas (they are thousand separators) and convert to a clean number string
  const numStr = match[1].replace(/,/g, "");
  // If you want to keep decimals, parseFloat; otherwise keep as string
  // We'll store as string to preserve format
  return numStr;
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

  // --- Special handling for price: extract only the numeric part ---
  if (data.price) {
    const numericPrice = extractPrice(data.price);
    if (numericPrice) data.price = numericPrice;
    // else keep as is (or clear?) – we'll keep empty if no number found
  }

  // Copy storage to memory if needed
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

    const messageId = msg.message_id;
    const chatId = msg.chat.id;

    // Optional: quick deduplication to prevent multiple simultaneous writes
    const cacheKey = `${chatId}_${messageId}`;
    if (processedIds.has(cacheKey)) {
      console.log(`⏩ Skipping duplicate webhook for ${cacheKey}`);
      return res.sendStatus(200);
    }
    processedIds.add(cacheKey);

    const messageText = msg.text || msg.caption || "";
    const details = extractDetails(messageText);

    const post = {
      message_id: messageId,
      chat_id: chatId,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };

    // Handle photo
    if (msg.photo) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      post.photo_file_id = largestPhoto.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(largestPhoto.file_id);
        if (url) post.photo_url = url;
      }
    }

    // Handle video
    if (msg.video) {
      post.video_file_id = msg.video.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(msg.video.file_id);
        if (url) post.video_url = url;
      }
    }

    // Save to Firebase using message_id as the key – overwrites on edits, no duplicates
    await db.ref(`telegram_posts/${messageId}`).set(post);

    console.log(`✅ Saved post ${messageId} from ${msg.chat.title}`);
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
