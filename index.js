const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

// For Node < 18, install node-fetch; for Node 18+, you can remove this require.
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------
// Validate environment variables
// ------------------------------------------------------------
if (!process.env.FIREBASE_KEY || !process.env.FIREBASE_URL) {
  console.error("❌ Missing FIREBASE_KEY or FIREBASE_URL");
  process.exit(1);
}

// ------------------------------------------------------------
// Initialize Firebase
// ------------------------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});
const db = admin.database();

// ------------------------------------------------------------
// Telegram Bot token (required for file URLs)
// ------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN not set – file URLs will NOT be generated or refreshed.");
} else {
  console.log("✅ TELEGRAM_BOT_TOKEN is set.");
}

// ------------------------------------------------------------
// Album buffer (in‑memory)
// ------------------------------------------------------------
const pendingAlbums = new Map(); // key: media_group_id, value: { messages: [], timer: null }

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

function computeContentHash(text, photoFileIds, videoFileIds) {
  const payload = [text || "", ...(photoFileIds || []), ...(videoFileIds || [])].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------
// Refresh all temporary URLs every 12 hours
// ------------------------------------------------------------
async function refreshAllUrls() {
  if (!BOT_TOKEN) {
    console.log("⏩ URL refresh skipped – BOT_TOKEN not set.");
    return;
  }

  console.log("🔄 Starting URL refresh cycle (every 12 hours)...");

  try {
    // Get all posts from telegram_posts
    const snapshot = await db.ref("telegram_posts").once("value");
    if (!snapshot.exists()) {
      console.log("ℹ️ No posts found to refresh.");
      return;
    }

    const updates = {};
    const posts = snapshot.val();
    let count = 0;

    for (const [key, post] of Object.entries(posts)) {
      let needsUpdate = false;
      const updatedPost = { ...post };

      // Single photo
      if (post.photo_file_id && !post.photo_url) {
        const newUrl = await getTelegramFileUrl(post.photo_file_id);
        if (newUrl) {
          updatedPost.photo_url = newUrl;
          needsUpdate = true;
        }
      }

      // Single video
      if (post.video_file_id && !post.video_url) {
        const newUrl = await getTelegramFileUrl(post.video_file_id);
        if (newUrl) {
          updatedPost.video_url = newUrl;
          needsUpdate = true;
        }
      }

      // Album photos (array)
      if (post.photo_file_ids && Array.isArray(post.photo_file_ids)) {
        const newUrls = [];
        let allGood = true;
        for (const fileId of post.photo_file_ids) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            newUrls.push(url);
          } else {
            allGood = false;
            break;
          }
        }
        if (allGood && newUrls.length > 0) {
          updatedPost.photo_urls = newUrls;
          needsUpdate = true;
        }
      }

      // Album videos (array)
      if (post.video_file_ids && Array.isArray(post.video_file_ids)) {
        const newUrls = [];
        let allGood = true;
        for (const fileId of post.video_file_ids) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            newUrls.push(url);
          } else {
            allGood = false;
            break;
          }
        }
        if (allGood && newUrls.length > 0) {
          updatedPost.video_urls = newUrls;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        updates[`telegram_posts/${key}`] = updatedPost;
        count++;
        // Avoid hitting rate limits – delay 100ms between updates
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (count > 0) {
      // Perform all updates in one batch
      await db.ref().update(updates);
      console.log(`✅ URL refresh complete: updated ${count} posts.`);
    } else {
      console.log("ℹ️ No URLs needed refreshing.");
    }
  } catch (err) {
    console.error("❌ Error during URL refresh:", err);
  }
}

