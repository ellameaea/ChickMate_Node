const { MongoClient } = require("mongodb");

const uri = "mongodb+srv://chickmateproject_db_user:dhosEc4HsiJUW3h3@chickmate.myyiexi.mongodb.net/?appName=ChickMate"; 
const client = new MongoClient(uri);

async function connectMongo() {
  await client.connect();
  console.log("✅ Connected to MongoDB Atlas");
  return client.db("ChickMate"); // Database name
}

module.exports = connectMongo;

// 🧪 If run directly, test the connection
if (require.main === module) {
  (async () => {
    const mongoDB = await connectMongo();
    console.log("📂 Using database:", mongoDB.databaseName);

    const collections = await mongoDB.listCollections().toArray();
    console.log("📁 Available collections:", collections.map(c => c.name));
  })().catch(console.error);
}
