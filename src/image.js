// 图片处理：元数据剥离与指纹。
// 人脸/车牌的像素遮蔽在上传前由浏览器画布完成，服务器只接收已遮蔽的图像；
// 服务器再强制剥离 EXIF/文本等元数据，避免坐标、设备信息随文件外泄。

import { createHash } from "node:crypto";

export function sha256Hex(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

// JPEG：仅保留 APP0(JFIF) 与图像数据段，丢弃 APP1-APP15(EXIF/XMP) 与注释段。
function stripJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("不是有效的 JPEG 文件");
  }
  const out = [buffer.subarray(0, 2)];
  const removed = [];
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break; // 进入压缩数据
    const marker = buffer[offset + 1];
    if (marker === 0xda) {
      // SOS：其后为图像数据，原样保留到文件尾
      out.push(buffer.subarray(offset));
      offset = buffer.length;
      break;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const segment = buffer.subarray(offset, offset + 2 + length);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe0) {
      out.push(segment); // APP0 JFIF 头，不含隐私信息
    } else if (isApp || marker === 0xfe) {
      removed.push(`APP${marker - 0xe0}`);
    } else {
      out.push(segment); // DQT/DHT/SOF 等解码必需段
    }
    offset += 2 + length;
  }
  return { buffer: Buffer.concat(out), removed };
}

// PNG：仅保留关键块(IHDR/PLTE/IDAT/IEND)，丢弃 tEXt/zTXt/iTXt/eXIf 等附属块。
function stripPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("不是有效的 PNG 文件");
  }
  const out = [signature];
  const removed = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset, offset + 12 + length);
    const critical = type[0] === type[0].toUpperCase();
    if (critical) {
      out.push(chunk);
    } else {
      removed.push(type);
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return { buffer: Buffer.concat(out), removed };
}

export function stripMetadata(buffer, mime) {
  if (mime === "image/jpeg") return stripJpeg(buffer);
  if (mime === "image/png") return stripPng(buffer);
  throw new Error(`不支持的图片类型: ${mime}`);
}

// 客户端计算的 64 位感知哈希（dHash），服务器只做海明距离比较，
// 用于提出“照片相似”的合并候选，绝不据此自动删除任何线索。
export function hammingDistance(hexA, hexB) {
  if (!/^[0-9a-f]{16}$/i.test(hexA) || !/^[0-9a-f]{16}$/i.test(hexB)) return null;
  let x = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
