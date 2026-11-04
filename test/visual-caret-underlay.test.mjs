// Pure PNG comparisons. No browser, screenshot, OCR, HTTP or device.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync, writeFileSync, realpathSync} from 'node:fs';
import vm from 'node:vm';
import {PNG} from 'pngjs';
import {visualCaretEquivalent, validateCaretPolicy} from '../src/visual-caret.js';
import {temp} from './helpers.mjs';

const base = {enabled: true, color: [66, 107, 242], background: [255, 255, 255], colorTolerance: 2,
  maxWidthPoints: 3, minHeightPoints: 8, maxHeightPoints: 48, maxAreaPoints: 144};
const underlay = {mode: 'paired_revealed_grayscale', maxUnderlayPixels: 16,
  minWhiteCoreFraction: .8, minSharedOpacity: .125};
const options = {masks: [{x: .1, y: .45, width: .8, height: .04}],
  valueRegion: {x: .1, y: .1, width: .8, height: .3}, geometry: [100, 200]};
const bar = {x: 60, y: 90, width: 6, height: 114};
const blend = (gray, alpha) => base.color.map(c => Math.round(gray + alpha * (c - gray)));
function pair(t, {grayPixels = 16, gray = 171, alpha = .25, edit} = {}) {
  const dir = realpathSync(temp(t)), revealed = new PNG({width: 300, height: 600}); revealed.data.fill(255);
  for (let n = 0; n < grayPixels; n++) {
    const x = bar.x + Math.floor(n / bar.height), y = bar.y + n % bar.height;
    revealed.data.set([gray, gray, gray, 255], (y * revealed.width + x) * 4);
  }
  const overlaid = new PNG({width: revealed.width, height: revealed.height}); revealed.data.copy(overlaid.data);
  for (let y = bar.y; y < bar.y + bar.height; y++) for (let x = bar.x; x < bar.x + bar.width; x++) {
    const n = (y * revealed.width + x) * 4;
    overlaid.data.set([...blend(revealed.data[n], alpha), 255], n);
  }
  edit?.({revealed, overlaid});
  const files = [revealed, overlaid].map((image, n) => {
    const file = path.join(dir, n + '.png'); writeFileSync(file, PNG.sync.write(image)); return file;
  });
  return {files, dir};
}
const compare = (a, b, permission = underlay) => visualCaretEquivalent(a, b,
  {...options, policy: permission ? {...base, underlay: permission} : base});

test('only explicit paired grayscale authority accepts a common white-core opacity over observed glyph edge', t => {
  const {files: [g, blue]} = pair(t);
  assert.equal(compare(g, blue, null).equivalent, false);
  for (const [a, b] of [[g, blue], [blue, g]]) {
    assert.deepEqual(compare(a, b), {width: 300, height: 600, equivalent: true, mode: 'caret', changedPixels: 684});
  }
  // The entire black/gray glyph is not ignored. Only16 explicitly permitted
  // actually revealed pixels can be explained under the same narrow bar.
  assert.equal(compare(...pair(t, {gray: 0}).files).equivalent, true);
  const strict = pair(t, {grayPixels: 0}).files;
  assert.deepEqual(compare(...strict), compare(...strict, null), 'an existing strict receipt is unchanged');
});

test('two covered endpoints cannot invent an unseen background', t => {
  const {files, dir} = pair(t), full = new PNG({width: 300, height: 600}); full.data.fill(255);
  for (let y = bar.y; y < bar.y + bar.height; y++) for (let x = bar.x; x < bar.x + bar.width; x++)
    full.data.set([...base.color, 255], (y * full.width + x) * 4);
  const file = path.join(dir, 'opaque.png'); writeFileSync(file, PNG.sync.write(full));
  assert.equal(compare(files[1], file).equivalent, false);
});

