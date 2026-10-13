import type { CompatibleConnection } from "./model-domain";

export interface CompatibleRepository {
	connection(): CompatibleConnection | null;
	keySavedAt(): number | null;
	/** apiKey が undefined なら保存済みのキーを残す。ただし URL が変わったら消す（前の接続先のキーを別の宛先へ送らないため） */
	save(baseUrl: string, apiKey: string | undefined, now: number): void;
	clear(): void;
}
