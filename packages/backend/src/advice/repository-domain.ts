import type {
	AdviceContent,
	AdviceGeneration,
	BacktestAdvice,
	InstructionsVersion,
} from "./types-domain";

export interface AdviceRepository {
	/** 版が1つも無ければ初版を入れて使用中にする */
	seedInstructions(text: string, now: number): void;
	listInstructions(): InstructionsVersion[];
	getInstructions(version: number): InstructionsVersion | null;
	addInstructions(text: string, note: string, now: number): InstructionsVersion;
	activeInstructionsVersion(): number | null;
	setActiveInstructions(version: number): void;
	model(fallback: string): string;
	setModel(model: string): void;
	get(runId: number): BacktestAdvice | null;
	/**
	 * 生成を始めた印を付ける。前のアドバイスがあれば、生成が終わるまで本文とその生成条件は残す。
	 * 初めてなら生成条件だけ入れる
	 */
	markRunning(runId: number, g: AdviceGeneration, now: number): void;
	finishDone(
		runId: number,
		content: AdviceContent,
		g: AdviceGeneration,
		now: number,
	): void;
	/** 別の AI で作った本文を取り込む。前のアドバイスは置き換える */
	saveImported(
		runId: number,
		content: AdviceContent,
		g: AdviceGeneration,
		now: number,
	): void;
	/** 失敗しても前のアドバイスの本文と、それを作った時刻は残す */
	finishFailed(runId: number, error: string): void;
	/** サーバーが止まって生成中のまま残ったものを失敗にする */
	failInterrupted(): number;
}