test('every nonwhite revealed pixel including near-white counts against the local cap', t => {
  const nearWhite = pair(t, {grayPixels: 17, gray: 254, edit: ({revealed, overlaid}) => {
    const n = (bar.y * revealed.width + bar.x) * 4;
    revealed.data.set([171, 171, 171, 255], n); overlaid.data.set([...blend(171, .25), 255], n);
  }});
  // One dark point forces the optional branch; all16 near-white points still
  // count. A pair accepted by the original strict rule remains accepted.
  assert.equal(compare(...nearWhite.files).equivalent, false);
  const alreadyStrict = pair(t, {grayPixels: 17, gray: 254}).files;
  assert.equal(compare(...alreadyStrict, null).equivalent, true);
  assert.deepEqual(compare(...alreadyStrict), compare(...alreadyStrict, null));
  assert.equal(compare(...pair(t, {grayPixels: 17, gray: 171}).files).equivalent, false);
  assert.equal(compare(...pair(t, {grayPixels: 65}).files, {...underlay, maxUnderlayPixels: 64}).equivalent, false);
  assert.equal(compare(...pair(t, {grayPixels: 1}).files, {...underlay, maxUnderlayPixels: 1}).equivalent, true);
});

test('gray values cannot tune the alpha chosen solely from the actual white core', t => {
  const mismatch = pair(t, {edit: ({revealed, overlaid}) => {
    for (let y = bar.y; y < bar.y + 16; y++) {
      const n = (y * revealed.width + bar.x) * 4; overlaid.data.set([...blend(revealed.data[n], .75), 255], n);
    }
  }});
  assert.equal(compare(...mismatch.files).equivalent, false);
  const noCore = pair(t, {edit: ({revealed, overlaid}) => {
    let changed = 0;
    for (let y = bar.y; y < bar.y + bar.height; y++) for (let x = bar.x; x < bar.x + bar.width; x++) {
      const n = (y * revealed.width + x) * 4;
      if (revealed.data[n] === 255 && changed++ < 150) overlaid.data.set([...blend(255, .125), 255], n);
    }
  }});
  assert.equal(compare(...noCore.files).equivalent, false);
  assert.equal(compare(...pair(t, {alpha: .0625}).files).equivalent, false);
});

test('revealed endpoint is global, exact opaque grayscale with no RGB texture or alpha exemption', t => {
  for (const mutate of [
    ({revealed}) => {revealed.data[(bar.y * revealed.width + bar.x) * 4 + 1]++;},
    ({revealed}) => {revealed.data[(bar.y * revealed.width + bar.x) * 4 + 3] = 128;},
    ({overlaid}) => {overlaid.data[(bar.y * overlaid.width + bar.x) * 4 + 3] = 128;},
    ({revealed, overlaid}) => {
      // Alternate which frame reveals each row: no single whole endpoint.
      for (let y = bar.y; y < bar.y + bar.height; y += 2) for (let x = bar.x; x < bar.x + bar.width; x++) {
        const n = (y * revealed.width + x) * 4;
        const value = Buffer.from(revealed.data.subarray(n, n + 4));
        overlaid.data.copy(revealed.data, n, n, n + 4); value.copy(overlaid.data, n);
      }
    },
  ]) assert.equal(compare(...pair(t, {edit: mutate}).files).equivalent, false);
});

test('all old ROI, component, size, color and full application pixel checks remain', t => {
  for (const mutate of [
    ({overlaid}) => {overlaid.data.set([0, 0, 0, 255], (80 * overlaid.width + 150) * 4);},
    ({overlaid}) => {overlaid.data.set([0, 0, 0, 255], (300 * overlaid.width + 5) * 4);},
    ({overlaid}) => {overlaid.data[(bar.y * overlaid.width + bar.x) * 4 + 1] += 8;},
    ({revealed, overlaid}) => {
      for (let x = bar.x; x < bar.x + bar.width; x++) {
        const n = ((bar.y + 50) * revealed.width + x) * 4; revealed.data.copy(overlaid.data, n, n, n + 4);
      }
    },
  ]) assert.equal(compare(...pair(t, {edit: mutate}).files).equivalent, false);
  const files = pair(t).files;
  assert.equal(visualCaretEquivalent(...files, {...options, policy: {...base, maxWidthPoints: 1, underlay}}).equivalent, false);
  assert.equal(visualCaretEquivalent(...files, {...options, policy: {...base, maxHeightPoints: 37, underlay}}).equivalent, false);
});

