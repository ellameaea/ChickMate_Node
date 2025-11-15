const db = require("./firebase");
const connectMongo = require("./mongo");

let lastActuatorData = {};

async function start() {
  const mongoDB = await connectMongo();

  const sensorCollection = mongoDB.collection("sensor_readings");
  const actuatorCollection = mongoDB.collection("actuator_events");

  const rootRef = db.ref("/");

  // ----- Insert sensor data -----
  const handleSensorData = async (sensorData) => {
    try {
      const doc = {
        timestamp: new Date().toISOString(),
        temperature: sensorData.temperature ?? null,
        humidity: sensorData.humidity ?? null,
        ammonia: sensorData.ammonia ?? null,
        light: sensorData.lightLevel ?? null
      };
      await sensorCollection.insertOne(doc);
      console.log("✅ Sensor data inserted:", doc);
    } catch (err) {
      console.error("❌ Error writing sensor data:", err);
    }
  };

    // ----- Insert actuator data -----
const handleActuatorData = async (controls) => {
  const actuatorDocs = [];

  for (const [key, value] of Object.entries(controls)) {
    const lastValue = lastActuatorData[key];
    if (lastValue === value) {
      console.log(`⏸ ${key} unchanged — skipping`);
      continue;
    }

    const doc = {
      actuator_id: key,
      timestamp: new Date().toISOString()
    };

    if (typeof value === "boolean") {
      doc.status = value ? "ON" : "OFF";
    } else if (typeof value === "number") {
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

start().catch(console.error);
