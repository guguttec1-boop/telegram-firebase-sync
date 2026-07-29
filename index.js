const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_URL,
});

const db = admin.database();


// Extract identities from Telegram post
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
    memory: ""
  };


  const fields = {
    "name": "name",
    "category": "category",
    "brand": "brand",
    "type": "type",
    "price": "price",
    "condition": "condition",
    "processor": "processor",
    "display": "display",
    "ram": "ram",
    "graphics": "graphics",
    "battery life": "battery_life",
    "life features": "life_features",
    "best for": "best_for",
    "telegram": "telegram",
    "memory": "memory"
  };


  const lines = text.split("\n");

  let foundFirstIdentity = false;
  let descriptionLines = [];


  lines.forEach(line => {

    const separator = line.indexOf(":");


    if (separator !== -1) {

      const key = line.substring(0, separator)
        .trim()
        .toLowerCase();

      const value = line.substring(separator + 1)
        .trim();


      if (fields[key]) {

        foundFirstIdentity = true;
        data[fields[key]] = value;

        return;
      }
    }


    // Before first identity = description
    if (!foundFirstIdentity && line.trim()) {
      descriptionLines.push(line.trim());
    }

  });


  data.description = descriptionLines.join("\n");


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


      ...details

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
