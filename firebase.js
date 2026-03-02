require("dotenv").config(); // only works in local dev; production uses real env vars 

const admin = require("firebase-admin"); 

// Load values from environment variables 
const serviceAccount = { 
	projectId: process.env.FIREBASE_PROJECT_ID, 
	clientEmail: process.env.FIREBASE_CLIENT_EMAIL, 
	privateKey: process.env.FIREBASE_PRIVATE_KEY 
		? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") 
		: undefined, 
}; 

admin.initializeApp({ 
	credential: admin.credential.cert(serviceAccount), 
	databaseURL: "https://chickmate-ef0a0-default-rtdb.asia-southeast1.firebasedatabase.app", 
}); 

const db = admin.database(); 
module.exports = {
  db,
  admin
};

// require("dotenv").config(); // only works in local dev; production uses real env vars

// const admin = require("firebase-admin");

// // Load values from environment variables
// const serviceAccount = {
//   projectId: process.env.FIREBASE_PROJECT_ID,
//   clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
//   privateKey: process.env.FIREBASE_PRIVATE_KEY
//     ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
//     : undefined,
// };

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   databaseURL: "https://chickmate-ef0a0-default-rtdb.asia-southeast1.firebasedatabase.app",
// });

// const db = admin.database();
// module.exports = db;