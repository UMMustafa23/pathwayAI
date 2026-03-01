import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

// ================= MONGOOSE SCHEMAS =================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  country: { type: String, default: null },
  age: { type: Number, default: null },
  gender: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  assessmentCompleted: { type: Boolean, default: false },
  assessmentAnswers: { type: mongoose.Schema.Types.Mixed, default: null },
  assessmentDate: { type: Date, default: null },
  assessmentResult: { type: mongoose.Schema.Types.Mixed, default: null },
  bigFiveScores: { type: mongoose.Schema.Types.Mixed, default: null },
  selectedCareer: { type: mongoose.Schema.Types.Mixed, default: null },
  selectedUniversity: { type: mongoose.Schema.Types.Mixed, default: null },
  alignmentScore: { type: Number, default: null },
  scoreHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  appData: {
    goals:        { type: mongoose.Schema.Types.Mixed, default: {} },
    moods:        { type: mongoose.Schema.Types.Mixed, default: {} },
    plannerTasks: { type: mongoose.Schema.Types.Mixed, default: {} },
    appSettings:  { type: mongoose.Schema.Types.Mixed, default: {} },
    chatSessions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    scoreCache:   { type: mongoose.Schema.Types.Mixed, default: null },
  },
});

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  domain:   { type: String, default: null },
  options:  { type: [String], default: [] },
});

const User = mongoose.model("User", userSchema);
const Question = mongoose.model("Question", questionSchema);

