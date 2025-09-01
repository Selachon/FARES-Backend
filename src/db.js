import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

let client, db;

export async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db("fares");
  await seed(db);
  return db;
}

async function seed(db) {
  const users = db.collection("users");
  const config = db.collection("config");
  // pone un objeto vacío estándar si 'value' no es objeto
  config.insertOne({ value: { INF: "", FOR: "", CERT: "" } });

  if ((await users.countDocuments()) === 0) {
    await users.insertMany([
      {
        username: "admin",
        password: "",
        role: "ADMIN",
        empresa: "FARES",
      },
    ]);
  }
}