// ------------------------------------------------------------
// Process an album (photos and/or videos)
// ------------------------------------------------------------
async function processAlbum(mediaGroupId, messages) {
  console.log(`🔄 Processing album ${mediaGroupId} with ${messages.length} messages...`);
  try {
    const sorted = messages.sort((a, b) => a.date - b.date);
    const firstMsg = sorted[0];

    // Find caption
    let caption = "";
    for (const msg of sorted) {
      if (msg.text || msg.caption) {
        caption = msg.text || msg.caption;
        break;
      }
    }

    console.log(`📸 Album ${mediaGroupId}: BOT_TOKEN present? ${!!BOT_TOKEN}`);

    const photoFileIds = [];
    const photoUrls = [];
    const videoFileIds = [];
    const videoUrls = [];

    for (const msg of sorted) {
      // Photos
      if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        const fileId = largest.file_id;
        photoFileIds.push(fileId);
        console.log(`🖼️ Processing photo with file_id: ${fileId}`);
        if (BOT_TOKEN) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            photoUrls.push(url);
            console.log(`✅ Got photo URL: ${url}`);
          } else {
            console.warn(`⚠️ No photo URL for file_id: ${fileId}`);
          }
        } else {
          console.warn(`⏩ BOT_TOKEN missing – skipping photo URL for ${fileId}`);
        }
      }

      // Videos
      if (msg.video) {
        const fileId = msg.video.file_id;
        videoFileIds.push(fileId);
        console.log(`🎬 Processing video with file_id: ${fileId}`);
        if (BOT_TOKEN) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            videoUrls.push(url);
            console.log(`✅ Got video URL: ${url}`);
          } else {
            console.warn(`⚠️ No video URL for file_id: ${fileId}`);
          }
        } else {
          console.warn(`⏩ BOT_TOKEN missing – skipping video URL for ${fileId}`);
        }
      }
    }

    console.log(`📸 Album ${mediaGroupId}: found ${photoFileIds.length} photos, ${videoFileIds.length} videos`);

    // Parse structured fields from the caption
    const details = caption ? extractDetails(caption) : {};

    // Build the post object
    const post = {
      chat_id: firstMsg.chat.id,
      chat_title: firstMsg.chat.title,
      date: firstMsg.date,
      text: caption,
      media_group_id: mediaGroupId,
      ...(photoFileIds.length > 0 && { photo_file_ids: photoFileIds }),
      ...(photoUrls.length > 0 && { photo_urls: photoUrls }),
      ...(videoFileIds.length > 0 && { video_file_ids: videoFileIds }),
      ...(videoUrls.length > 0 && { video_urls: videoUrls }),
      ...details,
    };

    // Save under "album_<media_group_id>"
    const key = `album_${mediaGroupId}`;
    await db.ref(`telegram_posts/${key}`).set(post);

    // Deduplicate – hash includes both photos and videos
    const hash = computeContentHash(caption, photoFileIds, videoFileIds);
    await db.ref(`processed_hashes/${hash}`).set({
      first_seen: admin.database.ServerValue.TIMESTAMP,
      media_group_id: mediaGroupId,
      chat_id: firstMsg.chat.id,
    });

    console.log(`✅ Saved album ${mediaGroupId} with ${photoFileIds.length} photos and ${videoFileIds.length} videos`);
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

    // Handle single photo
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      const fileId = largest.file_id;
      post.photo_file_id = fileId;
      console.log(`🖼️ Single photo file_id: ${fileId}`);
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(fileId);
        if (url) {
          post.photo_url = url;
          console.log(`✅ Added photo_url: ${url}`);
        } else {
          console.warn(`⚠️ Could not generate photo URL for file_id: ${fileId}`);
        }
      } else {
        console.warn("⚠️ BOT_TOKEN missing – skipping photo URL generation.");
      }
    }

    // Handle single video
    if (msg.video) {
      const fileId = msg.video.file_id;
      post.video_file_id = fileId;
      console.log(`🎬 Single video file_id: ${fileId}`);
      if (BOT_TOKEN) {
        const url = await getTelegramFileUrl(fileId);
        if (url) {
          post.video_url = url;
          console.log(`✅ Added video_url: ${url}`);
        } else {
          console.warn(`⚠️ Could not generate video URL for file_id: ${fileId}`);
        }
      } else {
        console.warn("⚠️ BOT_TOKEN missing – skipping video URL generation.");
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

    // If there is a media_group_id, buffer it (album)
    if (msg.media_group_id) {
      const groupId = msg.media_group_id;
      if (!pendingAlbums.has(groupId)) {
        pendingAlbums.set(groupId, { messages: [], timer: null });
      }
      const entry = pendingAlbums.get(groupId);
      entry.messages.push(msg);

      // Clear existing timer
      if (entry.timer) clearTimeout(entry.timer);

      // Set a new timer to process after 3 seconds
      entry.timer = setTimeout(() => {
        console.log(`⏰ Timer fired for album ${groupId}`);
        const albumData = pendingAlbums.get(groupId);
        if (albumData) {
          processAlbum(groupId, albumData.messages).then(() => {
            pendingAlbums.delete(groupId);
            console.log(`🧹 Album ${groupId} removed from buffer`);
          }).catch(err => {
            console.error(`❌ Timer processing error for album ${groupId}:`, err);
          });
        } else {
          console.warn(`⚠️ Album ${groupId} not found in buffer when timer fired.`);
        }
      }, 3000);

      console.log(`📸 Buffering album ${groupId} (${entry.messages.length} messages so far)`);
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
// Health check
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Telegram Firebase Sync Running ✅");
});

// ------------------------------------------------------------
// Start server & schedule URL refresh
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server started on port ${PORT}`);

  // Run initial refresh (optional, but good to have fresh URLs)
  await refreshAllUrls();

  // Schedule refresh every 12 hours (43200000 ms)
  setInterval(refreshAllUrls, 12 * 60 * 60 * 1000);
  console.log("⏰ Scheduled URL refresh every 12 hours.");
});
