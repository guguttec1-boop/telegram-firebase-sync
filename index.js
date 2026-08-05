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
// Refresh ALL URLs (regenerate for every file_id)
// ------------------------------------------------------------
async function refreshAllUrls() {
  if (!BOT_TOKEN) {
    console.log("⏩ URL refresh skipped – BOT_TOKEN not set.");
    return;
  }

  console.log("🔄 Starting full URL refresh ...");

  try {
    const snapshot = await db.ref("telegram_posts").once("value");
    if (!snapshot.exists()) {
      console.log("ℹ️ No posts found to refresh.");
      return;
    }

    const posts = snapshot.val();
    const updates = {};
    let totalUpdated = 0;

    for (const [key, post] of Object.entries(posts)) {
      let updatedPost = { ...post };
      let changed = false;

      // --- Single photo ---
      if (post.photo_file_id) {
        const newUrl = await getTelegramFileUrl(post.photo_file_id);
        if (newUrl) {
          updatedPost.photo_url = newUrl;
          changed = true;
          console.log(`✅ Refreshed photo URL for post ${key}`);
        } else {
          console.warn(`⚠️ Could not refresh photo URL for post ${key}, keeping old.`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // --- Single video ---
      if (post.video_file_id) {
        const newUrl = await getTelegramFileUrl(post.video_file_id);
        if (newUrl) {
          updatedPost.video_url = newUrl;
          changed = true;
          console.log(`✅ Refreshed video URL for post ${key}`);
        } else {
          console.warn(`⚠️ Could not refresh video URL for post ${key}, keeping old.`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // --- Album photos (array) ---
      if (post.photo_file_ids && Array.isArray(post.photo_file_ids)) {
        const newUrls = [];
        let allSuccess = true;
        for (const fileId of post.photo_file_ids) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            newUrls.push(url);
          } else {
            allSuccess = false;
            console.warn(`⚠️ Failed to refresh one photo URL for album ${key}`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (allSuccess && newUrls.length > 0) {
          updatedPost.photo_urls = newUrls;
          changed = true;
          console.log(`✅ Refreshed all photo URLs for album ${key}`);
        } else {
          console.warn(`⚠️ Keeping old photo URLs for album ${key} (some failed).`);
        }
      }

      // --- Album videos (array) ---
      if (post.video_file_ids && Array.isArray(post.video_file_ids)) {
        const newUrls = [];
        let allSuccess = true;
        for (const fileId of post.video_file_ids) {
          const url = await getTelegramFileUrl(fileId);
          if (url) {
            newUrls.push(url);
          } else {
            allSuccess = false;
            console.warn(`⚠️ Failed to refresh one video URL for album ${key}`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (allSuccess && newUrls.length > 0) {
          updatedPost.video_urls = newUrls;
          changed = true;
          console.log(`✅ Refreshed all video URLs for album ${key}`);
        } else {
          console.warn(`⚠️ Keeping old video URLs for album ${key} (some failed).`);
        }
      }

      if (changed) {
        updates[`telegram_posts/${key}`] = updatedPost;
        totalUpdated++;
      }
    }

    if (totalUpdated > 0) {
      await db.ref().update(updates);
      console.log(`✅ URL refresh complete: updated ${totalUpdated} posts.`);
    } else {
      console.log("ℹ️ No URLs needed refreshing (all were up to date or failed).");
    }
  } catch (err) {
    console.error("❌ Error during URL refresh:", err);
    throw err; // rethrow so the caller can handle
  }
}

// ------------------------------------------------------------
// Check regeneration flag and run if needed
// ------------------------------------------------------------
let isRegenerating = false;

async function checkAndRunRegeneration() {
  // Prevent overlapping runs
  if (isRegenerating) {
    console.log("⏳ Regeneration already in progress, skipping check.");
    return;
  }

  try {
    const snap = await db.ref("media_regeneration").once("value");
    if (!snap.exists()) {
      console.log("ℹ️ No media_regeneration node found, skipping.");
      return;
    }

    const data = snap.val();
    if (data.status === "yes") {
      console.log("🚀 Regeneration flag is 'yes'. Starting URL regeneration...");
      isRegenerating = true;

      try {
        await refreshAllUrls();

        // After successful regeneration, set status to "done"
        const code = data.code || "";
        await db.ref("media_regeneration").set({
          status: "done",
          code: code,
        });
        console.log("✅ Regeneration completed. Flag set to 'done'.");
      } catch (err) {
        console.error("❌ Regeneration failed:", err);
        // Optionally set status to 'error' or leave as 'yes' to retry later?
        // For now, we'll set to 'done' to avoid endless retries, but you can change.
        // We'll set to 'done' to indicate it was attempted.
        await db.ref("media_regeneration").update({
          status: "done",
        });
        console.log("⚠️ Regeneration attempted with errors, flag set to 'done'.");
      } finally {
        isRegenerating = false;
      }
    } else {
      console.log(`ℹ️ media_regeneration status is '${data.status}', no action.`);
    }
  } catch (err) {
    console.error("❌ Error checking media_regeneration node:", err);
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

    const details = caption ? extractDetails(caption) : {};

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

    const key = `album_${mediaGroupId}`;
    await db.ref(`telegram_posts/${key}`).set(post);

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

    if (msg.media_group_id) {
      const groupId = msg.media_group_id;
      if (!pendingAlbums.has(groupId)) {
        pendingAlbums.set(groupId, { messages: [], timer: null });
      }
      const entry = pendingAlbums.get(groupId);
      entry.messages.push(msg);

      if (entry.timer) clearTimeout(entry.timer);

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
// Start server & set up regeneration checks
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server started on port ${PORT}`);

  // Check regeneration flag immediately on startup
  await checkAndRunRegeneration();

  // Then check every 5 minutes (adjust as needed)
  setInterval(checkAndRunRegeneration, 5 * 60 * 1000);
  console.log("⏰ Scheduled regeneration flag check every 5 minutes.");
});
