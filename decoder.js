/**
 * Protobuf wire format decoder (schema-less)
 * Parses raw protobuf binary into a human-readable structure.
 *
 * Wire types:
 * 0 = Varint (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
 * 1 = 64-bit (fixed64, sfixed64, double)
 * 2 = Length-delimited (string, bytes, embedded messages, packed repeated fields)
 * 5 = 32-bit (fixed32, sfixed32, float)
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

/**
 * Read a varint from a byte array at the given offset.
 * Returns { value, nextOffset }
 */
function readVarint(bytes, offset) {
  let result = 0;
  let shift = 0;
  let byte;

  do {
    if (offset >= bytes.length) {
      return { value: 0, nextOffset: offset, error: 'varint overflow' };
    }
    byte = bytes[offset];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    offset++;
  } while (byte & 0x80 && shift < 64);

  // Convert to BigInt-safe if large
  if (shift >= 32) {
    // Re-read as BigInt for large values
    let bigResult = 0n;
    let bigShift = 0n;
    let startOffset = offset - Math.ceil(shift / 7);
    let o = startOffset;
    let b;
    do {
      b = bytes[o];
      bigResult |= BigInt(b & 0x7f) << bigShift;
      bigShift += 7n;
      o++;
    } while (b & 0x80);
    return { value: bigResult.toString(), nextOffset: offset, isBigInt: true };
  }

  return { value: result >>> 0, nextOffset: offset };
}

/**
 * Read a 32-bit fixed value
 */
function read32bit(bytes, offset) {
  if (offset + 4 > bytes.length) return { value: 0, nextOffset: bytes.length };
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return { value: view.getUint32(0, true), nextOffset: offset + 4 };
}

/**
 * Read a 64-bit fixed value
 */
function read64bit(bytes, offset) {
  if (offset + 8 > bytes.length) return { value: 0n, nextOffset: bytes.length };
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return { value: (BigInt(hi) << 32n) | BigInt(lo), nextOffset: offset + 8 };
}

/**
 * ZigZag decode for signed varints
 */
function zigzagDecode(n) {
  if (typeof n === 'bigint') {
    return ((n >> 1n) ^ -(n & 1n)).toString();
  }
  return (n >>> 1) ^ -(n & 1);
}

/**
 * Try to interpret a length-delimited field as a UTF-8 string
 * Returns the string if valid, null otherwise
 */
function tryDecodeString(bytes) {
  try {
    const str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Heuristic: if it has too many control characters, probably not a string
    let controlCount = 0;
    for (let i = 0; i < str.length && i < 200; i++) {
      const c = str.charCodeAt(i);
      if (c < 9 || (c > 13 && c < 32)) controlCount++;
    }
    if (controlCount > str.length * 0.1) return null;
    return str;
  } catch {
    return null;
  }
}

/**
 * Check if bytes look like a nested protobuf message
 * (has valid field tags and wire types)
 */
function tryDecodeMessage(bytes, depth) {
  if (depth > 8) return null;
  if (bytes.length === 0) return null;
  if (bytes.length > 5) {
    const fields = decodeProto(bytes, depth + 1);
    if (fields && fields.length > 0) {
      return fields;
    }
  }
  return null;
}

/**
 * Attempt to decode a length-delimited field
 * Tries: nested message → string → bytes (hex)
 */
function decodeLengthDelimited(bytes, depth) {
  // Try nested message first
  const nested = tryDecodeMessage(bytes, depth);
  if (nested) {
    return { type: 'message', value: nested };
  }

  // Try string
  const str = tryDecodeString(bytes);
  if (str !== null) {
    return { type: 'string', value: str };
  }

  // Fall back to bytes (hex)
  const hex = Array.from(bytes.slice(0, 256))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    type: 'bytes',
    value: hex + (bytes.length > 256 ? `... (${bytes.length} bytes total)` : ''),
    rawLength: bytes.length,
  };
}

/**
 * Main decode function: parse raw protobuf bytes into field array
 */
