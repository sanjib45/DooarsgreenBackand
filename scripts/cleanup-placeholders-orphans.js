/**
 * Cleanup script: placeholder phones + orphan payment docs
 *
 * What it does:
 *  1. Lists merchants/buyers with NO-PHONE-* or LEGACY* phones
 *  2. Deletes MerchantAdvance / MerchantMasterPayment whose merchant no longer exists
 *  3. Optionally (--fix) marks placeholder phones as NEEDS-PHONE-<idSuffix>
 *     so they stay unique but are obvious to fix in UI
 *
 * Usage:
 *   node scripts/cleanup-placeholders-orphans.js           # dry-run (default)
 *   node scripts/cleanup-placeholders-orphans.js --apply  # apply changes
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');
const Buyer = require('../models/Buyer');
const MerchantAdvance = require('../models/MerchantAdvance');
const MerchantMasterPayment = require('../models/MerchantMasterPayment');

const APPLY = process.argv.includes('--apply') || process.argv.includes('--fix');
const PLACEHOLDER_RE = /^(NO-PHONE-|LEGACY|NEEDS-PHONE-)/i;

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  // ── 1. Placeholder phones ───────────────────────────────────────────────
  const badMerchants = await Merchant.find({ phone: PLACEHOLDER_RE }).lean();
  const badBuyers = await Buyer.find({ phone: PLACEHOLDER_RE }).lean();

  console.log(`Placeholder merchants: ${badMerchants.length}`);
  badMerchants.forEach((m) => console.log(`  - ${m._id} | ${m.name} | ${m.phone}`));

  console.log(`\nPlaceholder buyers: ${badBuyers.length}`);
  badBuyers.forEach((b) => console.log(`  - ${b._id} | ${b.name} | ${b.phone}`));

  if (APPLY && (badMerchants.length || badBuyers.length)) {
    for (const m of badMerchants) {
      const next = `NEEDS-PHONE-${String(m._id).slice(-6)}`;
      await Merchant.updateOne({ _id: m._id }, { $set: { phone: next } });
      console.log(`  updated merchant ${m._id} phone → ${next}`);
    }
    for (const b of badBuyers) {
      const next = `NEEDS-PHONE-${String(b._id).slice(-6)}`;
      await Buyer.updateOne({ _id: b._id }, { $set: { phone: next } });
      console.log(`  updated buyer ${b._id} phone → ${next}`);
    }
  }

  // ── 2. Orphan advances / master payments ────────────────────────────────
  const merchantIds = new Set(
    (await Merchant.find({}).select('_id').lean()).map((m) => String(m._id))
  );

  const allAdvances = await MerchantAdvance.find({}).select('_id merchant merchantName').lean();
  const orphanAdvances = allAdvances.filter((a) => !a.merchant || !merchantIds.has(String(a.merchant)));

  const allMasterPays = await MerchantMasterPayment.find({}).select('_id merchant merchantName').lean();
  const orphanPays = allMasterPays.filter((p) => !p.merchant || !merchantIds.has(String(p.merchant)));

  console.log(`\nOrphan advances: ${orphanAdvances.length}`);
  orphanAdvances.forEach((a) => console.log(`  - ${a._id} | merchant=${a.merchant} | ${a.merchantName || ''}`));

  console.log(`\nOrphan master payments: ${orphanPays.length}`);
  orphanPays.forEach((p) => console.log(`  - ${p._id} | merchant=${p.merchant} | ${p.merchantName || ''}`));

  if (APPLY) {
    if (orphanAdvances.length) {
      const ids = orphanAdvances.map((a) => a._id);
      const r = await MerchantAdvance.deleteMany({ _id: { $in: ids } });
      console.log(`\nDeleted orphan advances: ${r.deletedCount}`);
    }
    if (orphanPays.length) {
      const ids = orphanPays.map((p) => p._id);
      const r = await MerchantMasterPayment.deleteMany({ _id: { $in: ids } });
      console.log(`Deleted orphan master payments: ${r.deletedCount}`);
    }
  } else {
    console.log('\nDry-run only. Re-run with --apply to write changes.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
