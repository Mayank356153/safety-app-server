import dns from 'node:dns';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ServerApiVersion } from 'mongodb';

// 1. Fix DNS resolution for Node 24+
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// const uri =  "mongodb+srv://shee:lgSlu550zs0d8Qri@cluster0.6gv8hv9.mongodb.net/safety_server?retryWrites=true&w=majority";
const uri =  process.env.MONGO_URI;
console.log(uri);
// 2. Mongoose Connection (Best practice for the whole app)
mongoose.connect(uri)
  .then(() => console.log("✅ Mongoose connected to MongoDB Atlas"))
  .catch(err => console.error("❌ Mongoose connection error:", err.message));

// 3. Optional MongoClient Ping (Agar aapko sirf connection test karna hai)
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function runPing() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("📡 MongoDB Atlas Pinged Successfully!");
  } finally {
    await client.close();
  }
}
runPing().catch(console.dir);


// ========== SCHEMAS ==========

// User Schema
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // Phone number
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  accuracy: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  registeredAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
},{timestamps: true});

// Alert Schema
const AlertSchema = new mongoose.Schema({
  alertId: { type: String, required: true, unique: true },
  sender: { type: String, required: true },
  senderId: { type: String, required: true },
  message: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  resolved: { type: Boolean, default: false },
  notifiedUsers: [{ 
    userId: String, 
    distance: Number,
    notifiedAt: Date 
  }],
  active: { type: Boolean, default: true },
  accept:{type:Number,default:0}
},{timestamps: true});

// Location History Schema
const LocationHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  accuracy: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
},{timestamps: true});

const User = mongoose.model('User', UserSchema);
const Alert = mongoose.model('Alert', AlertSchema);
const LocationHistory = mongoose.model('LocationHistory', LocationHistorySchema);

// ========== HELPER FUNCTIONS ==========

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Find nearby active alerts for a user
async function checkNearbyAlerts(userId, userLat, userLon) {
  try {
    // Get all active alerts
    const activeAlerts = await Alert.find({ 
      active: true, 
      resolved: false 
    });

    const nearbyAlerts = [];

    for (const alert of activeAlerts) {
      const distance = calculateDistance(
        userLat, userLon,
        alert.latitude, alert.longitude
      );

      if (distance <= 5) { // Within 5km
        // Check if user was already notified
        const alreadyNotified = alert.notifiedUsers.some(
          u => u.userId === userId
        );

        if (!alreadyNotified) {
          nearbyAlerts.push({
            alertId: alert.alertId,
            sender: alert.sender,
            message: alert.message,
            latitude: alert.latitude,
            longitude: alert.longitude,
            distance: distance,
            timestamp: alert.timestamp
          });

          // Mark user as notified
          alert.notifiedUsers.push({
            userId: userId,
            distance: distance,
            notifiedAt: new Date()
          });
          await alert.save();
        }
      }
    }

    return nearbyAlerts;
  } catch (error) {
    console.error('Error checking nearby alerts:', error);
    return [];
  }
}

// ========== API ENDPOINTS ==========

