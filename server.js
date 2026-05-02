const express = require("express");
const cors = require("cors");
const connectMongo = require("./mongo");
// const db = require("./firebase");
const { db, admin } = require("./firebase");

const app = express();
app.use(cors());
app.use(express.json());

let sensorCollection;
let actuatorCollection;
let notificationCollection;
let lastActuatorData = {};
let tokenCollection;
let cachedTokens = null;

async function getTokens() {
  if (cachedTokens) return cachedTokens;
  cachedTokens = await tokenCollection.find({}).toArray();
  return cachedTokens;
}

function invalidateTokenCache() {
  cachedTokens = null;
}

function validateTimestamp(ts, lastTs) {
  const date = ts instanceof Date ? ts : new Date(ts);

  if (isNaN(date.getTime())) {
    console.error("⚠️ Invalid timestamp received.");
    return false;
  }

  const now = new Date();

  // Prevent future timestamps
  if (date > now) {
    console.warn("⚠️ Skipping: Timestamp is in the future.");
    return false;
  }

  // Ensure monotonic increase
  if (lastTs && date < new Date(lastTs)) {
    console.warn("⚠️ Skipping: Out-of-order packet detected (non-monotonic).");
    return false;
  }

  return true;
}

// ✅ Connect to MongoDB and Firebase
async function start() {
  const mongoDB = await connectMongo();
  sensorCollection = mongoDB.collection("sensor_readings");
  actuatorCollection = mongoDB.collection("actuator_events");
  notificationCollection = mongoDB.collection("notifications");
  console.log("✅ Connected to MongoDB Atlas");

  await sensorCollection.createIndex(
  { timestamp: 1 },
  { expireAfterSeconds: 604800 } 
  );
  await actuatorCollection.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 604800 }
  );
  console.log("🕒 TTL index created for 7-day auto-deletion");

  await actuatorCollection.createIndex({ actuator_id: 1, timestamp: -1 });
  await notificationCollection.createIndex({ type: 1, sensor: 1, resolved: 1 });
  await notificationCollection.createIndex({ is_read: 1 });
  await notificationCollection.createIndex({ created_at: -1 });

  const sensorRef = db.ref("/sensorData");
  const controlsRef = db.ref("/controls");

  tokenCollection = mongoDB.collection("device_tokens");

  let lastSensorTimestamp = null;
  let lastActuatorTimestamp = null;

  const SENSOR_LABELS = {
    temperature: "SHT31 - Temperature Sensor",
    humidity: "SHT31 - Humidity Sensor",
    ammonia: "MQ13 - Ammonia Sensor",
    lightLevel: "BH1750 - Light Sensor"
  };

  // ----- Handle sensor data -----
const handleSensorData = async (sensorData) => {
  try {
    // const ts = getManilaISO(new Date());
    const ts = new Date();
    const isValid = validateTimestamp(ts, lastSensorTimestamp);
    if (!isValid) return;
    lastSensorTimestamp = ts;

    const readings = {};

    for (const [key, value] of Object.entries(sensorData)) {
      const sensorName = SENSOR_LABELS[key] ?? key;

      const isInvalid = typeof value !== "number" || !isFinite(value);
      const sensorMessage = isInvalid ? "Error: Invalid or Missing Reading" : null;

      readings[key] = isInvalid ? null : value;

      const activeFailure = await notificationCollection.findOne({
        type: "SENSOR FAILURE",
        sensor: sensorName,
        resolved: false
      });

      if (isInvalid && !activeFailure) {
        await notificationCollection.insertOne({
          type: "SENSOR FAILURE",
          sensor: sensorName,
          message: sensorMessage,
          severity: "HIGH",
          is_read: false,
          resolved: false,
          created_at: ts
        });

        console.warn(`❌ SENSOR FAILURE DETECTED: ${sensorName}`);

        // 🔔 SEND PUSH NOTIFICATION
        const tokens = await getTokens()

        for (const device of tokens) {
          try {
            await admin.messaging().send({
              token: device.token,
              notification: {
                title: "⚠️ SENSOR FAILURE",
                body: `${sensorName} is not responding`
              },
              android: {
                priority: "high"
              }
            });

            console.log(`📲 Push sent to: ${device.token}`);

          } catch (err) {
            console.error("Push error:", err.message);
            if (err.code === "messaging/registration-token-not-registered") {
              await tokenCollection.deleteOne({ token: device.token });
              invalidateTokenCache();
              console.log("🧹 Removed invalid token:", device.token);
            }
          }
        }
      }

      // ✅ RECOVERY → resolve notification
      if (!isInvalid && activeFailure) {
        await notificationCollection.updateOne(
          { _id: activeFailure._id },
          { $set: { resolved: true, resolved_at: ts } }
        );

        console.log(`✅ SENSOR RECOVERED: ${sensorName}`);
      }
    }

    // Always store snapshot
    await sensorCollection.insertOne({
      timestamp: ts,
      temperature: readings.temperature,
      humidity: readings.humidity,
      ammonia: readings.ammonia,
      light: readings.lightLevel
    });

  } catch (err) {
    console.error("❌ Error writing sensor data:", err);
  }
};

  // ----- Handle actuator data -----
