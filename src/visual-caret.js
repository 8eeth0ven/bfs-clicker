// Explicit owner-approved visual equivalence for a narrow blinking caret.
// Matching color/shape is not proof that a changed pixel belongs to an OS caret.
import {constants, openSync, closeSync, fstatSync, readSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {PNG} from 'pngjs';

const fail = code => { throw Object.assign(new Error('Invalid bounded caret comparison'), {code}); };
const invalid = () => fail('VISUAL_CARET_CONFIG_INVALID');
const badImage = () => fail('VISUAL_PIXELS_INVALID');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value);

export function validateCaretPolicy(policy) {
  const keys = ['enabled', 'color', 'background', 'colorTolerance', 'maxWidthPoints', 'minHeightPoints', 'maxHeightPoints', 'maxAreaPoints'];
  if (!object(policy) || Object.keys(policy).length !== keys.length || keys.some(key => !Object.hasOwn(policy, key)) || policy.enabled !== true) invalid();
  for (const key of ['color', 'background']) {
    if (!Array.isArray(policy[key]) || policy[key].length !== 3 || Array.from(policy[key]).some(value => !Number.isInteger(value) || value < 0 || value > 255)) invalid();
  }
  if (Math.max(...policy.color.map((value, index) => Math.abs(value - policy.background[index]))) < 64) invalid();
  if (!Number.isInteger(policy.colorTolerance) || policy.colorTolerance < 0 || policy.colorTolerance > 2) invalid();
  for (const key of ['maxWidthPoints', 'minHeightPoints', 'maxHeightPoints', 'maxAreaPoints']) if (!number(policy[key])) invalid();
  if (policy.maxWidthPoints <= 0 || policy.maxWidthPoints > 3 || policy.minHeightPoints < 8 || policy.minHeightPoints > policy.maxHeightPoints || policy.maxHeightPoints > 48 || policy.maxAreaPoints <= 0 || policy.maxAreaPoints > 144) invalid();
  return policy;
}

function box(region, width, height) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!object(region) || Object.keys(region).length !== 4 || keys.some(key => !number(region[key])) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) invalid();
  const result = {x0: Math.floor(region.x * width), y0: Math.floor(region.y * height), x1: Math.ceil((region.x + region.width) * width), y1: Math.ceil((region.y + region.height) * height)};
  if (result.x1 <= result.x0 || result.y1 <= result.y0) invalid();
  return result;
}
const contains = (b, x, y) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;

function fileBytes(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) badImage();
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root, fd;
  try {
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) badImage();
    }
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 45 || info.size > 16 * 1024 * 1024) badImage();
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size !== info.size) badImage();
    return bytes.subarray(0, size);
  } catch { badImage(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

// Keep the existing fingerprint reader's PNG/CRC/inflate limits. The comparator
// owns each bounded byte snapshot; it never validates one path then reopens it.
function image(file) {
  const data = fileBytes(file);
  if (!data.subarray(0, 8).equals(signature)) badImage();
  let offset = 8, width, height, depth, colorType, header = false, end = false, seenData = false, afterData = false;
  const compressed = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) badImage();
    const length = data.readUInt32BE(offset), next = offset + 12 + length;
    if (next > data.length) badImage();
    const kind = data.subarray(offset + 4, offset + 8), type = kind.toString('ascii');
    if (!kind.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (kind[2] & 32) !== 0 || crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) badImage();
    if (!header) {
      if (type !== 'IHDR' || length !== 13) badImage();
      width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
      depth = data[offset + 16]; colorType = data[offset + 17];
      if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16000000 || data[offset + 20] !== 0) badImage();
      header = true;
    } else if (type === 'IHDR') badImage();
    if (type === 'IDAT') {
      if (afterData) badImage();
      seenData = true; compressed.push(data.subarray(offset + 8, offset + 8 + length));
    } else if (seenData && type !== 'IEND') afterData = true;
    if (type === 'IEND') {
      if (length !== 0 || !seenData || next !== data.length) badImage();
      end = true; break;
    }
    offset = next;
  }
  if (!header || !end) badImage();
  const channels = ({0: 1, 2: 3, 3: 1, 4: 2, 6: 4})[colorType], depths = ({0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]})[colorType];
  if (!channels || !depths.includes(depth)) badImage();
  const limit = (Math.ceil(width * channels * depth / 8) + 1) * height;
  let decoded;
  try {
    const bytes = Buffer.concat(compressed), result = inflateSync(bytes, {maxOutputLength: limit + 1, info: true});
    if (result.buffer.length !== limit || result.engine.bytesWritten !== bytes.length) badImage();
    decoded = PNG.sync.read(data, {checkCRC: true});
  } catch { badImage(); }
  if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) badImage();
  return decoded;
}

