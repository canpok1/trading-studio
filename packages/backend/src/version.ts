// アプリのバージョン。Docker イメージのビルド日時（エポックミリ秒）を使う。開発中はファイルが無いので null

import { readFileSync } from "node:fs";

/** Dockerfile がビルド時に書き出すファイル。リポジトリ直下（イメージでは /app）に置く */
export const BUILT_AT_FILE = new URL("../../../BUILT_AT", import.meta.url);

/** ビルド日時を読む。ファイルが無いか読めない値なら null（開発版） */
export function readAppBuiltAt(
	path: URL | string = BUILT_AT_FILE,
): number | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
	return /^\d+$/.test(text) ? Number(text) : null;
}
