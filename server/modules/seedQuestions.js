import mongoose from "mongoose";
import dotenv from "dotenv";
import questions from "./questions.js";

dotenv.config();

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  domain:   { type: String, default: null },
  options:  { type: [String], default: [] },
});

const Question = mongoose.model("Question", questionSchema);

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    const existing = await Question.countDocuments();
    if (existing > 0) {
      console.log(`⚠️  ${existing} questions already exist. Clearing and re-seeding…`);
      await Question.deleteMany({});
    }

    await Question.insertMany(questions);
    console.log(`✅ Inserted ${questions.length} IPIP questions successfully.`);
  } catch (err) {
    console.error("❌ Seeding failed:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected.");
  }
}

seed();
