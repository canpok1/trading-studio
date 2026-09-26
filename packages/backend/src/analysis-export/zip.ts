// ZIP を作る。書き出しに使うだけなので、1回で全体をメモリ上に組み立てる（ライブラリを足すほどの機能は要らない）

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** ZIP に書く日時（MS-DOS 形式）。ZIP にタイムゾーンは無いので、展開する人が読みやすい JST で書く */
function dosTime(ms: number): { time: number; date: number } {
	const d = new Date(ms + 9 * 3_600_000);
	return {
		time:
			(d.getUTCHours() << 11) |
			(d.getUTCMinutes() << 5) |
			Math.floor(d.getUTCSeconds() / 2),
		date:
			((d.getUTCFullYear() - 1980) << 9) |
			((d.getUTCMonth() + 1) << 5) |
			d.getUTCDate(),
	};
}

export type ZipEntry = { name: string; data: Uint8Array };

/** ZIP64 は使わない。1ファイル・全体とも 4GB 未満の前提 */
export function createZip(
	entries: readonly ZipEntry[],
	now: number,
): Uint8Array {
	const encoder = new TextEncoder();
	const { time, date } = dosTime(now);
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = encoder.encode(e.name);
		const body = deflateRawSync(e.data);
		const crc = crc32(e.data);
		// 0x0800: ファイル名が UTF-8
		const flags = 0x0800;
		const local = new Uint8Array(30 + name.length + body.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, flags, true);
		lv.setUint16(8, 8, true); // deflate
		lv.setUint16(10, time, true);
		lv.setUint16(12, date, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, body.length, true);
		lv.setUint32(22, e.data.length, true);
		lv.setUint16(26, name.length, true);
		lv.setUint16(28, 0, true);
		local.set(name, 30);
		local.set(body, 30 + name.length);
		locals.push(local);

		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, flags, true);
		cv.setUint16(10, 8, true);
		cv.setUint16(12, time, true);
		cv.setUint16(14, date, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, body.length, true);
		cv.setUint32(24, e.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length;
	}
	const centralSize = centrals.reduce((s, c) => s + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);

	const out = new Uint8Array(offset + centralSize + end.length);
	let p = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, p);
		p += part.length;
	}
	return out;
}
