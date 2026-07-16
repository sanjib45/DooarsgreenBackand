/**
 * Repair DB relationship integrity after moving to production-safe refs/indexes.
 *
 * Dry-run:
 *   node scripts/repair-db-relationships.js
 *
 * Apply:
 *   node scripts/repair-db-relationships.js --apply
 *
 * Repairs:
 *   - Drops old global unique indexes: transactionId_1, paymentId_1
 *   - Creates per-user unique indexes for transaction/payment/advance IDs
 *   - Links MerchantTransaction.merchant from merchantPhone where possible
 *   - Links Factory.buyer from exact buyerName match where possible
 *   - Deletes transaction payments whose parent transaction no longer exists
 *   - Recalculates every transaction balance from scoped payments
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');
const Buyer = require('../models/Buyer');
const MerchantTransaction = require('../models/MerchantTransaction');
const MerchantPayment = require('../models/MerchantPayment');
const MerchantAdvance = require('../models/MerchantAdvance');
const MerchantMasterPayment = require('../models/MerchantMasterPayment');
const Factory = require('../models/Factory');

const APPLY = process.argv.includes('--apply');
const PLACEHOLDER_RE = /^(NO-PHONE-|LEGACY|NEEDS-PHONE-)/i;

async function dropIndexIfExists(model, name) {
  const indexes = await model.collection.indexes();
  if (!indexes.some((idx) => idx.name === name)) return false;
  if (APPLY) await model.collection.dropIndex(name);
  return true;
}

async function ensureIndex(model, spec, options) {
  if (APPLY) await model.collection.createIndex(spec, options);
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const droppedTxnIndex = await dropIndexIfExists(MerchantTransaction, 'transactionId_1');
  const droppedPayIndex = await dropIndexIfExists(MerchantPayment, 'paymentId_1');
  const droppedAdvanceIndex = await dropIndexIfExists(MerchantAdvance, 'advanceId_1');
  const droppedMasterPayIndex = await dropIndexIfExists(MerchantMasterPayment, 'paymentId_1');
  console.log(`${APPLY ? 'Dropped' : 'Would drop'} transactionId_1: ${droppedTxnIndex}`);
  console.log(`${APPLY ? 'Dropped' : 'Would drop'} merchant payment paymentId_1: ${droppedPayIndex}`);
  console.log(`${APPLY ? 'Dropped' : 'Would drop'} advanceId_1: ${droppedAdvanceIndex}`);
  console.log(`${APPLY ? 'Dropped' : 'Would drop'} master payment paymentId_1: ${droppedMasterPayIndex}`);

  await ensureIndex(MerchantTransaction, { createdBy: 1, transactionId: 1 }, { unique: true, name: 'createdBy_1_transactionId_1' });
  await ensureIndex(MerchantPayment, { createdBy: 1, paymentId: 1 }, { unique: true, name: 'createdBy_1_paymentId_1' });
  await ensureIndex(MerchantAdvance, { createdBy: 1, advanceId: 1 }, { unique: true, name: 'createdBy_1_advanceId_1' });
  await ensureIndex(MerchantMasterPayment, { createdBy: 1, paymentId: 1 }, { unique: true, name: 'createdBy_1_paymentId_1' });
  console.log(`${APPLY ? 'Ensured' : 'Would ensure'} per-user unique indexes\n`);

  let linkedTxns = 0;
  let txnNeedsPhone = 0;
  const txns = await MerchantTransaction.find({}).lean();
  for (const txn of txns) {
    if (txn.merchant && txn.merchantPhone && txn.merchantName) continue;

    const phone = String(txn.merchantPhone || '').trim();
    if (!phone || PLACEHOLDER_RE.test(phone)) {
      txnNeedsPhone++;
      console.log(`Needs merchant phone: txn=${txn._id} merchantName="${txn.merchantName || ''}" phone="${phone}"`);
      continue;
    }

    let merchant = await Merchant.findOne({ createdBy: txn.createdBy, phone });
    if (!merchant && APPLY) {
      merchant = await Merchant.create({
        createdBy: txn.createdBy,
        name: String(txn.merchantName || phone).trim(),
        phone,
      });
    }

    if (merchant) {
      linkedTxns++;
      if (APPLY) {
        await MerchantTransaction.updateOne(
          { _id: txn._id },
          { $set: { merchant: merchant._id, merchantName: merchant.name, merchantPhone: merchant.phone } }
        );
      }
    }
  }
  console.log(`\n${APPLY ? 'Linked' : 'Would link'} merchant transactions: ${linkedTxns}`);
  console.log(`Transactions needing real phone: ${txnNeedsPhone}`);

  let linkedFactories = 0;
  let factoryNeedsBuyer = 0;
  const factories = await Factory.find({}).lean();
  for (const sale of factories) {
    if (sale.buyer) continue;
    const buyerName = String(sale.buyerName || '').trim();
    if (!buyerName) {
      factoryNeedsBuyer++;
      console.log(`Needs buyer name: factory=${sale._id}`);
      continue;
    }

    const buyers = await Buyer.find({
      createdBy: sale.createdBy,
      name: new RegExp(`^${buyerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).lean();

    if (buyers.length === 1) {
      linkedFactories++;
      if (APPLY) {
        await Factory.updateOne(
          { _id: sale._id },
          { $set: { buyer: buyers[0]._id, buyerName: buyers[0].name } }
        );
      }
    } else {
      factoryNeedsBuyer++;
      console.log(`Needs buyer selection: factory=${sale._id} buyerName="${buyerName}" matches=${buyers.length}`);
    }
  }
  console.log(`\n${APPLY ? 'Linked' : 'Would link'} factory records: ${linkedFactories}`);
  console.log(`Factory records needing buyer selection: ${factoryNeedsBuyer}`);

  const txnIds = new Set((await MerchantTransaction.find({}).select('_id').lean()).map((t) => String(t._id)));
  const allPayments = await MerchantPayment.find({}).select('_id transaction createdBy').lean();
  const orphanPayments = allPayments.filter((p) => !p.transaction || !txnIds.has(String(p.transaction)));
  console.log(`\nOrphan transaction payments: ${orphanPayments.length}`);
  if (APPLY && orphanPayments.length) {
    await MerchantPayment.deleteMany({ _id: { $in: orphanPayments.map((p) => p._id) } });
    console.log(`Deleted orphan transaction payments: ${orphanPayments.length}`);
  }

  let balancesRecalculated = 0;
  for (const txn of await MerchantTransaction.find({}).select('_id createdBy finalPayable').lean()) {
    const payments = await MerchantPayment.find({ transaction: txn._id, createdBy: txn.createdBy }).select('amount').lean();
    const totalPaid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const balance = Math.round(((Number(txn.finalPayable) || 0) - totalPaid) * 100) / 100;
    balancesRecalculated++;
    if (APPLY) await MerchantTransaction.updateOne({ _id: txn._id }, { $set: { balance } });
  }
  console.log(`${APPLY ? 'Recalculated' : 'Would recalculate'} balances: ${balancesRecalculated}`);

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
