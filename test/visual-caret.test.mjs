import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync, writeFileSync, realpathSync, symlinkSync, mkdirSync} from 'node:fs';
import {PNG} from 'pngjs';
import CrcCalculator from 'pngjs/lib/crc.js';
import {visualCaretEquivalent, validateCaretPolicy} from '../src/visual-caret.js';
import {temp} from './helpers.mjs';

const policy = {enabled: true, color: [66, 107, 242], background: [255, 255, 255], colorTolerance: 2,
  maxWidthPoints: 3, minHeightPoints: 8, maxHeightPoints: 48, maxAreaPoints: 144};
const valueRegion = {x: .1, y: .1, width: .8, height: .3};
const masks = [{x: 0, y: .5, width: 1, height: .5}, {x: .1, y: .45, width: .8, height: .04}];
const options = {masks, valueRegion, geometry: [100, 200], policy};
function picture(dir, name, edits = [], scale = 3) {
  const png = new PNG({width: 100 * scale, height: 200 * scale}); png.data.fill(255);
  for (const {x, y, width = 1, height = 1, color = policy.color} of edits) {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++)
      png.data.set([...color, ...(color.length === 3 ? [255] : [])], (row * png.width + column) * 4);
  }
  const file = path.join(dir, name + '.png'); writeFileSync(file, PNG.sync.write(png)); return file;
}
const bar = {x: 60, y: 90, width: 6, height: 114};
const compare = (before, after, extra = {}) => visualCaretEquivalent(before, after, {...options, ...extra});

test('approved opaque caret fade accepts every changed pixel on the fixed color line', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white'), faded = picture(dir, 'faded', [{...bar, color: [114, 144, 246]}]), blue = picture(dir, 'blue', [bar]);
  assert.deepEqual(compare(white, white), {width: 300, height: 600, equivalent: true, mode: 'exact', changedPixels: 0});
  for (const pair of [[white, faded], [faded, blue], [blue, white]]) {
    const result = compare(...pair); assert.equal(result.equivalent, true); assert.equal(result.mode, 'caret'); assert.equal(result.changedPixels, 684);
  }
  // A one-pixel rounded corner does not break row continuity or density.
  const rounded = picture(dir, 'rounded', [bar, {x: 60, y: 90, color: policy.background}]);
  assert.equal(compare(white, rounded).changedPixels, 683); assert.equal(compare(white, rounded).equivalent, true);
});

test('point limits use the verified screenshot scale, with no fixed pixel-size bypass', t => {
  const dir = realpathSync(temp(t));
  for (const scale of [1, 2, 3]) {
    const white = picture(dir, 'white-' + scale, [], scale), caret = picture(dir, 'caret-' + scale, [{x: 20 * scale, y: 30 * scale, width: 2 * scale, height: 38 * scale}], scale);
    assert.equal(compare(white, caret).equivalent, true);
    assert.equal(compare(white, caret, {policy: {...policy, maxWidthPoints: 1}}).equivalent, false);
    assert.equal(compare(white, caret, {policy: {...policy, maxHeightPoints: 37}}).equivalent, false);
    assert.equal(compare(white, caret, {policy: {...policy, maxAreaPoints: 75}}).equivalent, false);
  }
});

test('black glyphs, fixed app pixels, selection, alpha and off-line colors remain changes', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white');
  const variants = [
    [{...bar, color: [0, 0, 0]}],
    [bar, {x: 90, y: 100, color: [0, 0, 0]}],
    [{...bar, x: 5}],
    [{...bar, width: 30}],
    [{...bar, color: [66, 107, 242, 128]}],
    [{...bar, color: [66, 120, 242]}],
    [bar, {x: 62, y: 95, color: [114, 150, 246]}],
  ];
  for (const [index, edits] of variants.entries()) {
    const changed = picture(dir, 'changed-' + index, edits);
    assert.equal(compare(white, changed).equivalent, false, String(index));
    assert.equal(compare(changed, white).equivalent, false, 'reverse ' + index);
  }
  assert.equal(compare(white, picture(dir, 'masked', [{x: 20, y: 350, color: [0, 0, 0]}, {x: 60, y: 275, color: [0, 0, 0]}])).mode, 'exact');
});

test('two components, missing rows, sparse pixels and short bars cannot pass as a caret', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white');
  const shapes = [
    [{...bar, width: 2}, {...bar, x: 64, width: 2}],
    [bar, {x: 60, y: 140, width: 6, color: policy.background}],
    [{...bar, width: 1}, {x: 65, y: 90, width: 1, height: 10}],
    [{...bar, height: 20}],
    [{...bar, width: 9, height: 25}],
  ];
  for (const [index, edits] of shapes.entries()) assert.equal(compare(white, picture(dir, 'shape-' + index, edits)).equivalent, false, String(index));
  assert.equal(compare(white, picture(dir, 'moved', [bar, {...bar, x: 80}])).equivalent, false);
});

test('policy is complete explicit local authority with strict numeric and color bounds', () => {
  assert.equal(validateCaretPolicy(policy), policy);
  const invalid = [null, {...policy, enabled: false}, {...policy, unexpected: true}, {...policy, color: [66, true, 242]}, {...policy, color: new Array(3)},
    {...policy, background: policy.color}, {...policy, color: [66, 107, 256]}, {...policy, colorTolerance: 3}, {...policy, colorTolerance: true},
    {...policy, maxWidthPoints: 3.1}, {...policy, maxHeightPoints: 48.1}, {...policy, minHeightPoints: 7.9}, {...policy, maxAreaPoints: 145},
    {...policy, maxWidthPoints: 0}, {...policy, maxHeightPoints: NaN}, {...policy, maxAreaPoints: Infinity}, {...policy, maxWidthPoints: true}];
  for (const value of invalid) assert.throws(() => validateCaretPolicy(value), {code: 'VISUAL_CARET_CONFIG_INVALID'});
  const missing = {...policy}; delete missing.background; assert.throws(() => validateCaretPolicy(missing), {code: 'VISUAL_CARET_CONFIG_INVALID'});
});