function decodeProto(bytes, depth = 0) {
  if (depth > 10) return [];

  if (!(bytes instanceof Uint8Array)) {
    if (bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes);
    } else if (bytes instanceof DataView) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
      return [];
    }
  }

  const fields = [];
  let offset = 0;

  while (offset < bytes.length) {
    // Read field tag (varint)
    const tagResult = readVarint(bytes, offset);
    if (tagResult.error) break;
    offset = tagResult.nextOffset;

    const tag = tagResult.value;
    const fieldNumber = typeof tag === 'string'
      ? BigInt(tag) >> 3n
      : tag >> 3;
    const wireType = typeof tag === 'string'
      ? Number(BigInt(tag) & 0x7n)
      : tag & 0x7;

    if (fieldNumber === 0) break;

    let value;
    let inferredType = 'unknown';

    switch (wireType) {
      case WIRE_VARINT: {
        const vr = readVarint(bytes, offset);
        offset = vr.nextOffset;
        value = vr.value;
        inferredType = vr.isBigInt ? 'int64' : 'varint';
        break;
      }

      case WIRE_64BIT: {
        const r64 = read64bit(bytes, offset);
        offset = r64.nextOffset;
        value = r64.value.toString();
        inferredType = 'fixed64';
        break;
      }

      case WIRE_LENGTH: {
        const lenResult = readVarint(bytes, offset);
        offset = lenResult.nextOffset;
        const length = typeof lenResult.value === 'string'
          ? Number(BigInt(lenResult.value))
          : lenResult.value;

        if (offset + length > bytes.length) {
          // Truncated
          const available = bytes.length - offset;
          const subBytes = bytes.slice(offset, offset + available);
          const decoded = decodeLengthDelimited(subBytes, depth);
          fields.push({
            fieldNumber: Number(fieldNumber),
            wireType,
            type: decoded.type,
            value: decoded.value,
            truncated: true,
          });
          offset = bytes.length;
          break;
        }

        const subBytes = bytes.slice(offset, offset + length);
        offset += length;

        const decoded = decodeLengthDelimited(subBytes, depth);
        fields.push({
          fieldNumber: Number(fieldNumber),
          wireType,
          type: decoded.type,
          value: decoded.value,
        });
        continue;
      }

      case WIRE_32BIT: {
        const r32 = read32bit(bytes, offset);
        offset = r32.nextOffset;
        value = r32.value;
        inferredType = 'fixed32';
        break;
      }

      default:
        // Unknown wire type, stop parsing
        return fields;
    }

    fields.push({
      fieldNumber: Number(fieldNumber),
      wireType,
      type: inferredType,
      value: value,
    });
  }

  return fields;
}

/**
 * Convert decoded fields to a pretty JSON-like structure
 * Optional fieldMapping: { fieldNumber: fieldName }
 */
function fieldsToJson(fields, fieldMapping) {
  const result = {};
  for (const field of fields) {
    const fieldNum = field.fieldNumber;
    const key = fieldMapping && fieldMapping[fieldNum] ? fieldMapping[fieldNum] : ('field' + fieldNum);
    if (field.type === 'message') {
      const nested = fieldsToJson(field.value, fieldMapping);
      // Merge repeated fields
      if (key in result) {
        if (Array.isArray(result[key])) {
          result[key].push(nested);
        } else {
          result[key] = [result[key], nested];
        }
      } else {
        result[key] = nested;
      }
    } else {
      if (key in result) {
        if (Array.isArray(result[key])) {
          result[key].push(field.value);
        } else {
          result[key] = [result[key], field.value];
        }
      } else {
        result[key] = field.value;
      }
    }
  }
  return result;
}

/**
 * Decode a base64-encoded protobuf frame to JSON
 * Optional fieldMapping: { fieldNumber: fieldName }
 */
function decodeBase64Proto(base64Str, fieldMapping) {
  try {
    const binary = atob(base64Str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const fields = decodeProto(bytes, 0);
    return fieldsToJson(fields, fieldMapping);
  } catch (e) {
    return { _error: 'Failed to decode: ' + e.message };
  }
}

/**
 * Generate a human-readable summary of decoded protobuf
 */
function summarizeDecoded(obj, maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) return '...';
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return obj.length > 80 ? obj.substring(0, 80) + '...' : obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  if (Array.isArray(obj)) {
    return obj.map(item => summarizeDecoded(item, maxDepth, currentDepth + 1)).join(', ');
  }

  if (typeof obj === 'object') {
    const parts = [];
    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith('_')) continue;
      const summary = summarizeDecoded(val, maxDepth, currentDepth + 1);
      parts.push(`${key}=${summary}`);
    }
    return parts.join(', ');
  }

  return String(obj);
}

// Export for use in panel
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decodeProto, decodeBase64Proto, fieldsToJson, summarizeDecoded };
}
