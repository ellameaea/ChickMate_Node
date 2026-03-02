// http://localhost:5000/api/actuators
// http://localhost:5000/api/sensors

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

function validateTimestamp(ts, lastTs) {
  if (!ts) {
    throw new Error("Timestamp missing");
  }

  // Check format: must be ISO 8601
  if (isNaN(Date.parse(ts))) {
    throw new Error("Timestamp not correctly formatted");
  }

  const date = new Date(ts);
  const now = new Date();

  // No future dates
  if (date > now) {
    throw new Error("Timestamp is in the future");
  }

  // Monotonic check: must be >= last known timestamp
  if (lastTs && date < new Date(lastTs)) {
    throw new Error("Timestamp is not monotonic (older than last record)");
  }

  return true;
}

// helper: produce an ISO-like timestamp in Asia/Manila with +08:00 offset
function getManilaISO(date = new Date()) {
  // use Intl to get zero-padded components in Manila timezone
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  // compose ISO-like string with +08:00 offset
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}+08:00`;
}

// ✅ Connect to MongoDB and Firebase
async function start() {
  const mongoDB = await connectMongo();
  sensorCollection = mongoDB.collection("sensor_readings");
  actuatorCollection = mongoDB.collection("actuator_events");
  notificationCollection = mongoDB.collection("notifications");
  console.log("✅ Connected to MongoDB Atlas");

  const rootRef = db.ref("/");

  tokenCollection = mongoDB.collection("device_tokens");

  let lastSensorTimestamp = null;

  const SENSOR_LABELS = {
  temperature: "SHT31 - Temperature Sensor",
  humidity: "SHT31 - Humidity Sensor",
  ammonia: "MQ13 - Ammonia Sensor",
  lightLevel: "BH1750 - Light Sensor"
};

  // ----- Handle sensor data -----
const handleSensorData = async (sensorData) => {
  try {
    const ts = getManilaISO(new Date());
    validateTimestamp(ts, lastSensorTimestamp);
    lastSensorTimestamp = ts;

    const readings = {};

    for (const [key, value] of Object.entries(sensorData)) {
      const sensorName = SENSOR_LABELS[key] ?? key;

      const isInvalid =
        value === "Error: Read Failure" ||
        value === "Error: Disconnected" ||
        value == null ||
        typeof value !== "number" ||
        Number.isNaN(value) ||
        value < 0;

      // readings[key] = isInvalid ? null : value;
      readings[key] = value;

      const activeFailure = await notificationCollection.findOne({
        type: "SENSOR FAILURE",
        sensor: sensorName,
        resolved: false
      });

      const sensorMessage = 
      value === "Error: Read Failure" ? "Error: Read Failure" :
      value === "Error: Disconnected" ? "Error: Disconnected" :
      null;

      // 🔔 FAIL → create notification
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
        console.warn(`❌ SENSOR FAILURE DETECTED: ${sensorName}`);

        // 🔔 SEND PUSH NOTIFICATION
        const tokens = await tokenCollection.find({}).toArray();

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
  const actuatorDocs = [];

  for (const [key, value] of Object.entries(controls)) {
    const lastValue = lastActuatorData[key];
    if (lastValue === value) {
      console.log(`⏸ ${key} unchanged — skipping`);
      continue;
    }

    const ts = getManilaISO(new Date());

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
    lastActuatorData[key] = value; // update cache
  }

  if (actuatorDocs.length > 0) {
    await actuatorCollection.insertMany(actuatorDocs);
    console.log("✅ Actuator events inserted:", actuatorDocs);
  }
};

  // ----- Payload type checks -----
  const isSensorPayload = (data) =>
    "temperature" in data || "humidity" in data || "ammonia" in data || "light" in data;

  const isActuatorPayload = (data) =>
    "exhaustFan" in data || "heater" in data || "intakeFan" in data;

  // ----- Listen for new data -----
  rootRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    console.log("🟢 New Firebase data:", data);

    if (isSensorPayload(data)) {
      console.log("📥 Detected flat sensor payload");
      await handleSensorData(data);
    }

    if (isActuatorPayload(data)) {
      console.log("📥 Detected flat actuator payload");
      await handleActuatorData(data);
    }

    if (data.sensorData) {
      console.log("📥 Detected nested sensorData");
      await handleSensorData(data.sensorData);
    }

    if (data.controls) {
      console.log("📥 Detected nested controls");
      await handleActuatorData(data.controls);
    }
  });

  // ----- Listen for updated data -----
  rootRef.on("child_changed", async (snapshot) => {
    const data = snapshot.val();
    console.log("🔄 Updated Firebase data:", data);

    if (isSensorPayload(data)) {
      console.log("📥 Detected flat sensor payload");
      await handleSensorData(data);
    }

    if (isActuatorPayload(data)) {
      console.log("📥 Detected flat actuator payload");
      await handleActuatorData(data);
    }

    if (data.sensorData) {
      console.log("📥 Detected nested sensorData");
      await handleSensorData(data.sensorData);
    }

    if (data.controls) {
      console.log("📥 Detected nested controls");
      await handleActuatorData(data.controls);
    }
  });
}

// GET /api/notifications/unread-count

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
    const sensors = await sensorCollection.find({}).sort({ timestamp: -1 }).toArray();
    res.json(sensors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/actuators", async (req, res) => {
  try {
    const actuators = await actuatorCollection.find({}).sort({ timestamp: -1 }).toArray();
    res.json(actuators);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// const PORT = 5000;
// app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

const PORT = 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`)
);

start().catch(console.error);