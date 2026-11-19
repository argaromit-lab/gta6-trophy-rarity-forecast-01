import assert from 'node:assert/strict';
import { scoreCase } from '../tools/grade-reference.mjs';

const rows = [{ id: 1, q: [10, 15, 20, 25, 35] }, { id: 2, q: [10, 15, 20, 25, 35] }];
const example = scoreCase(rows, [22, 8]);
assert.ok(Math.abs(example.lossSum / example.items - .403404) < .000001);
assert.equal(example.missSum / example.trophies, 7);
assert.equal(example.coverage / example.trophies, .5);
assert.equal(scoreCase([{ id: 1, q: [22, 22, 22, 22, 22] }], [22]).lossSum, 0);
assert.throws(() => scoreCase(rows, [22]), /one rate/);
assert.throws(() => scoreCase(rows, [22, NaN]), /finite/);
assert.throws(() => scoreCase([{ id: 1, q: [5, 3, 7, 8, 9] }], [6]), /quantiles/);
assert.equal(scoreCase([{ id: 1, q: [0, 0, 0, 0, 0] }], [0]).lossSum, 0);
assert.equal(scoreCase([{ id: 1, q: [100, 100, 100, 100, 100] }], [100]).lossSum, 0);
console.log('RESULT reference scorer matches official worked example and validates boundaries; 0 failures');
