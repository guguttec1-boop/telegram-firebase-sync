const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});

const db = admin.database();


// Extract product information from Telegram text
function extractDetails(text) {
  const data = {
    category: "",
    brand: "",
    type: "",
    price: "",
    condition: "",
    name: "",
    secondary_storage: "",
    description: "",
    contact_phone: ""
  };

  const lines = text.split("\n");

  lines.forEach(line => {
    const parts = line.split(":");

    if (parts.length < 2) return;

    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();

    switch (key) {
      case "category":
        data.category = value;
        break;

      case "brand":
        data.brand = value;
        break;

      case "type":
        data.type = value;
        break;

      case "price":
        data.price = value;
        break;

      case "condition":
        data.condition = value;
        break;

      case "name":
        data.name = value;
        break;

      case "secondary storage":
        data.secondary_storage = value;
        break;

      case "description":
        data.description = value;
        break;

      case "contact phone":
        data.contact_phone = value;
        break;
    }
  });

  return data;
}


app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.channel_post;

    if (!msg) {
      return res.sendStatus(200);
    }

    const messageText = msg.text || msg.caption || "";

    const details = extractDetails(messageText);

    const post = {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      chat_title: msg.chat.title,
      text: messageText,
      date: msg.date,

      // Product identities
      category: details.category,
      brand: details.brand,
      type: details.type,
      price: details.price,
      condition: details.condition,
      name: details.name,
      secondary_storage: details.secondary_storage,
      description: details.description,
      contact_phone: details.contact_phone
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
