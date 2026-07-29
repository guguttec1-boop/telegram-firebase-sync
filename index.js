const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

const app = express();

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});

const db = admin.database();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true,
});

bot.on("channel_post", async (msg) => {
  try {
    const post = {
      message_id: msg.message_id,
      text: msg.text || msg.caption || "",
      date: msg.date,
      chat_title: msg.chat.title,
    };

    await db.ref("telegram_posts").push(post);

    console.log("Saved post:", post);
  } catch (err) {
    console.error(err);
  }
});

app.get("/", (req, res) => {
  res.send("Telegram Sync is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
