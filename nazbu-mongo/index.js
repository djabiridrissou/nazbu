'use strict'

/*
 * Public entry for the MongoDB adapter:  require('nazbu/mongo')
 *
 *   const { MongoTenantStore, MongoLedgerStore, Bridge } = require('nazbu/mongo')
 *
 * Most users don't need this directly — `new Nazbu({ db: mongoDb, room })` wires
 * it automatically. It's here for advanced/manual setups.
 */

module.exports = {
  ...require('./stores'),        // MockStore, MongoStore, MockLedger, MongoLedgerStore
  ...require('./tenant-sync'),   // MongoTenantStore
  Bridge: require('./bridge')
}
