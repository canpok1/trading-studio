// バックテストの AI アドバイスの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { ConditionSet } from "@trading-studio/core";

/** 改善案を反映した戦略設定。検証に通らないか変更が無ければ、その理由 */
export type ImprovedStrategy =
	| { ok: true; params: ConditionSet }
	| { ok: false; reason: string };

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
	/** 改善案を反映した戦略設定。これを出す前に作ったアドバイスには無い */
	improved?: ImprovedStrategy;
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

export type ExternalPromptResult =
	| {
			ok: true;
			/** コピーして貼る指示 */
			prompt: string;
			/** 添付する資料 */
			file: { name: string; content: string };
			instructionsVersion: number;
	  }
	| { ok: false; status: 404 | 409; message: string };

export type ImportAdviceInput = {
	/** チャット型 AI の答え（貼ったまま） */
	text: string;
	/** 使った AI の名前。空なら「外部の AI」 */
	model: string;
	/** 渡す文をコピーしたときの指示の版 */
	instructionsVersion: number;
};

export type ImportAdviceResult =
	| { ok: true; advice: BacktestAdvice }
	| { ok: false; status: 400 | 404 | 409; message: string };

export interface AdviceService {
	/** 実行のアドバイス。まだ無ければ null */
	get(runId: number): BacktestAdvice | null;
	/** 生成を始める。前のアドバイスは生成が終わると置き換わる */
	start(runId: number): StartAdviceResult;
	/** チャット型の AI へ渡す指示と、添付する資料 */
	externalPrompt(runId: number): ExternalPromptResult;
	/** チャット型の AI の答えを、その実行のアドバイスとして取り込む */
	importExternal(runId: number, input: ImportAdviceInput): ImportAdviceResult;
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
