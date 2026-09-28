import { conditionStrategy } from "@trading-studio/core";
import type { BacktestRepository } from "../backtests/repository";
import type { BacktestService } from "../backtests/types";
import type { GeminiModel } from "../news/gemini";
import { SCORING_MODELS } from "../news/gemini";
import { readImprovedStrategy } from "./improved";
import { buildAdviceSource } from "./input";
import {
	ADVICE_RESPONSE_SCHEMA,
	ADVICE_TEMPLATE,
	buildAdvicePrompt,
	parseAdviceResponse,
} from "./prompt";
import type { AdviceGeneration, AdviceRepository } from "./repository";
import type { AdviceService, BacktestAdvice } from "./types";

/** 選べるモデルは採点と同じ。分析は採点より重いので、既定は Flash にする */
export const ADVICE_MODELS = SCORING_MODELS;
export const DEFAULT_ADVICE_MODEL = "gemini-3.8-flash";

export const INSTRUCTIONS_MAX = 4000;
const NOTE_MAX = 100;

export function createAdviceService({
	repo,
	backtests,
	backtestRepo,
	model,
	appBuiltAt,
	now = Date.now,
}: {
	repo: AdviceRepository;
	backtests: Pick<BacktestService, "get" | "chart">;
	backtestRepo: Pick<BacktestRepository, "orders">;
	model: GeminiModel;
	appBuiltAt: number | null;
	now?: () => number;
}): AdviceService & { running(runId: number): Promise<void> | null } {
	const isModel = (id: string) => ADVICE_MODELS.some((m) => m.id === id);
	const jobs = new Map<number, Promise<void>>();

	const generate = async (runId: number, g: AdviceGeneration, text: string) => {
		try {
			const run = backtests.get(runId);
			const chart = backtests.chart(runId);
			const orders = backtestRepo.orders(runId);
			if (!run || !chart || !orders)
				throw new Error("バックテストの結果が無い");
			const usesJudgments =
				conditionStrategy.requiredJudges(run.params).length > 0;
			const source = buildAdviceSource({
				run,
				bars: chart.bars,
				orders,
				judgments: usesJudgments ? chart.judgments : null,
			});
			const raw = await model.generate(
				g.model,
				buildAdvicePrompt(source, text),
				ADVICE_RESPONSE_SCHEMA,
			);
			const body = parseAdviceResponse(raw);
			const improved = readImprovedStrategy(
				(raw as Record<string, unknown>).improvedStrategy,
				run.params,
			);
			repo.finishDone(runId, { ...body, improved }, g, now());
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error("advice failed", e);
			repo.finishFailed(runId, message);
		}
	};

	return {
		get: (runId) => repo.get(runId),

		start(runId) {
			const run = backtests.get(runId);
			if (!run) {
				return {
					ok: false,
					status: 404,
					message: "バックテストが見つからない",
				};
			}
			if (run.status !== "done") {
				return {
					ok: false,
					status: 409,
					message: "終わったバックテストだけアドバイスを作れる",
				};
			}
			if (jobs.has(runId)) {
				return {
					ok: false,
					status: 409,
					message: "アドバイスを作っている途中",
				};
			}
			const unavailable = model.unavailable();
			if (unavailable) return { ok: false, status: 503, message: unavailable };
			const version = repo.activeInstructionsVersion();
			const instructions =
				version === null ? null : repo.getInstructions(version);
			if (!instructions) {
				return { ok: false, status: 409, message: "使用中の指示が無い" };
			}
			const g: AdviceGeneration = {
				model: repo.model(DEFAULT_ADVICE_MODEL),
				instructionsVersion: instructions.version,
				appBuiltAt,
			};
			repo.markRunning(runId, g, now());
			const job = generate(runId, g, instructions.text).finally(() => {
				jobs.delete(runId);
			});
			jobs.set(runId, job);
			return { ok: true, advice: repo.get(runId) as BacktestAdvice };
		},

		instructions: () => ({
			versions: repo.listInstructions(),
			activeVersion: repo.activeInstructionsVersion(),
			template: ADVICE_TEMPLATE,
		}),

		addInstructions(text, note) {
			const t = text.trim();
			if (!t) return { ok: false, message: "指示を入れる" };
			if (t.length > INSTRUCTIONS_MAX)
				return { ok: false, message: `${INSTRUCTIONS_MAX} 文字以内にする` };
			const n = note.trim().slice(0, NOTE_MAX) || "画面から編集";
			return { ok: true, version: repo.addInstructions(t, n, now()) };
		},

		setActiveInstructions(version) {
			if (!repo.getInstructions(version)) return false;
			repo.setActiveInstructions(version);
			return true;
		},

		models: () => ({
			models: ADVICE_MODELS.map((m) => ({ id: m.id, label: m.label })),
			current: repo.model(DEFAULT_ADVICE_MODEL),
		}),

		setModel(id) {
			if (!isModel(id)) return false;
			repo.setModel(id);
			return true;
		},

		running: (runId) => jobs.get(runId) ?? null,
	};
}
