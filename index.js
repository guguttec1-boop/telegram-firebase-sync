const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});

const db = admin.database();

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.channel_post;

    if (!msg) {
      return res.sendStatus(200);
    }

    const post = {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      chat_title: msg.chat.title,
      text: msg.text || msg.caption || "",
      date: msg.date,
    };

    if (msg.photo) {
      post.photo = msg.photo[msg.photo.length - 1].file_id;
    }

    if (msg.video) {
      post.video = msg.video.file_id;
    }

    await db.ref("telegram_posts").push(post);

    console.log("Saved:", post);

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Telegram Firebase Sync Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
