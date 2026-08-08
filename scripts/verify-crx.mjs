import { createHash, verify } from "node:crypto";
import fs from "node:fs";

// 严格按 Chromium crx_verifier.cc 算法验证任意 CRX3
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
function extIdFromKey(pubDer) {
  const h = createHash("sha256").update(pubDer).digest();
  const alpha = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i++) { id += alpha[h[i] >> 4]; id += alpha[h[i] & 0xf]; }
  return id;
}
export function verifyCrxFile(p) {
  const buf = fs.readFileSync(p);
  if (buf.toString("utf8", 0, 4) !== "Cr24") return { ok: false, err: "bad magic" };
  if (buf.readUInt32LE(4) !== 3) return { ok: false, err: "not crx3" };
  const hlen = buf.readUInt32LE(8);
  const hbuf = buf.subarray(12, 12 + hlen);
  const zipBuf = buf.subarray(12 + hlen);
  if (zipBuf.subarray(0, 4).toString("hex") !== "504b0304") return { ok: false, err: "zip magic missing" };
  try {
    const proof = readField(hbuf, 2);
    const pubKey = readField(proof, 1);
    const sig = readField(proof, 2);
    const sdata = readField(hbuf, 10000);
    const sdId = readField(sdata, 1);
    const idOk = sdId.length === 16 && sdId.equals(createHash("sha256").update(pubKey).digest().subarray(0, 16));
    const data = Buffer.concat([Buffer.from("CRX3 SignedData\x00", "utf8"), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(sdata.length, 0); return b; })(), sdata, zipBuf]);
    const sigOk = verify("RSA-SHA256", data, { key: pubKey, format: "der", type: "spki" }, sig);
    return { ok: idOk && sigOk, id: extIdFromKey(pubKey), idOk, sigOk, rsaSize: pubKey.length };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}