// ================= AUTH MIDDLEWARE =================
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret"
    );

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ================= START SERVER =================
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    // ================= SIGNUP =================
    app.post("/signup", async (req, res) => {
      try {
        const { username, email, password, country, age, gender } = req.body;

        if (!username || !email || !password) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const existing = await User.findOne({ email });
        if (existing) {
          return res.status(400).json({ error: "Email already exists" });
        }

        const hashed = await bcrypt.hash(password, 10);

        await User.create({
          username,
          email,
          password: hashed,
          country: country || null,
          age: age || null,
          gender: gender || null,
          assessmentCompleted: false,
        });

        res.json({ message: "User created successfully" });
      } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ error: "Signup failed" });
      }
    });

    // ================= LOGIN =================
    app.post("/login", async (req, res) => {
      try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
          return res.status(400).json({ error: "User not found" });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
          return res.status(400).json({ error: "Wrong password" });
        }

        const token = jwt.sign(
          { email: user.email },
          process.env.JWT_SECRET || "dev_secret",
          { expiresIn: "7d" }
        );

        const { password: _, ...safeUser } = user.toObject();

        res.json({ token, user: safeUser });
      } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Login failed" });
      }
    });

    // ================= GET QUESTIONS =================
    app.get("/questions", authenticate, async (req, res) => {
      try {
        const questions = await Question.find({});
        res.json(questions);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch questions" });
      }
    });

    // ================= SAVE ASSESSMENT + AI =================
    app.post("/assessment", authenticate, async (req, res) => {
      try {
        const { answers } = req.body;

        if (!answers) {
          return res.status(400).json({ error: "No answers provided" });
        }

        if (!process.env.DEEPSEEK_API_KEY) {
          return res.status(500).json({ error: "DeepSeek API key missing" });
        }

        // Compute Big Five scores server-side using domain info from DB
        const allQuestions = await Question.find({}, "_id domain");
        const buckets = { E: [], A: [], C: [], N: [], O: [] };
        allQuestions.forEach((q) => {
          const score = answers[q._id.toString()];
          if (score !== undefined && buckets[q.domain]) {
            buckets[q.domain].push(Number(score));
          }
        });
        const avg = (arr) =>
          arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
        const bigFive = {
          extraversion:      avg(buckets.E),
          agreeableness:     avg(buckets.A),
          conscientiousness: avg(buckets.C),
          neuroticism:       avg(buckets.N),
          openness:          avg(buckets.O),
        };

        // Get user's country for localized university recommendations
        const userDoc = await User.findOne({ email: req.user.email }, "country");
        const userCountry = userDoc?.country || "Unknown";

        const prompt = `
Return ONLY valid raw JSON. Do NOT include markdown or explanation.

A student completed a 90-item IPIP Big Five personality assessment (scale 1–5, 1 = low, 5 = high).
Computed Big Five domain averages:
- Extraversion:       ${bigFive.extraversion}
- Agreeableness:      ${bigFive.agreeableness}
- Conscientiousness:  ${bigFive.conscientiousness}
- Neuroticism:        ${bigFive.neuroticism} (lower = more emotionally stable)
- Openness:           ${bigFive.openness}

The student's country is: ${userCountry}

Based on this personality profile:
1. Recommend exactly 6 careers ranked by match percentage.
2. Recommend exactly 6 universities: 3 located IN ${userCountry} (mark local: true) and 3 international (mark local: false), all relevant to the top careers.

Return ONLY this exact JSON structure, with no extra keys:
{
  "summary": "2-3 sentence personality summary tailored to career guidance",
  "tags": ["3 to 5 short personality trait labels"],
  "careers": [
    {
      "title": "Career Title",
      "match": "XX%",
      "averagePay": "$XX,XXX/yr (use the currency of ${userCountry})",
      "description": "One concise sentence describing the career."
    }
  ],
  "universities": [
    {
      "name": "University Name",
      "location": "City, Country",
      "tuition": "$XX,XXX/yr (use the currency of ${userCountry} for local ones)",
      "major": "Recommended Major",
      "acceptanceRate": "XX%",
      "match": "XX%",
      "local": true
    }
  ]
}
`;

        const aiResponse = await axios.post(
          "https://api.deepseek.com/v1/chat/completions",
          {
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 60000,
          }
        );

        const aiContent = aiResponse.data.choices[0].message.content;
        console.log("AI RAW:", aiContent.slice(0, 300));

        let cleaned = aiContent
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();

        // Grab the outermost JSON object
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) {
          console.error("AI RAW RESPONSE (no JSON):", aiContent);
          return res.status(500).json({ error: "AI returned invalid format", raw: aiContent.slice(0, 500) });
        }
        const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
          console.error("JSON parse error:", parseErr.message);
          console.error("JSON string:", jsonStr.slice(0, 500));
          return res.status(500).json({ error: "AI response JSON parse failed", detail: parseErr.message });
        }

        await User.updateOne(
          { email: req.user.email },
          {
            $set: {
              assessmentAnswers: answers,
              assessmentCompleted: true,
              assessmentDate: new Date(),
              assessmentResult: parsed,
              bigFiveScores: bigFive,
            },
          }
        );

        console.log("✅ Assessment saved for:", req.user.email);

        // 🔥 THIS WAS MISSING BEFORE
        res.json(parsed);

      } catch (err) {
        const detail = err.response?.data || err.message;
        console.error("Assessment error:", detail);
        res.status(500).json({ error: "Failed to process assessment", detail: String(detail) });
      }
    });

    // ================= SAVE SELECTION =================
    app.post("/save-selection", authenticate, async (req, res) => {
      try {
        const { type, item } = req.body;
        if (!type || !item) {
          return res.status(400).json({ error: "Missing type or item" });
        }
        if (type !== "career" && type !== "university") {
          return res.status(400).json({ error: "type must be 'career' or 'university'" });
        }

        const field = type === "career" ? "selectedCareer" : "selectedUniversity";
        await User.updateOne(
          { email: req.user.email },
          { $set: { [field]: item } }
        );

        // Return updated user so the app can refresh AsyncStorage
        const updated = await User.findOne({ email: req.user.email }).select("-password");
        res.json({ message: "Saved", user: updated });
      } catch (err) {
        console.error("Save selection error:", err.message);
        res.status(500).json({ error: "Failed to save selection" });
      }
    });

    // ================= GET RESULTS =================
    app.get("/results", authenticate, async (req, res) => {
      try {
        const user = await User.findOne({ email: req.user.email });

        if (!user || !user.assessmentResult) {
          return res.status(404).json({ error: "No results found" });
        }

        res.json({
          ...user.assessmentResult,
          selectedCareer: user.selectedCareer || null,
          selectedUniversity: user.selectedUniversity || null,
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch results" });
      }
    });

    // ================= ALIGNMENT SCORE =================
    app.post("/alignment-score", authenticate, async (req, res) => {
      try {
        const { streakData = {}, currentStreak = 0 } = req.body;
        // streakData: { "YYYY-MM-DD": completedCount (0-5) }

        const user = await User.findOne({ email: req.user.email });
        if (!user) return res.status(404).json({ error: "User not found" });

        // ---- Compute score deterministically ----
        // careerMatchBase: from the top recommended career match %
        const topMatch = user.assessmentResult?.careers?.[0]?.match || "50%";
        const careerMatchPct = parseInt(String(topMatch)) || 50;

        const today = new Date().toISOString().slice(0, 10);

        // Avg completion over last 7 days (including today)
        const last7Avg = (() => {
          let sum = 0, count = 0;
          for (let i = 0; i < 7; i++) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            const val = streakData[key] ?? 0;
            sum += val / 5;
            count++;
          }
          return count ? sum / count : 0;
        })();

        // Avg completion over last 30 days
        const last30Avg = (() => {
          let sum = 0, count = 0;
          for (let i = 0; i < 30; i++) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            const val = streakData[key] ?? 0;
            sum += val / 5;
            count++;
          }
          return count ? sum / count : 0;
        })();

        // score = careerBase(400) + tasks7d(300) + streak(200) + consistency30d(100)
        const careerBase   = Math.round(careerMatchPct * 4);         // max 400
        const tasksScore   = Math.round(last7Avg * 300);             // max 300
        const streakScore  = Math.min(currentStreak * 10, 200);      // max 200
        const consScore    = Math.round(last30Avg * 100);            // max 100
        const newScore     = careerBase + tasksScore + streakScore + consScore; // max 1000

        // ---- Delta vs previous score ----
        const prevScore = user.alignmentScore ?? newScore;
        const delta     = newScore - prevScore;

        // ---- AI explanation ----
        let explanation = "Complete daily goals to improve your score.";
        if (process.env.DEEPSEEK_API_KEY) {
          const careerName = user.selectedCareer?.title || user.selectedCareer || "your career";
          const explPrompt = `You are PathAI. A student's career alignment score just changed from ${prevScore} to ${newScore} (delta: ${delta > 0 ? '+' : ''}${delta}).
Career: ${careerName}.
Inputs: career match base ${careerBase}/400, 7-day task completion ${tasksScore}/300 (${Math.round(last7Avg*100)}%), streak score ${streakScore}/200 (${currentStreak} days), 30-day consistency ${consScore}/100 (${Math.round(last30Avg*100)}%).
Write ONE sentence (max 20 words) explaining what drove the score change. Be specific. Start with the delta like "+5 this week because..." or "No change — " etc.`;

          try {
            const aiResp = await axios.post(
              "https://api.deepseek.com/v1/chat/completions",
              { model: "deepseek-chat", messages: [{ role: "user", content: explPrompt }] },
              { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" }, timeout: 15000 }
            );
            explanation = aiResp.data.choices[0].message.content.trim();
          } catch (aiErr) {
            console.warn("AI explanation failed, using fallback");
          }
        }

        // ---- Append to history (one entry per day, overwrite if same day) ----
        const existingHistory = (user.scoreHistory || []).filter(h => h.date !== today);
        const newEntry = { date: today, score: newScore, explanation };
        const updatedHistory = [...existingHistory, newEntry]
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-90); // keep last 90 days

        await User.updateOne(
          { email: req.user.email },
          { $set: { alignmentScore: newScore, scoreHistory: updatedHistory } }
        );

        res.json({ score: newScore, delta, explanation, history: updatedHistory });
      } catch (err) {
        console.error("Alignment score error:", err.message);
        res.status(500).json({ error: "Failed to compute score" });
      }
    });

    // ================= SYNC USER DATA =================
    app.get("/user/sync", authenticate, async (req, res) => {
      try {
        const user = await User.findOne({ email: req.user.email }).select("appData");
        res.json(user?.appData || {});
      } catch (err) {
        res.status(500).json({ error: "Failed to load sync data" });
      }
    });

    app.post("/user/sync", authenticate, async (req, res) => {
      try {
        const { goals, moods, plannerTasks, appSettings, chatSessions, scoreCache } = req.body;
        await User.updateOne(
          { email: req.user.email },
          { $set: { appData: { goals, moods, plannerTasks, appSettings, chatSessions, scoreCache } } }
        );
        res.json({ message: "Synced" });
      } catch (err) {
        console.error("Sync error:", err.message);
        res.status(500).json({ error: "Sync failed" });
      }
    });

    // ================= CHAT =================
    app.post("/chat", authenticate, async (req, res) => {
      try {
        const { messages } = req.body; // [{ role: 'user'|'assistant', content: string }]
        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: "messages array required" });
        }

        if (!process.env.DEEPSEEK_API_KEY) {
          return res.status(500).json({ error: "DeepSeek API key missing" });
        }

        const user = await User.findOne({ email: req.user.email }).select(
          "username selectedCareer selectedUniversity bigFiveScores"
        );

        const careerName =
          user?.selectedCareer?.title || user?.selectedCareer || "an undecided career";
        const uniName =
          user?.selectedUniversity?.name || user?.selectedUniversity || "an undecided university";

        const systemPrompt = `You are PathAI, a focused and encouraging career development coach.
The user's name is ${user?.username || "the student"}.
Their chosen career path is: ${careerName}.
Their target university is: ${uniName}.
Your role is to guide them with practical advice, daily check-ins, skill development tips, and motivational support strictly related to their career and academic journey.
Keep responses concise (2-4 sentences max unless they ask for detail). Be warm, direct, and action-oriented.`;

        const aiResponse = await axios.post(
          "https://api.deepseek.com/v1/chat/completions",
          {
            model: "deepseek-chat",
            messages: [
              { role: "system", content: systemPrompt },
              ...messages,
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 30000,
          }
        );

        const reply = aiResponse.data.choices[0].message.content;
        res.json({ reply });
      } catch (err) {
        const detail = err.response?.data || err.message;
        console.error("Chat error:", detail);
        res.status(500).json({ error: "Chat failed", detail: String(detail) });
      }
    });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

startServer();