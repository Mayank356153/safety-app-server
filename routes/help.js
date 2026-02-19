const express = require("express");
const { db, admin } = require("../firebase");
const { STATUS, MAX_HELPERS } = require("../constants");
const { distanceBetween } = require("geofire-common");

const router = express.Router();


router.post("/create", async (req, res) => {
  const { phone, lat, lng } = req.body;
console.log("Creating help request for", phone, lat, lng);
  await db.collection("help_requests").add({
    phone,
    lat,
    lng,
    status: STATUS.NEED_HELP,
    acceptedCount: 0,
    acceptedBy: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    active: true,
  });

  res.json({ success: true });
});

/**
 * FIND NEARBY HELP REQUESTS (for helpers)
 */
router.post("/nearby", async (req, res) => {
  const { lat, lng, helperId } = req.body;

  const snap = await db
    .collection("help_requests")
    .where("status", "==", STATUS.NEED_HELP)
    .get();

  let result = [];

  snap.forEach(doc => {
    const d = doc.data();

    if (d.acceptedCount >= MAX_HELPERS) return;
    if (d.acceptedBy.includes(helperId)) return;

    const dist = distanceBetween([lat, lng], [d.lat, d.lng]);

    if (dist <= 2) {
      result.push({
        id: doc.id,
        lat: d.lat,
        lng: d.lng,
        distance: dist.toFixed(2),
      });
    }
  });

  res.json(result);
});

/**
 * ACCEPT HELP (ATOMIC – MAX 10)
 */
router.post("/accept", async (req, res) => {
  const { helpId, helperId } = req.body;
  const ref = db.collection("help_requests").doc(helpId);

  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw "Not found";

    const d = doc.data();
    if (d.acceptedCount >= MAX_HELPERS) throw "Limit reached";

    tx.update(ref, {
      acceptedCount: d.acceptedCount + 1,
      acceptedBy: [...d.acceptedBy, helperId],
    });
  });

  res.json({ accepted: true });
});

/**
 * MARK SAFE (from GSM SAFE SMS)
 */
router.post("/safe", async (req, res) => {
  const { phone } = req.body;

  const snap = await db
    .collection("help_requests")
    .where("phone", "==", phone)
    .where("status", "==", STATUS.NEED_HELP)
    .get();

  snap.forEach(doc => {
    doc.ref.update({
      status: STATUS.SAFE,
      active: false,
    });
  });

  res.json({ safe: true });
});

module.exports = router;