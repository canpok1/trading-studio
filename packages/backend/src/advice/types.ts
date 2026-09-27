// バックテストの AI アドバイスの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

/** アドバイスの本文。見出しは固定 */
export type AdviceContent = {
	/** 結果の分析 */
	analysis: string;
	/** うまくいった点 */
	good: string;
	/** 悪かった点 */
	bad: string;
	/** 改善案（具体的なパラメータの値） */
	improvements: string;
};

export type BacktestAdvice = {
	runId: number;
	status: "running" | "done" | "failed";
	/** 作り直しの生成中と失敗では、前に作った本文とその生成条件（モデル・指示の版・バージョン・作り終えた時刻）を残す。初めての生成中と失敗は null */
	content: AdviceContent | null;
	model: string;
	instructionsVersion: number;
	/** 生成したアプリのバージョン（ビルド日時）。開発版は null */
	appBuiltAt: number | null;
	/** 最後に生成を始めた時刻 */
	startedAt: number;
	/** 本文を作り終えた時刻。本文が無ければ null */
	finishedAt: number | null;
	error: string | null;
};

export type InstructionsVersion = {
	version: number;
	text: string;
	note: string;
	createdAt: number;
};

export type AdviceModelOption = { id: string; label: string };

export type StartAdviceResult =
	| { ok: true; advice: BacktestAdvice }
	| { ok: false; status: 404 | 409 | 503; message: string };

export interface AdviceService {
	/** 実行のアドバイス。まだ無ければ null */
	get(runId: number): BacktestAdvice | null;
	/** 生成を始める。前のアドバイスは生成が終わると置き換わる */
	start(runId: number): StartAdviceResult;
	instructions(): {
		versions: InstructionsVersion[];
		activeVersion: number | null;
		template: string;
	};
	addInstructions(
		text: string,
		note: string,
	):
		| { ok: true; version: InstructionsVersion }
		| { ok: false; message: string };
	setActiveInstructions(version: number): boolean;
	models(): { models: AdviceModelOption[]; current: string };
	setModel(id: string): boolean;
}
