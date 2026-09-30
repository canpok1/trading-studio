import type { Db } from "../db/open";
import type {
	AdviceContent,
	BacktestAdvice,
	InstructionsVersion,
} from "./types";

type AdviceRow = {
	run_id: number;
	status: BacktestAdvice["status"];
	content: string | null;
	model: string;
	instructions_version: number;
	app_built_at: number | null;
	started_at: number;
	finished_at: number | null;
	error: string | null;
};

const toAdvice = (r: AdviceRow): BacktestAdvice => ({
	runId: r.run_id,
	status: r.status,
	content: r.content === null ? null : (JSON.parse(r.content) as AdviceContent),
	model: r.model,
	instructionsVersion: r.instructions_version,
	appBuiltAt: r.app_built_at,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
	error: r.error,
});

type InstructionsRow = {
	version: number;
	text: string;
	note: string;
	created_at: number;
};

const toInstructions = (r: InstructionsRow): InstructionsVersion => ({
	version: r.version,
	text: r.text,
	note: r.note,
	createdAt: r.created_at,
});

const ACTIVE_INSTRUCTIONS_KEY = "advice_instructions_active";
const MODEL_KEY = "advice_model";

export type AdviceGeneration = {
	model: string;
	instructionsVersion: number;
	appBuiltAt: number | null;
};

export class AdviceRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	private setting(key: string): string | null {
		return (
			this.sql
				.query<{ value: string }, [string]>(
					"select value from settings where key = ?",
				)
				.get(key)?.value ?? null
		);
	}

	private setSetting(key: string, value: string) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[key, value],
		);
	}

	/** 版が1つも無ければ初版を入れて使用中にする */
	seedInstructions(text: string, now: number) {
		this.sql.transaction(() => {
			if (this.listInstructions().length > 0) return;
			const v = this.addInstructions(text, "初版", now);
			this.setActiveInstructions(v.version);
		})();
	}

	listInstructions(): InstructionsVersion[] {
		return this.sql
			.query<InstructionsRow, []>(
				"select * from advice_instructions order by version",
			)
			.all()
			.map(toInstructions);
	}

	getInstructions(version: number): InstructionsVersion | null {
		const r = this.sql
			.query<InstructionsRow, [number]>(
				"select * from advice_instructions where version = ?",
			)
			.get(version);
		return r ? toInstructions(r) : null;
	}

	addInstructions(
		text: string,
		note: string,
		now: number,
	): InstructionsVersion {
		return toInstructions(
			this.sql
				.query<InstructionsRow, [string, string, number]>(
					"insert into advice_instructions (text, note, created_at) values (?, ?, ?) returning *",
				)
				.get(text, note, now) as InstructionsRow,
		);
	}

	activeInstructionsVersion(): number | null {
		const v = this.setting(ACTIVE_INSTRUCTIONS_KEY);
		return v === null ? null : Number(v);
	}

	setActiveInstructions(version: number) {
		this.setSetting(ACTIVE_INSTRUCTIONS_KEY, String(version));
	}

	model(fallback: string): string {
		return this.setting(MODEL_KEY) ?? fallback;
	}

	setModel(model: string) {
		this.setSetting(MODEL_KEY, model);
	}

	get(runId: number): BacktestAdvice | null {
		const r = this.sql
			.query<AdviceRow, [number]>(
				"select * from backtest_advice where run_id = ?",
			)
			.get(runId);
		return r ? toAdvice(r) : null;
	}

	/**
	 * 生成を始めた印を付ける。前のアドバイスがあれば、生成が終わるまで本文とその生成条件は残す。
	 * 初めてなら生成条件だけ入れる
	 */
	markRunning(runId: number, g: AdviceGeneration, now: number) {
		this.sql.run(
			`insert into backtest_advice (run_id, status, content, model, instructions_version, app_built_at, started_at)
			 values (?, 'running', null, ?, ?, ?, ?)
			 on conflict (run_id) do update set status = 'running', started_at = excluded.started_at, error = null`,
			[runId, g.model, g.instructionsVersion, g.appBuiltAt, now],
		);
	}

	finishDone(
		runId: number,
		content: AdviceContent,
		g: AdviceGeneration,
		now: number,
	) {
		this.sql.run(
			`update backtest_advice set status = 'done', content = ?, model = ?, instructions_version = ?, app_built_at = ?, finished_at = ?, error = null
			 where run_id = ?`,
			[
				JSON.stringify(content),
				g.model,
				g.instructionsVersion,
				g.appBuiltAt,
				now,
				runId,
			],
		);
	}

	/** 別の AI で作った本文を取り込む。前のアドバイスは置き換える */
	saveImported(
		runId: number,
		content: AdviceContent,
		g: AdviceGeneration,
		now: number,
	) {
		this.sql.run(
			`insert into backtest_advice (run_id, status, content, model, instructions_version, app_built_at, started_at, finished_at)
			 values (?, 'done', ?, ?, ?, ?, ?, ?)
			 on conflict (run_id) do update set status = 'done', content = excluded.content, model = excluded.model,
			   instructions_version = excluded.instructions_version, app_built_at = excluded.app_built_at,
			   started_at = excluded.started_at, finished_at = excluded.finished_at, error = null`,
			[
				runId,
				JSON.stringify(content),
				g.model,
				g.instructionsVersion,
				g.appBuiltAt,
				now,
				now,
			],
		);
	}

	/** 失敗しても前のアドバイスの本文と、それを作った時刻は残す */
	finishFailed(runId: number, error: string) {
		this.sql.run(
			"update backtest_advice set status = 'failed', error = ? where run_id = ?",
			[error, runId],
		);
	}

	/** サーバーが止まって生成中のまま残ったものを失敗にする */
	failInterrupted(): number {
		return this.sql.run(
			"update backtest_advice set status = 'failed', error = 'サーバーが途中で止まったため中断した' where status = 'running'",
		).changes;
	}
}