function approvedColor(data, offset, policy) {
  if (data[offset + 3] !== 255) return false;
  const delta = policy.color.map((value, index) => value - policy.background[index]);
  const denominator = delta.reduce((sum, value) => sum + value * value, 0);
  const alpha = Math.max(0, Math.min(1, delta.reduce((sum, value, index) => sum + (data[offset + index] - policy.background[index]) * value, 0) / denominator));
  return delta.every((value, index) => Math.abs(data[offset + index] - (policy.background[index] + alpha * value)) <= policy.colorTolerance);
}

export function visualCaretEquivalent(beforePath, afterPath, options) {
  const keys = ['masks', 'valueRegion', 'geometry', 'policy'];
  if (!object(options) || Object.keys(options).length !== keys.length || keys.some(key => !Object.hasOwn(options, key))) invalid();
  const policy = validateCaretPolicy(options.policy), geometry = options.geometry;
  if (!Array.isArray(geometry) || geometry.length !== 2 || geometry.some(value => !number(value) || value < 1 || value > 16384) || !Array.isArray(options.masks) || ![1, 2].includes(options.masks.length)) invalid();
  const before = image(beforePath), after = image(afterPath), {width, height} = before;
  if (after.width !== width || after.height !== height) fail('VISUAL_COORDINATES_UNVERIFIED');
  const scaleX = width / geometry[0], scaleY = height / geometry[1];
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0 || Math.abs(scaleX - scaleY) > .03) fail('VISUAL_COORDINATES_UNVERIFIED');
  const masks = Array.from(options.masks, region => box(region, width, height)), value = box(options.valueRegion, width, height);
  if (masks.length === 2 && ['x0', 'y0', 'x1', 'y1'].every(key => masks[0][key] === masks[1][key])) invalid();
  if (masks.some(mask => mask.x0 < value.x1 && mask.x1 > value.x0 && mask.y0 < value.y1 && mask.y1 > value.y0)) invalid();
  const result = (equivalent, mode, changedPixels) => ({width, height, equivalent, mode, changedPixels});
  const rows = new Map();
  let count = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (masks.some(mask => contains(mask, x, y))) continue;
    const offset = (y * width + x) * 4;
    if (before.data[offset] === after.data[offset] && before.data[offset + 1] === after.data[offset + 1] && before.data[offset + 2] === after.data[offset + 2] && before.data[offset + 3] === after.data[offset + 3]) continue;
    count++;
    if (!contains(value, x, y) || !approvedColor(before.data, offset, policy) || !approvedColor(after.data, offset, policy)) return result(false, 'changed', count);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
    if ((x1 - x0) / scaleX > policy.maxWidthPoints || (y1 - y0) / scaleY > policy.maxHeightPoints || (x1 - x0) * (y1 - y0) / scaleX / scaleY > policy.maxAreaPoints) return result(false, 'changed', count);
    const row = rows.get(y) || {min: x, max: x, count: 0};
    row.min = Math.min(row.min, x); row.max = Math.max(row.max, x); row.count++; rows.set(y, row);
  }
  if (!count) return result(true, 'exact', 0);
  const logicalWidth = (x1 - x0) / scaleX, logicalHeight = (y1 - y0) / scaleY;
  if (logicalHeight < policy.minHeightPoints || logicalHeight < 4 * logicalWidth || count / ((x1 - x0) * (y1 - y0)) < .8) return result(false, 'changed', count);
  let previous;
  for (let y = y0; y < y1; y++) {
    const row = rows.get(y);
    // Every changed row is continuous; overlapping adjacent intervals imply
    // exactly one 4-connected component, with no missing row or second bar.
    if (!row || row.count !== row.max - row.min + 1 || (previous && (row.max < previous.min || row.min > previous.max))) return result(false, 'changed', count);
    previous = row;
  }
  return result(true, 'caret', count);
}
