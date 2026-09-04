/**
 * Dependency-free QR encoder (byte mode, error correction level L,
 * versions 1-20) rendered to a canvas. Enough for invite payloads of a few
 * hundred bytes without pulling in a QR library.
 */

// [dataCodewords, ecCodewordsPerBlock, blockCount] for EC level L.
const VERSION_SPEC = [
  [19, 7, 1], [34, 10, 1], [55, 15, 1], [80, 20, 1], [108, 26, 1],
  [136, 18, 2], [156, 20, 2], [194, 24, 2], [232, 30, 2], [274, 18, 4],
  [324, 20, 4], [370, 24, 4], [428, 26, 4], [461, 30, 4], [523, 22, 6],
  [589, 24, 6], [647, 28, 6], [721, 30, 6], [795, 28, 7], [861, 28, 8],
];

const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildGaloisTables() {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

function multiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left] + LOG[right]];
}

function generatorPolynomial(degree) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] ^= poly[position];
      next[position + 1] ^= multiply(poly[position], EXP[index]);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(dataBytes, ecLength) {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Array(ecLength).fill(0);
  for (const byte of dataBytes) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ecLength; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function chooseVersion(byteLength) {
  for (let index = 0; index < VERSION_SPEC.length; index += 1) {
    const version = index + 1;
    const lengthBits = version < 10 ? 8 : 16;
    const neededBits = 4 + lengthBits + byteLength * 8;
    if (VERSION_SPEC[index][0] * 8 >= neededBits) return version;
  }
  throw new Error('payload too large for QR version 20');
}

function buildCodewords(bytes, version) {
  const [dataCapacity, ecPerBlock, blockCount] = VERSION_SPEC[version - 1];
  const bits = [];
  const pushBits = (value, count) => {
    for (let index = count - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };

  pushBits(0b0100, 4);
  pushBits(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);

  const capacityBits = dataCapacity * 8;
  pushBits(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    data.push(parseInt(bits.slice(index, index + 8).join(''), 2));
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (data.length < dataCapacity) {
    data.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  // Interleave data and EC blocks.
  const shortLength = Math.floor(dataCapacity / blockCount);
  const longBlocks = dataCapacity % blockCount;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const length = shortLength + (block >= blockCount - longBlocks ? 1 : 0);
    const slice = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(slice);
    ecBlocks.push(errorCorrection(slice, ecPerBlock));
  }

  const result = [];
  const maxDataLength = Math.max(...dataBlocks.map((block) => block.length));
  for (let index = 0; index < maxDataLength; index += 1) {
    for (const block of dataBlocks) if (index < block.length) result.push(block[index]);
  }
  for (let index = 0; index < ecPerBlock; index += 1) {
    for (const block of ecBlocks) result.push(block[index]);
  }
  return result;
}

function bchFormatBits(format) {
  let value = format << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >> index) & 1) value ^= 0b10100110111 << (index - 10);
  }
  return ((format << 10) | value) ^ 0b101010000010010;
}

function bchVersionBits(version) {
  let value = version << 12;
  for (let index = 17; index >= 12; index -= 1) {
    if ((value >> index) & 1) value ^= 0b1111100100101 << (index - 12);
  }
  return (version << 12) | value;
}

function maskCondition(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return ((((row * column) % 2) + ((row * column) % 3)) % 2) === 0;
    default: return ((((row + column) % 2) + ((row * column) % 3)) % 2) === 0;
  }
}

function createMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const place = (row, column, value) => {
    modules[row][column] = value;
    reserved[row][column] = true;
  };

  const drawFinder = (topRow, leftColumn) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const y = topRow + row;
        const x = leftColumn + column;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inRing = row >= 0 && row <= 6 && column >= 0 && column <= 6 &&
          (row === 0 || row === 6 || column === 0 || column === 6);
        const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        place(y, x, inRing || inCore ? 1 : 0);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const value = index % 2 === 0 ? 1 : 0;
    place(6, index, value);
    place(index, 6, value);
  }

  // Alignment patterns are drawn everywhere except the three centres that
  // would collide with the finder patterns. Overlap with the timing row is
  // expected and produces identical module values.
  const centres = ALIGNMENT[version];
  const last = size - 7;
  for (const centerRow of centres) {
    for (const centerColumn of centres) {
      const atFinder =
        (centerRow === 6 && centerColumn === 6) ||
        (centerRow === 6 && centerColumn === last) ||
        (centerRow === last && centerColumn === 6);
      if (atFinder) continue;
      for (let row = -2; row <= 2; row += 1) {
        for (let column = -2; column <= 2; column += 1) {
          const isDark = Math.max(Math.abs(row), Math.abs(column)) !== 1;
          place(centerRow + row, centerColumn + column, isDark ? 1 : 0);
        }
      }
    }
  }

  place(size - 8, 8, 1); // dark module

  // Format info: bit 0 is the MSB of the 15-bit string. Two copies, placed at
  // the coordinates given in the QR specification.
  const formatBits = bchFormatBits((0b01 << 3) | mask);
  const firstCopy = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let index = 0; index < 15; index += 1) {
    const bit = (formatBits >> (14 - index)) & 1;
    const [row, column] = firstCopy[index];
    place(row, column, bit);
    // Second copy: first 7 bits run up column 8, the rest along row 8.
    if (index < 7) place(size - 1 - index, 8, bit);
    else place(8, size - 15 + index, bit);
  }

  if (version >= 7) {
    const versionBits = bchVersionBits(version);
    for (let index = 0; index < 18; index += 1) {
      const bit = (versionBits >> index) & 1;
      const row = Math.floor(index / 3);
      const column = size - 11 + (index % 3);
      place(row, column, bit);
      place(column, row, bit);
    }
  }

  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    // Column 6 holds the vertical timing pattern and is skipped entirely.
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (reserved[row][column]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex += 1;
        }
        modules[row][column] = maskCondition(mask, row, column) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }

  return modules.map((row) => row.map((cell) => cell ?? 0));
}

function penalty(matrix) {
  const size = matrix.length;
  let score = 0;
  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let index = 0; index < size; index += 1) {
    score += runScore(matrix[index]);
    score += runScore(matrix.map((row) => row[index]));
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const sum = matrix[row][column] + matrix[row][column + 1] +
        matrix[row + 1][column] + matrix[row + 1][column + 1];
      if (sum === 0 || sum === 4) score += 3;
    }
  }
  const dark = matrix.flat().reduce((total, cell) => total + cell, 0);
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

export function encodeQr(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = createMatrix(version, codewords, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { matrix, score };
  }
  return best.matrix;
}

export function renderQrToCanvas(canvas, text, { scale = 6, quiet = 4 } = {}) {
  const matrix = encodeQr(text);
  const size = matrix.length;
  const pixels = (size + quiet * 2) * scale;
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = '#000000';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix[row][column]) continue;
      context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
  return matrix;
}
