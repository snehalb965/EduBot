require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const Groq = require("groq-sdk");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 4000;

/* =========================
   FIREBASE INITIALIZATION
========================= */
const serviceAccount = require("./firebaseKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://edubot-49076-default-rtdb.asia-southeast1.firebasedatabase.app/",
});

const db = admin.database();

/* =========================
   GROQ AI INITIALIZATION
========================= */
const groq = new Groq({
  apiKey: process.env.Groq_API_KEY,
});

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* =========================
   MULTER (FILE UPLOAD)
========================= */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* =========================
   SCHOOL SCORING FUNCTION
========================= */
function calculateScore(school, user) {
  let score = 0;

  // CLASS
  if (school.classes !== undefined && school.classes !== null) {
    if (Array.isArray(school.classes)) {
      if (school.classes.map(String).includes(String(user.class))) score += 30;
    } else {
      if (String(school.classes) === String(user.class)) score += 30;
    }
  }

  // LOCATION
  if (
    school.location &&
    user.location &&
    school.location.toLowerCase().includes(user.location.toLowerCase())
  ) {
    score += 20;
  }

  // TYPE
  if (
    school.type &&
    user.type &&
    school.type.toLowerCase() === user.type.toLowerCase()
  ) {
    score += 20;
  }

  // DISTANCE (NOTE: distence)
  if (
    typeof school.distence === "number" &&
    school.distence <= user.maxDistance
  ) {
    score += 20;
  }

  // FEE
  if (
    typeof school.fee === "number" &&
    ((user.fee === "free" && school.fee === 0) ||
      (user.fee === "low" && school.fee <= 500) ||
      (user.fee === "medium" && school.fee <= 1500))
  ) {
    score += 20;
  }

  // SCHEMES
  if (user.middayMeal && school.midday === true) score += 5;
  if (user.girlChild && school.girlSupport === true) score += 5;

  return score;
}

/* =========================
   CHATBOT (OPTIONAL)
========================= */
async function getSchoolsFromDB() {
  const snapshot = await db.ref("schools").once("value");
  return Object.values(snapshot.val() || {});
}

async function generateChatbotResponse(query, language = "English") {
  const schools = await getSchoolsFromDB();

  const context = schools
    .map(
      (s) =>
        `- ${s.name}, ${s.location}, ${s.type}, Fee: ₹${s.fee}, Distance: ${s.distence}km`
    )
    .join("\n");

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [
      {
        role: "system",
        content: "You are an AI school admission assistant.",
      },
      {
        role: "user",
        content: `
Reply in ${language}.
Use this school data:
${context}

Question: ${query}
        `,
      },
    ],
  });

  return completion.choices[0].message.content;
}

/* =========================
   ROUTES
========================= */

// Home
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "main.html"));
});

// Chatbot
app.post("/api/chatbot/ask", async (req, res) => {
  const { query, language } = req.body;
  const reply = await generateChatbotResponse(query, language);
  res.json({ reply });
});

// Recommend schools
app.post("/api/recommend", async (req, res) => {
  try {
    const user = req.body;

    const snapshot = await db.ref("schools").once("value");
    const schools = Object.values(snapshot.val() || {});

    const recommendations = schools
      .map((s) => ({ ...s, score: calculateScore(s, user) }))
      .filter((s) => s.score >= 30) // lowered for testing
      .sort((a, b) => b.score - a.score);

    res.json(recommendations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Recommendation failed" });
  }
});

// Get all schools
app.get("/api/schools", async (req, res) => {
  const snapshot = await db.ref("schools").once("value");
  res.json(Object.values(snapshot.val() || {}));
});

// Upload form
app.post("/api/upload", upload.single("formUpload"), (req, res) => {
  res.json({ message: "File uploaded successfully" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "OK" });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📚 Schools API: /api/schools`);
  console.log(`🎯 Recommend API: /api/recommend`);
  console.log(`🤖 Chatbot API: /api/chatbot/ask`);
});
