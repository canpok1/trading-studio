import type { ConditionSet, ValidationError } from "@trading-studio/core";
import {
	instrumentOf,
	isTemplateId,
	marketOf,
	parseConditionSet,
	strategyTemplate,
	validateCandidates,
	validateConditionSet,
} from "@trading-studio/core";
import {
	COLLECTED_IDS,
	DEFAULT_INSTRUMENT,
} from "../market-data/instrument-domain";
import type { StrategyRepository } from "./repository-domain";
import type {
	CreateStrategyInput,
	StoredStrategy,
	StrategyResult,
	StrategyService,
} from "./types-domain";

const NAME_MAX = 40;

export function checkName(name: string): string | null {
	const n = name.trim();
	if (!n) return "名前を入れる";
	if (n.length > NAME_MAX) return `${NAME_MAX} 文字以内にする`;
	return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

/** 候補の銘柄の id の並び。省けば undefined、形が違うか価格を集めていない銘柄があれば null */
function parseInstruments(v: unknown): string[] | undefined | null {
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) return null;
	return v.every(
		(x): x is string => typeof x === "string" && COLLECTED_IDS.includes(x),
	)
		? v
		: null;
}

/** 条件と候補の銘柄の検証。候補は先頭の銘柄の市場で条件を確かめる */
function validateStrategy(
	params: ConditionSet,
	instruments: readonly string[],
): ValidationError[] {
	const list = instruments.map(instrumentOf);
	return [
		...validateConditionSet(params, marketOf(list[0] ?? DEFAULT_INSTRUMENT)),
		...validateCandidates(params, list),
	];
}

/** 戦略を作る入力の形を確かめる（名前と条件の中身は create で確かめる） */
export function parseCreateInput(
	v: unknown,
): { ok: true; input: CreateStrategyInput } | { ok: false; message: string } {
	if (!isObj(v) || typeof v.name !== "string" || !isObj(v.from)) {
		return { ok: false, message: "name と from が必要" };
	}
	const f = v.from;
	let from: CreateStrategyInput["from"] | null = null;
	if (isTemplateId(f.template)) from = { template: f.template };
	else if (typeof f.copyOf === "number") from = { copyOf: f.copyOf };
	else {
		const params = parseConditionSet(f.params);
		const instruments = parseInstruments(f.instruments);
		if (params && instruments !== null)
			from = instruments ? { params, instruments } : { params };
	}
	if (!from) return { ok: false, message: "from の形が違う" };
	return { ok: true, input: { name: v.name, from } };
}

/** { params } の形の入力から条件セットを取り出す。形が違えば null */
export function parseParamsInput(v: unknown): ConditionSet | null {
	return parseConditionSet(isObj(v) ? v.params : null);
}

/** { params, instruments? } の形の入力。形が違うか価格を集めていない銘柄があれば null */
export function parseUpdateInput(
	v: unknown,
): { params: ConditionSet; instruments?: string[] } | null {
	const params = parseParamsInput(v);
	const instruments = parseInstruments(isObj(v) ? v.instruments : undefined);
	if (!params || instruments === null) return null;
	return instruments ? { params, instruments } : { params };
}

export function createStrategyService(
	repo: StrategyRepository,
	now: () => number = Date.now,
): StrategyService {
	const nameError = (name: string, selfId?: number): StrategyResult | null => {
		const invalid = checkName(name);
		if (invalid)
			return { ok: false, error: { kind: "invalid_name", message: invalid } };
		const same = repo.idByName(name.trim());
		if (same !== null && same !== selfId) {
			return {
				ok: false,
				error: {
					kind: "duplicate_name",
					message: "同じ名前の戦略がある。別の名前にする",
				},
			};
		}
		return null;
	};

	const service: StrategyService = {
		list: () => repo.list(),
		get: (id) => repo.get(id),

		create({ name, from }) {
			const bad = nameError(name);
			if (bad) return bad;
			let params: ConditionSet;
			let market = DEFAULT_INSTRUMENT.marketId;
			let instruments = [DEFAULT_INSTRUMENT.id];
			if ("template" in from) {
				params = strategyTemplate(from.template).params;
			} else if ("copyOf" in from) {
				const src = service.get(from.copyOf);
				if (!src) return { ok: false, error: { kind: "not_found" } };
				params = src.params;
				market = src.market;
				instruments = src.instruments;
			} else {
				// 結果から新しい戦略として保存するときは、条件を検証する
				instruments = from.instruments ?? instruments;
				const errors = validateStrategy(from.params, instruments);
				if (errors.length)
					return { ok: false, error: { kind: "invalid_params", errors } };
				params = from.params;
				market = instrumentOf(instruments[0] as string).marketId;
			}
			return {
				ok: true,
				strategy: repo.insert(name.trim(), market, instruments, params, now()),
			};
		},

		updateParams(id, params, instruments) {
			const s = service.get(id);
			if (!s) return { ok: false, error: { kind: "not_found" } };
			const next = instruments ?? s.instruments;
			const errors = validateStrategy(params, next);
			// 戦略の市場は作ったときに決まる
			if (
				next.some((i) => instrumentOf(i).marketId !== s.market) &&
				!errors.some((e) => e.path === "instruments")
			)
				errors.push({
					path: "instruments",
					message: "候補は戦略の市場の銘柄だけにする",
				});
			if (errors.length)
				return { ok: false, error: { kind: "invalid_params", errors } };
			repo.updateParams(id, params, next, now());
			return { ok: true, strategy: service.get(id) as StoredStrategy };
		},

		rename(id, name) {
			if (!service.get(id)) return { ok: false, error: { kind: "not_found" } };
			const bad = nameError(name, id);
			if (bad) return bad;
			repo.rename(id, name.trim(), now());
			return { ok: true, strategy: service.get(id) as StoredStrategy };
		},

		remove: (id) => repo.remove(id),
	};
	return service;
}
