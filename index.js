const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Validate required environment variables
if (!process.env.FIREBASE_KEY || !process.env.FIREBASE_URL) {
  console.error("Missing FIREBASE_KEY or FIREBASE_URL");
  process.exit(1);
}

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});

const db = admin.database();

// ------------------------------------------------------------
// Helper: remove common emoji characters from a string
// ------------------------------------------------------------
function stripEmojis(str) {
  // Covers most emojis (including symbols, flags, etc.)
  return str.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim();
}

// ------------------------------------------------------------
// Extract structured data from Telegram message text
// ------------------------------------------------------------
function extractDetails(text) {
  // Default empty object
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
  };

  // Mapping from (lowercase, stripped) key to data property
  const fields = {
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
    storage: "memory", // added to handle "Storage:" lines
  };

  const lines = text.split("\n");
  let foundFirstIdentity = false;
  const descriptionLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator !== -1) {
      // Extract key and value
      const rawKey = trimmed.substring(0, separator).trim();
      const key = stripEmojis(rawKey).toLowerCase();
      const value = trimmed.substring(separator + 1).trim();

      // If this is a known field, store it
      if (fields[key]) {
        foundFirstIdentity = true;
        data[fields[key]] = value;
        continue;
      }
    }

    // If we haven't seen any known field yet, treat this line as description.
    // Optionally, you could also keep non‑matched lines after the first field
    // by removing the `if (!foundFirstIdentity)` condition.
    if (!foundFirstIdentity) {
      descriptionLines.push(trimmed);
    }
    // If you want to keep *all* non‑matched lines in description, uncomment:
    // else {
    //   descriptionLines.push(trimmed);
    // }
  }

  data.description = descriptionLines.join("\n");
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
      // Not a channel post – ignore (but log for debugging)
      console.log("Ignored update type:", Object.keys(update));
      return res.sendStatus(200);
    }

    const messageText = msg.text || msg.caption || "";
    const details = extractDetails(messageText);

    // Build the post object
    const post = {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,
      ...details,
    };

    // Attach photo/video if present
    if (msg.photo) {
      post.photo = msg.photo[msg.photo.length - 1].file_id;
    }
    if (msg.video) {
      post.video = msg.video.file_id;
    }

    // Use message_id as the key – this overwrites on edits, keeping only the latest version
    await db.ref(`telegram_posts/${msg.message_id}`).set(post);

    console.log(`Saved post ${msg.message_id} from chat ${msg.chat.title}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Telegram Firebase Sync Running");
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
