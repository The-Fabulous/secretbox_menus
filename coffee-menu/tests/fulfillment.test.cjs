// node coffee-menu/tests/fulfillment.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({});
for (const file of ['pickup', 'delivery']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../modules', `${file}.js`), 'utf8'), ctx);
}
const { pickup, delivery } = vm.runInContext('({ pickup: PickupModule, delivery: DeliveryModule })', ctx);
for (const module of [pickup, delivery]) {
  assert.equal(module.config().enabled, false);
  assert.equal(module.config({ enabled: false }).enabled, false);
  assert.equal(module.config({ enabled: 'true' }).enabled, false);
  assert.equal(module.config({ enabled: true }).enabled, true);
}
const p = pickup.config({ enabled: true, ready_minutes: 20 });
assert.equal(pickup.quote(p, 1890, 5).minutes, 20);
assert.equal(pickup.quote(p, 1890, 45).minutes, 45);
assert.equal(pickup.quote(p, 1890, 5).fee, 0);
assert.equal(pickup.quote(p, 1890, 5).total, 1890);
const d = delivery.config({ enabled: true, fee: 700, min_order: 2000, free_from: 10000, travel_minutes: 30 });
assert.equal(delivery.quote(d, 1890, 5).remaining, 110);
assert.equal(delivery.quote(d, 2000, 5).remaining, 0);
assert.equal(delivery.quote(d, 2000, 5).total, 2700);
assert.equal(delivery.quote(d, 2000, 5).minutes, 35);
assert.equal(delivery.quote(d, 9999, 5).fee, 700);
assert.equal(delivery.quote(d, 10000, 5).fee, 0);
assert.equal(delivery.quote(d, 10001, 5).total, 10001);
assert.equal(delivery.quote(delivery.config({fee: 700}), 10000, 5).fee, 700);
assert.equal(delivery.config({fee: -700, min_order: NaN}).fee, 0);
assert.equal(delivery.config({free_from: Infinity}).freeFrom, null);
assert.equal(delivery.validAddress('  '), false);
assert.equal(delivery.validAddress('Тестовая, 10'), true);
console.log('PASS: opt-in modules, pickup preparation, delivery fees/minimum/free threshold, invalid config and address.');
