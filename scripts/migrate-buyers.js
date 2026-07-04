/**
 * migrate-buyers.js
 * Run once: node backend/scripts/migrate-buyers.js
 * Creates Buyer docs from existing buyerName strings and links them.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Factory  = require('../models/Factory');
const Buyer    = require('../models/Buyer');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Starting buyer migration...');

  const records = await Factory.find({}, 'buyerName buyer').lean();
  const needsMigration = records.filter(r => !r.buyer);
  if (needsMigration.length === 0) {
    console.log('✅ All factory records already linked. Nothing to do.');
    return mongoose.disconnect();
  }

  const nameMap = {};
  for (const r of needsMigration) {
    const key = r.buyerName.trim().toLowerCase();
    if (!nameMap[key]) nameMap[key] = r.buyerName.trim();
  }

  let created = 0, idx = 1;
  const linkMap = {};

  for (const [key, name] of Object.entries(nameMap)) {
    let buyer = await Buyer.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    if (!buyer) {
      buyer = await Buyer.create({ name, phone: `LEGACY-B${String(idx++).padStart(3, '0')}` });
      created++;
    }
    linkMap[key] = buyer._id;
  }

  let linked = 0;
  for (const r of needsMigration) {
    const key = r.buyerName.trim().toLowerCase();
    if (linkMap[key]) {
      await Factory.updateOne({ _id: r._id }, { $set: { buyer: linkMap[key] } });
      linked++;
    }
  }

  console.log(`✅ Created ${created} buyer(s), linked ${linked} factory record(s).`);
  console.log('⚠️  Update legacy phone numbers with real values.');
  mongoose.disconnect();
}

run().catch(e => { console.error(e); mongoose.disconnect(); });
