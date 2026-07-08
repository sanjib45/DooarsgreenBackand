/**
 * Migration Script: Add `createdBy` to all existing documents
 * ──────────────────────────────────────────────────────────────
 * Run this ONCE after deploying the data isolation changes.
 *
 * What it does:
 *   1. Assigns all existing documents to a specified owner user
 *   2. Drops old global unique indexes (phone_1 on merchants/buyers)
 *   3. The new compound indexes { phone: 1, createdBy: 1 } will be
 *      auto-created by Mongoose when the server starts
 *
 * Usage:
 *   node scripts/migrate-createdBy.js
 *
 * Before running:
 *   1. Set OWNER_USER_ID below to your primary user's ObjectId
 *      (find it via: db.users.findOne() in MongoDB shell)
 *   2. Make sure your .env file has the correct MONGO_URI
 */

const mongoose = require('mongoose');
const path     = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ══════════════════════════════════════════════════════════════════
// SET THIS to the ObjectId of the user who should own all existing data
const OWNER_USER_ID = '6a489b701bf5a16727044338';
// ══════════════════════════════════════════════════════════════════

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI not found in .env');
  process.exit(1);
}

if (OWNER_USER_ID === 'PASTE_YOUR_USER_OBJECT_ID_HERE') {
  console.error('❌ You must set OWNER_USER_ID in this script before running.');
  console.error('   Find your user ID by running: db.users.findOne() in MongoDB shell');
  process.exit(1);
}

async function migrate() {
  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected');

  const ownerId = new mongoose.Types.ObjectId(OWNER_USER_ID);

  // Collections to update
  const collections = [
    'merchants',
    'merchanttransactions',
    'merchantpayments',
    'merchantadvances',
    'buyers',
    'factories',
    'labors',
    'payments',
    'teamerchants',
  ];

  console.log('\n📦 Step 1: Adding createdBy to all documents...\n');

  for (const col of collections) {
    try {
      const result = await mongoose.connection.db.collection(col).updateMany(
        { createdBy: { $exists: false } },
        { $set: { createdBy: ownerId } }
      );
      console.log(`  ✅ ${col}: updated ${result.modifiedCount} documents`);
    } catch (err) {
      console.error(`  ❌ ${col}: ${err.message}`);
    }
  }

  console.log('\n🗑️  Step 2: Dropping old global unique indexes...\n');

  // Drop old { phone: 1 } unique index on merchants (it's now { phone: 1, createdBy: 1 })
  try {
    await mongoose.connection.db.collection('merchants').dropIndex('phone_1');
    console.log('  ✅ Dropped merchants.phone_1 index');
  } catch (err) {
    if (err.codeName === 'IndexNotFound') {
      console.log('  ⏭️  merchants.phone_1 index already dropped');
    } else {
      console.error('  ⚠️  merchants.phone_1:', err.message);
    }
  }

  // Drop old { phone: 1 } unique index on buyers
  try {
    await mongoose.connection.db.collection('buyers').dropIndex('phone_1');
    console.log('  ✅ Dropped buyers.phone_1 index');
  } catch (err) {
    if (err.codeName === 'IndexNotFound') {
      console.log('  ⏭️  buyers.phone_1 index already dropped');
    } else {
      console.error('  ⚠️  buyers.phone_1:', err.message);
    }
  }

  console.log('\n✅ Migration complete!');
  console.log('   New compound indexes will be created automatically when the server starts.');
  console.log('   Restart your backend server now.\n');

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