test('optional authority has exact schema and finite hard caps without changing the strict eight fields', () => {
  assert.equal(validateCaretPolicy(base), base);
  assert.deepEqual(validateCaretPolicy({...base, underlay}).underlay, underlay);
  for (const value of [null, {...underlay, mode: 'auto'}, {...underlay, extra: true},
    {...underlay, maxUnderlayPixels: true}, {...underlay, maxUnderlayPixels: 0}, {...underlay, maxUnderlayPixels: 65},
    {...underlay, maxUnderlayPixels: 1.5}, {...underlay, minWhiteCoreFraction: .79}, {...underlay, minWhiteCoreFraction: 1.01},
    {...underlay, minSharedOpacity: .124}, {...underlay, minSharedOpacity: Infinity},
    {...underlay, minWhiteCoreFraction: NaN}, {...underlay, minSharedOpacity: true}])
    assert.throws(() => validateCaretPolicy({...base, underlay: value}), {code: 'VISUAL_CARET_CONFIG_INVALID'});
  for (const policy of [{...base, background: [254, 254, 254], underlay}, {...base, color: [0, 0, 0], underlay}])
    assert.throws(() => validateCaretPolicy(policy), {code: 'VISUAL_CARET_CONFIG_INVALID'});
});

test('bad PNG, coordinate and schema errors cannot become an ordinary underlay miss', t => {
  const {files: [g, overlaid], dir} = pair(t);
  assert.equal(compare(g, overlaid).equivalent, true);
  const bytes = Buffer.from(readFileSync(overlaid)); bytes[bytes.length - 1] ^= 1;
  const broken = path.join(dir, 'broken.png'); writeFileSync(broken, bytes);
  assert.throws(() => compare(g, broken), {code: 'VISUAL_PIXELS_INVALID'});
  assert.throws(() => visualCaretEquivalent(g, overlaid, {...options, geometry: [100, 100], policy: {...base, underlay}}),
    {code: 'VISUAL_COORDINATES_UNVERIFIED'});
  assert.throws(() => visualCaretEquivalent(g, overlaid, {...options, masks: [options.valueRegion], policy: {...base, underlay}}),
    {code: 'VISUAL_CARET_CONFIG_INVALID'});
});

test('actual optional comparator revisits exactly the same two owned decoded snapshots', t => {
  const {files: [g, overlaid]} = pair(t);
  const decoded = new Map([[g, PNG.sync.read(readFileSync(g))], [overlaid, PNG.sync.read(readFileSync(overlaid))]]);
  const source = readFileSync(new URL('../src/visual-caret.js', import.meta.url), 'utf8');
  const schema = source.slice(source.indexOf('export function validateCaretPolicy('), source.indexOf('function fileBytes('));
  const comparator = source.slice(source.indexOf('function approvedColor('));
  const reads = [];
  const context = vm.createContext({object: value => value && typeof value === 'object' && !Array.isArray(value),
    number: value => typeof value === 'number' && Number.isFinite(value),
    invalid: () => { throw Error('bad config'); }, fail: code => { throw Error(code); },
    image: file => { reads.push(file); assert(reads.length <= 2, 'no pathname reread in fallback'); return decoded.get(file); }});
  vm.runInContext((schema + comparator).replace(/^export /gm, ''), context);
  const result = context.visualCaretEquivalent(g, overlaid, {...options, policy: {...base, underlay}});
  assert.equal(result.equivalent, true); assert.equal(result.changedPixels, 684);
  assert.deepEqual(reads, [g, overlaid]);
});

const original = process.env.BFS_IOS_CARET_REFERENCE_PNG;
const covered = process.env.BFS_IOS_CARET_COVERED_PNG;
const revealed = process.env.BFS_IOS_CARET_REVEALED_PNG;
test('optional retained ordinary UIKit frames keep both strict rejections and accept only the actually revealed endpoint',
  {skip: !(original && covered && revealed)}, () => {
    const opts = {masks: [{x: .05, y: .47, width: .9, height: .12}],
      valueRegion: {x: .05, y: .2, width: .9, height: .08}, geometry: [402, 874]};
    for (const other of [covered, revealed]) assert.equal(visualCaretEquivalent(original, other, {...opts, policy: base}).equivalent, false);
    assert.deepEqual(visualCaretEquivalent(original, covered, {...opts, policy: {...base, underlay}}),
      {width: 1206, height: 2622, equivalent: false, mode: 'changed', changedPixels: 682});
    assert.deepEqual(visualCaretEquivalent(original, revealed, {...opts, policy: {...base, underlay}}),
      {width: 1206, height: 2622, equivalent: true, mode: 'caret', changedPixels: 682});
  });