// Register User
app.post('/api/user/register', async (req, res) => {
  try {
    const { phone, name, latitude, longitude } = req.body;

    // Check if user already exists
    let user = await User.findOne({ phone });

    if (user) {
      // Update existing user
      user.name = name;
      user.latitude = latitude;
      user.longitude = longitude;
      user.lastUpdated = new Date();
      await user.save();
      
      console.log(`✅ User updated: ${phone}`);
      return res.json({ 
        success: true, 
        message: 'User updated',
        userId: user.userId 
      });
    }

    // Create new user
    user = new User({
      userId: phone,
      name,
      phone,
      latitude,
      longitude,
      registeredAt: new Date(),
      lastUpdated: new Date()
    });

    await user.save();
    console.log(`✅ New user registered: ${phone}`);

    res.json({ 
      success: true, 
      message: 'User registered successfully',
      userId: user.userId 
    });
  } catch (error) {
    console.error('❌ Error registering user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update User Location
// Update User Location
app.post('/api/location/update', async (req, res) => {
  try {
    const { userId, latitude, longitude, accuracy } = req.body;

    console.log(`📍 Location update from: ${userId} at ${latitude}, ${longitude}`);

    // Update user location
    const user = await User.findOneAndUpdate(
      { userId },
      { 
        latitude, 
        longitude, 
        accuracy: accuracy || 0,
        lastUpdated: new Date() 
      },
      { upsert: true, new: true }
    );

    // Save to location history
    const history = new LocationHistory({
      userId,
      latitude,
      longitude,
      accuracy: accuracy || 0,
      timestamp: new Date()
    });
    await history.save();

    // *** NEW: Check for nearby alerts ***
    const nearbyAlerts = await checkNearbyAlerts(userId, latitude, longitude);

    if (nearbyAlerts.length > 0) {
      console.log(`🚨 User ${userId} is near ${nearbyAlerts.length} alert(s)!`);
      
      // Log each alert
      nearbyAlerts.forEach((alert, i) => {
        console.log(`  Alert ${i+1}: ${alert.sender} - ${alert.distance.toFixed(2)}km away`);
      });
    }

    res.json({ 
      success: true,
      message: 'Location updated',
      nearbyAlerts: nearbyAlerts  // *** Send back nearby alerts ***
    });
  } catch (error) {
    console.error('❌ Error updating location:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/getalert/accept/:alertId",async(req,res)=>{
  try{
    const{alertId}=req.params;
    if(!alertId){
      return res.status(400).json({success:false,error:'Alert ID is required'});
    }
    const alert=await Alert.findOne({alertId});
    if(!alert){ 
      return res.status(404).json({success:false,error:'Alert not found'});
    }
    res.json({success:true,acceptCount:alert.accept});
  }catch(error){
     console.error('❌ Error fetching alert accept count:',error);
     res.status(500).json({success:false,error:error.message});
  }
});

app.put("/api/alert/accept/:alertId",async(req,res)=>{
  try{
    const{alertId}=req.params;
    if(!alertId){
      return res.status(400).json({success:false,error:'Alert ID is required'});
    }
    const alert=await Alert.findOne({alertId});
    if(!alert){
      return res.status(404).json({success:false,error:'Alert not found'});
    }
    alert.accept+=1;
    await alert.save();
    console.log(`✅ Alert accepted: ${alertId}`);
    res.json({success:true,message:'Alert accepted',acceptCount:alert.accept});
  }catch(error){
    console.error('❌ Error accepting alert:',error);
    res.status(500).json({success:false,error:error.message});
  }
});

// Create Emergency Alert
app.post('/api/emergency/alert', async (req, res) => {
  try {
    const { sender, senderId, message, latitude, longitude } = req.body;

    console.log('\n🚨🚨🚨 EMERGENCY ALERT RECEIVED! 🚨🚨🚨');
    console.log(`From: ${sender} (${senderId})`);
    console.log(`Location: ${latitude}, ${longitude}`);
    console.log(`Message: ${message}`);

    // Create alert
    const alert = new Alert({
      alertId: `alert_${Date.now()}`,
      sender,
      senderId,
      message,
      latitude,
      longitude,
      timestamp: new Date(),
      active: true,
      resolved: false
    });

    await alert.save();

    console.log(`✅ Alert saved: ${alert.alertId}`);

    // Find nearby users with expanding radius
    let radiusKm = 2;
    const maxRadius = 10;
    const minUsers = 3;
    let nearbyUsers = [];

    while (nearbyUsers.length < minUsers && radiusKm <= maxRadius) {
      console.log(`\n🔍 Searching within ${radiusKm}km...`);

      const allUsers = await User.find({ isActive: true });

      nearbyUsers = [];

      for (const user of allUsers) {
        // Skip sender
        if (user.userId === senderId) continue;

        const distance = calculateDistance(
          latitude, longitude,
          user.latitude, user.longitude
        );

        if (distance <= radiusKm) {
          nearbyUsers.push({
            userId: user.userId,
            name: user.name,
            phone: user.phone,
            distance: distance
          });
        }
      }

      nearbyUsers.sort((a, b) => a.distance - b.distance);
      console.log(`✅ Found ${nearbyUsers.length} users within ${radiusKm}km`);

      if (nearbyUsers.length < minUsers && radiusKm < maxRadius) {
        radiusKm += 1;
      } else {
        break;
      }
    }

    // Update alert with notified users
    alert.notifiedUsers = nearbyUsers.map(u => ({
      userId: u.userId,
      distance: u.distance,
      notifiedAt: new Date()
    }));
    await alert.save();

    console.log('\n👥 Notifying users:');
    nearbyUsers.forEach((user, i) => {
      console.log(`  ${i+1}. ${user.name} (${user.phone}) - ${user.distance.toFixed(2)}km`);
    });

    console.log('\n✅ Alert processing complete!');
    console.log('═══════════════════════════════════════\n');

    res.json({
      success: true,
      alertId: alert.alertId,
      notifiedUsers: nearbyUsers.length,
      radius: radiusKm,
      users: nearbyUsers
    });
  } catch (error) {
    console.error('❌ Error creating alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Active Alerts
app.get('/api/alerts/active', async (req, res) => {
  try {
    const alerts = await Alert.find({ 
      active: true, 
      resolved: false 
    }).sort({ timestamp: -1 }).limit(20);

    res.json({ success: true, alerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Nearby Alerts for User
app.get('/api/alerts/nearby/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const activeAlerts = await Alert.find({ 
      active: true, 
      resolved: false 
    });

    const nearbyAlerts = activeAlerts
      .map(alert => {
        const distance = calculateDistance(
          user.latitude, user.longitude,
          alert.latitude, alert.longitude
        );
        return { ...alert.toObject(), distance };
      })
      .filter(alert => alert.distance <= 10)
      .sort((a, b) => a.distance - b.distance);

    res.json({ success: true, alerts: nearbyAlerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resolve Alert
app.post('/api/alert/resolve/:alertId', async (req, res) => {
  try {
    const { alertId } = req.params;

    await Alert.findOneAndUpdate(
      { alertId },
      { resolved: true, active: false }
    );

    console.log(`✅ Alert resolved: ${alertId}`);
    res.json({ success: true, message: 'Alert resolved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get User Info
app.get('/api/user/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get All Users (for testing)
app.get('/api/users/all', async (req, res) => {
  try {
    const users = await User.find().select('-__v');
    res.json({ success: true, count: users.length, users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    message: 'Safety Alert Server Running',
    timestamp: new Date().toISOString() 
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 Safety Alert Server Started!');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 API: http://localhost:${PORT}`);
  console.log(`📊 MongoDB: Connected`);
  console.log('═══════════════════════════════════════\n');
});