test('malformed geometry, masks, PNG and symlink paths fail without a visual equivalence receipt', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white'), other = picture(dir, 'other', [], 2);
  assert.throws(() => compare(white, other), {code: 'VISUAL_COORDINATES_UNVERIFIED'});
  for (const geometry of [[100, 100], [0, 200], [true, 200], [100, Infinity]]) assert.throws(() => compare(white, white, {geometry}), error => ['VISUAL_CARET_CONFIG_INVALID', 'VISUAL_COORDINATES_UNVERIFIED'].includes(error.code));
  for (const extra of [{masks: []}, {masks: [masks[0], masks[1], masks[0]]}, {masks: [masks[1], masks[1]]},
    {masks: [masks[1], {...masks[1], x: .1001, width: .7999}]}, {masks: [valueRegion, masks[1]]},
    {valueRegion: {...valueRegion, x: NaN}}, {extra: true}]) assert.throws(() => compare(white, white, extra), {code: 'VISUAL_CARET_CONFIG_INVALID'});
  const bytes = readFileSync(white), bad = path.join(dir, 'bad.png'); bytes[bytes.length - 1] ^= 1; writeFileSync(bad, bytes);
  assert.throws(() => compare(white, bad), {code: 'VISUAL_PIXELS_INVALID'});
  writeFileSync(bad, Buffer.concat([readFileSync(white), Buffer.from([0])])); assert.throws(() => compare(white, bad), {code: 'VISUAL_PIXELS_INVALID'});
  symlinkSync(white, path.join(dir, 'link.png')); assert.throws(() => compare(white, path.join(dir, 'link.png')), {code: 'VISUAL_PIXELS_INVALID'});
  mkdirSync(path.join(dir, 'actual')); symlinkSync(path.join(dir, 'actual'), path.join(dir, 'linked')); assert.throws(() => compare(path.join(dir, 'linked', 'image.png'), white), {code: 'VISUAL_PIXELS_INVALID'});
  assert.throws(() => compare('relative.png', white), {code: 'VISUAL_PIXELS_INVALID'});
});

test('a same-colored narrow glyph remains an explicitly documented owner-authority ambiguity', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white'), narrowGlyph = picture(dir, 'same-colored-I-stem', [bar]);
  // Pixel evidence cannot identify the handler or distinguish this stem from
  // a caret; the public gap and hidden full-text recheck are required.
  assert.equal(compare(white, narrowGlyph).mode, 'caret');
  const blackStem = picture(dir, 'black-I-stem', [{...bar, color: [0, 0, 0]}]);
  assert.equal(compare(white, blackStem).equivalent, false);
  assert.equal(compare(white, blackStem, {policy: {...policy, color: [0, 0, 0]}}).mode, 'caret');
});

test('PNG dimension, interlace and compressed-stream bounds apply before visual comparison', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white'), original = readFileSync(white);
  for (const [name, mutate] of [
    ['dimensions', bytes => bytes.writeUInt32BE(20000, 16)],
    ['interlace', bytes => {bytes[28] = 1;}],
  ]) {
    const bytes = Buffer.from(original); mutate(bytes); bytes.writeUInt32BE(CrcCalculator.crc32(bytes.subarray(12, 29)) >>> 0, 29);
    const file = path.join(dir, name + '.png'); writeFileSync(file, bytes); assert.throws(() => compare(white, file), {code: 'VISUAL_PIXELS_INVALID'});
  }
  const bytes = Buffer.from(original);
  let offset = 8;
  while (bytes.toString('ascii', offset + 4, offset + 8) !== 'IDAT') offset += bytes.readUInt32BE(offset) + 12;
  const length = bytes.readUInt32BE(offset); bytes[offset + 8 + length - 1] ^= 1;
  bytes.writeUInt32BE(CrcCalculator.crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0, offset + 8 + length);
  const file = path.join(dir, 'invalid-zlib.png'); writeFileSync(file, bytes); assert.throws(() => compare(white, file), {code: 'VISUAL_PIXELS_INVALID'});
});

test('one result mask permits the approved input caret while retaining the hidden keyboard area and all other UI', t => {
  const dir = realpathSync(temp(t)), white = picture(dir, 'white'), caret = picture(dir, 'caret', [bar]);
  const onlyResult = {masks: [masks[1]]};
  assert.equal(compare(white, caret, onlyResult).mode, 'caret');
  for (const [name, edits] of [
    ['old-keyboard', [{x: 30, y: 350, color: [0, 0, 0]}]],
    ['other-ui', [{x: 5, y: 80, color: [0, 0, 0]}]],
    ['input-black', [{...bar, color: [0, 0, 0]}]],
    ['caret-plus-keyboard', [bar, {x: 30, y: 350, color: [0, 0, 0]}]],
  ]) assert.equal(compare(white, picture(dir, name, edits), onlyResult).equivalent, false, name);
  assert.equal(compare(white, picture(dir, 'result-only', [{x: 60, y: 275, color: [0, 0, 0]}]), onlyResult).mode, 'exact');
});
