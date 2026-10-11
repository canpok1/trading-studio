/** OpenAI 互換の接続先の状態。キーそのものは返さない */
export type CompatibleConnectionStatus = {
	baseUrl: string | null;
	keyConfigured: boolean;
	keySavedAt: number | null;
};

export type CompatibleModelOption = { id: string; label: string };

export type CompatibleModelsResult =
	| { ok: true; models: CompatibleModelOption[] }
	| { ok: false; message: string };

export type CompatibleService = {
	status(): CompatibleConnectionStatus;
	/** apiKey が undefined なら保存済みのキーを残す。URL を変えたときは消す */
	save(input: {
		baseUrl: string;
		apiKey?: string;
	}): { ok: true } | { ok: false; message: string };
	/** 接続先の URL とキーを消す */
	clear(): void;
	/** 接続先が返すモデルの一覧。id は採点・アドバイスでそのまま選べる形 */
	models(): Promise<CompatibleModelsResult>;
};
