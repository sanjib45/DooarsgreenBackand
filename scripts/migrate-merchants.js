/**
 * migrate-merchants.js
 * Run once: node backend/scripts/migrate-merchants.js
 * Creates Merchant docs from existing merchantName strings and links them.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose           = require('mongoose');
const MerchantTransaction = require('../models/MerchantTransaction');
const Merchant           = require('../models/Merchant');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Starting merchant migration...');

  // Get all unique merchant names (case-insensitive grouping)
  const txns = await MerchantTransaction.find({}, 'merchantName merchant').lean();
  const needsMigration = txns.filter(t => !t.merchant);
  if (needsMigration.length === 0) {
    console.log('✅ All transactions already linked. Nothing to do.');
    return mongoose.disconnect();
  }

  // Group by lowercase name
  const nameMap = {};
  for (const t of needsMigration) {
    const key = t.merchantName.trim().toLowerCase();
    if (!nameMap[key]) nameMap[key] = t.merchantName.trim();
  }

  let created = 0, idx = 1;
  const linkMap = {}; // normalizedName → Merchant._id

  for (const [key, name] of Object.entries(nameMap)) {
    let merchant = await Merchant.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    if (!merchant) {
      merchant = await Merchant.create({ name, phone: `LEGACY-${String(idx++).padStart(3, '0')}` });
      created++;
    }
    linkMap[key] = merchant._id;
  }

  // Update all transactions
  let linked = 0;
  for (const t of needsMigration) {
    const key = t.merchantName.trim().toLowerCase();
    if (linkMap[key]) {
      await MerchantTransaction.updateOne({ _id: t._id }, { $set: { merchant: linkMap[key] } });
      linked++;
    }
  }

  console.log(`✅ Created ${created} merchant(s), linked ${linked} transaction(s).`);
  console.log('⚠️  Update legacy phone numbers (LEGACY-001, LEGACY-002...) with real values.');
  mongoose.disconnect();
}

run().catch(e => { console.error(e); mongoose.disconnect(); });
