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

// ------------------------------------------------------------
// Helper: strip emojis and markdown formatting from keys
// ------------------------------------------------------------
function cleanKey(str) {
  // Remove emojis (common ranges)
  let cleaned = str.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
  // Remove markdown bold/italic markers
  cleaned = cleaned.replace(/\*\*/g, "").replace(/__/g, "").trim();
  return cleaned;
}

// ------------------------------------------------------------
// Get a downloadable URL for a Telegram file (photo/video)
// ------------------------------------------------------------
async function getTelegramFileUrl(fileId) {
  if (!BOT_TOKEN) {
    return null; // token not set, can't generate URL
  }
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
  // Default empty fields
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
    storage: "",      // we'll map to memory, but keep separate for clarity
    location: "",
    website: "",
    phone: "",
  };

  // Mapping from (cleaned, lowercase) key to data property
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
    storage: "storage",   // we'll later copy to memory if not set
    location: "location",
    website: "website",
    "call us": "phone",
    phone: "phone",
    contact: "phone",
  };

  const lines = text.split("\n");
  const descriptionLines = [];
  let currentField = null;       // which data property we are filling
  let currentValue = [];

  // Flag to know if we have encountered the first field (description stops before that)
  let foundFirstIdentity = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue; // skip empty lines (but maybe we want to preserve them? Usually not)

    // Try to detect a field: line contains ":"
    const separator = trimmed.indexOf(":");
    let isField = false;
    let key = null;
    let value = "";

    if (separator !== -1) {
      const rawKey = trimmed.substring(0, separator).trim();
      const cleaned = cleanKey(rawKey).toLowerCase();
      const possibleValue = trimmed.substring(separator + 1).trim();

      // Check if cleaned key exists in our map
      if (fieldMap[cleaned]) {
        isField = true;
        key = fieldMap[cleaned];
        value = possibleValue; // could be empty
      }
    }

    if (isField) {
      // We found a new field – save the previous one (if any)
      if (currentField) {
        // Join multiline values
        data[currentField] = currentValue.join("\n").trim();
        currentValue = [];
      }

      // Start new field
      currentField = key;
      // If there is a non-empty value on the same line, start with it
      if (value) {
        currentValue.push(value);
      }
      // If value is empty, we leave currentValue empty, so subsequent lines become value.

      // Mark that we have found at least one identity
      if (!foundFirstIdentity) {
        foundFirstIdentity = true;
      }
    } else {
      // Not a field line – it belongs to the current field (if any)
      if (currentField) {
        // Append to current field's value
        currentValue.push(trimmed);
      } else {
        // Before any field: it's part of the description
        descriptionLines.push(trimmed);
      }
    }
  }

  // Flush the last field
  if (currentField) {
    data[currentField] = currentValue.join("\n").trim();
  }

  // Set description
  data.description = descriptionLines.join("\n");

  // If storage is set but memory isn't, copy storage to memory
  if (data.storage && !data.memory) {
    data.memory = data.storage;
  }
  // If you want to remove storage to avoid duplication, uncomment:
  // delete data.storage;

  // Cleanup: trim all fields
  for (const key of Object.keys(data)) {
    if (typeof data[key] === "string") {
      data[key] = data[key].trim();
    }
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

    const messageText = msg.text || msg.caption || "";
    const details = extractDetails(messageText);

    // Build the base post object
    const post = {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };

    // --- Handle photos (generate URL) ---
    if (msg.photo) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      post.photo_file_id = largestPhoto.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(largestPhoto.file_id);
        if (url) {
          post.photo_url = url;
        }
      }
    }

    // --- Handle videos (generate URL) ---
    if (msg.video) {
      post.video_file_id = msg.video.file_id;
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(msg.video.file_id);
        if (url) {
          post.video_url = url;
        }
      }
    }

    // Save to Firebase using message_id as the key (overwrites on edits)
    await db.ref(`telegram_posts/${msg.message_id}`).set(post);

    console.log(`✅ Saved post ${msg.message_id} from ${msg.chat.title}`);
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
