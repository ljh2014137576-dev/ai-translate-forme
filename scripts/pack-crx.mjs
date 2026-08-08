// 打包 Chrome 扩展为 CRX3 (无外部依赖)
// 用法: node scripts/pack-crx.mjs [扩展目录] [输出.crx]
// 首次运行会生成 <目录>.pem 私钥(勿提交到 git)；之后版本用同一密钥保持扩展 ID 稳定
import { createHash, createSign, generateKeyPairSync, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";

const extDir = resolve(process.argv[2] || ".");
const outCrx = resolve(process.argv[3] || basename(extDir) + ".crx");
const pemPath = extDir + ".pem";

// ---------- 1. 收集需要打包的文件(排除开发/版本控制文件) ----------
const EXCLUDE = new Set([".git", ".codebase-memory", "test", "node_modules", "scripts", ".gitignore", "LOG.md", "README.md"]);
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collect(p));
    else out.push(p);
  }
  return out;
}
const files = collect(extDir).sort();
if (!files.length) { console.error("no files to pack in " + extDir); process.exit(1); }

// ---------- 2. ZIP(stored 方式) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    chunks.push(local);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBuf.length), u32(offset), u16(0)]);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
const zip = makeZip(files.map((f) => ({ name: relative(extDir, f).replace(/\\/g, "/"), data: readFileSync(f) })));

// ---------- 3. 密钥(不存在则生成 RSA-2048，保存 PEM) ----------
let privateKeyPem, publicKeyDer;
if (existsSync(pemPath)) {
  privateKeyPem = readFileSync(pemPath, "utf8");
  publicKeyDer = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
} else {
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  privateKeyPem = kp.privateKey;
  publicKeyDer = kp.publicKey;
  writeFileSync(pemPath, privateKeyPem, "utf8");
  console.log("generated new private key: " + pemPath);
}

// ---------- 4. protobuf 编码 ----------
function varint(n) {
  const out = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
const field = (tag, bytes) => Buffer.concat([varint((tag << 3) | 2), varint(bytes.length), bytes]);
const signedDataProto = (crxId) => field(1, crxId);
const proofProto = (pubKey, sig) => Buffer.concat([field(1, pubKey), field(2, sig)]);
const headerProto = (pubKey, sig, signedData) => Buffer.concat([field(2, proofProto(pubKey, sig)), field(10000, signedData)]);

// ---------- 5. 扩展 ID = SHA256(SPKI公钥) 前16字节 映射到 a-p ----------
function extIdFromKey(pubDer) {
  const h = createHash("sha256").update(pubDer).digest();
  const alpha = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i++) { id += alpha[h[i] >> 4]; id += alpha[h[i] & 0xf]; }
  return id;
}
const crxId = Buffer.from(extIdFromKey(publicKeyDer), "utf8");
const signedData = signedDataProto(crxId);
const signer = createSign("RSA-SHA256");
signer.update(Buffer.concat([Buffer.from("CRX3 SignedData\x00", "utf8"), signedData, zip]));
const signature = signer.sign(createPrivateKey(privateKeyPem));
const header = headerProto(publicKeyDer, signature, signedData);

// ---------- 6. 写出 CRX3 ----------
const crx = Buffer.concat([Buffer.from("Cr24", "utf8"), u32(3), u32(header.length), header, zip]);
writeFileSync(outCrx, crx);
console.log("packed: " + outCrx + " (" + crx.length + " bytes, " + files.length + " files)");
console.log("extension id: " + extIdFromKey(publicKeyDer));

// ---------- 7. 自校验(解析 + 重验签名) ----------
function readField(b, tag) {
  let i = 0;
  while (i < b.length) {
    let t = 0, shift = 0;
    while (i < b.length) { const c = b[i++]; t |= (c & 0x7f) << shift; shift += 7; if (!(c & 0x80)) break; }
    const fnum = Math.floor(t / 8);
    if ((t & 7) !== 2) throw new Error("unexpected wire type " + (t & 7));
    let len = 0, lshift = 0;
    while (i < b.length) { const c = b[i++]; len |= (c & 0x7f) << lshift; lshift += 7; if (!(c & 0x80)) break; }
    const payload = b.subarray(i, i + len);
    i += len;
    if (fnum === tag) return payload;
  }
  throw new Error("field " + tag + " not found");
}
function verifyCrx(buf) {
  if (buf.toString("utf8", 0, 4) !== "Cr24") throw new Error("bad magic");
  if (buf.readUInt32LE(4) !== 3) throw new Error("not crx3");
  const hlen = buf.readUInt32LE(8);
  const hbuf = buf.subarray(12, 12 + hlen);
  const zipBuf = buf.subarray(12 + hlen);
  if (zipBuf.subarray(0, 4).toString("hex") !== "504b0304") throw new Error("zip magic missing");
  const proof = readField(hbuf, 2);
  const pubKey = readField(proof, 1);
  const sig = readField(proof, 2);
  const sdata = readField(hbuf, 10000);
  const ok = verify("RSA-SHA256", Buffer.concat([Buffer.from("CRX3 SignedData\x00", "utf8"), sdata, zipBuf]), { key: pubKey, format: "der", type: "spki" }, sig);
  return { ok, id: extIdFromKey(pubKey) };
}
const check = verifyCrx(crx);
console.log("self-verify: " + (check.ok ? "OK" : "FAILED") + " (id " + check.id + ")");
if (!check.ok) process.exit(1);