const handleActuatorData = async (controls) => {
  try {
    const actuatorDocs = [];
    const pendingUpdates = {};

    for (const [key, value] of Object.entries(controls)) {
      const lastValue = lastActuatorData[key];
      if (lastValue === value) {
        console.log(`⏸ ${key} unchanged — skipping`);
        continue;
      }

      const ts = new Date();
      const isValid = validateTimestamp(ts, lastActuatorTimestamp);
      if (!isValid) continue;
      lastActuatorTimestamp = ts;

      const doc = {
        actuator_id: key,
        timestamp: ts
      };

      if (typeof value === "boolean") {
        doc.status = value ? "ON" : "OFF";
      } else if (typeof value === "number") {
        if (value < 0 || value > 100) {
          console.warn(`⚠️ Skipping out-of-range value for ${key}:`, value);
          continue;
          }
          doc.value = value;
      } else {
        console.warn(`⚠️ Skipping unknown control type for ${key}:`, value);
        continue;
      }

        actuatorDocs.push(doc);
        pendingUpdates[key] = value;
      }

    if (actuatorDocs.length > 0) {
      await actuatorCollection.insertMany(actuatorDocs);
      Object.assign(lastActuatorData, pendingUpdates);
      console.log("✅ Actuator events inserted:", actuatorDocs);
    }
  } catch (err) {
    console.error("❌ Error writing actuator data:", err);
  }
};

  sensorRef.on("value", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    console.log("🔄 Sensor data:", data);
    await handleSensorData(data);
  });

  controlsRef.on("value", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    console.log("🔄 Controls data:", data);
    await handleActuatorData(data);
  });
  
  const PORT = 5000;
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`)
  );

  const shutdown = async (signal) => {
      console.log(`⚙️ ${signal} received — shutting down`);
      // rootRef.off();
      sensorRef.off();
      controlsRef.off();
      await mongoDB.client.close();
      console.log("✅ MongoDB closed");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
}

start().catch(console.error);

app.post("/api/save-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token missing" });
    }

    await tokenCollection.updateOne(
      { token },
      { $set: { token, createdAt: new Date() } },
      { upsert: true }
    );
    invalidateTokenCache();

    res.json({ message: "Token saved" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ API routes for Flutter
app.get("/api/notifications", async (req, res) => {
  try {
    const notifications = await notificationCollection
      .find({})
      .sort({ created_at: -1 }) // newest first
      .toArray();

    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/notifications/unread-count", async (req, res) => {
  try {
    const count = await notificationCollection.countDocuments({
      is_read: false
    });

    res.json({ unreadCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/mark-all-read
app.put("/api/notifications/mark-all-read", async (req, res) => {
  try {
    const result = await notificationCollection.updateMany(
      { is_read: false },
      { $set: { is_read: true } }
    );

    res.json({
      message: "Notifications marked as read",
      modified: result.modifiedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sensors", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);
    const skip  = parseInt(req.query.skip) || 0;

    const since = req.query.since ? new Date(req.query.since) : null;
    const until = req.query.until ? new Date(req.query.until) : null;

    let filter = {};
    if (since || until) {
      filter.timestamp = {};
      if (since) filter.timestamp.$gte = since; 
      if (until) filter.timestamp.$lt = until;  
    }

    const sensors = await sensorCollection
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json(sensors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/actuators", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const skip  = parseInt(req.query.skip) || 0;
    const id    = req.query.actuator_id || null;

    const since = req.query.since ? new Date(req.query.since) : null;
    const until = req.query.until ? new Date(req.query.until) : null;

    let filter = {};
    if (since || until) {
      filter.timestamp = {};
      if (since) filter.timestamp.$gte = since; 
      if (until) filter.timestamp.$lt = until;  
      if (id)    filter.actuator_id = id;
    }

    const actuators = await actuatorCollection
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json(actuators);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});