import type { ConditionSet } from "@trading-studio/core";
import {
	isTemplateId,
	parseConditionSet,
	strategyTemplate,
	validateConditionSet,
} from "@trading-studio/core";
import { DEFAULT_INSTRUMENT } from "../market-data/instrument-domain";
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
		if (params) from = { params };
	}
	if (!from) return { ok: false, message: "from の形が違う" };
	return { ok: true, input: { name: v.name, from } };
}

/** { params } の形の入力から条件セットを取り出す。形が違えば null */
export function parseParamsInput(v: unknown): ConditionSet | null {
	return parseConditionSet(isObj(v) ? v.params : null);
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
			if ("template" in from) {
				params = strategyTemplate(from.template).params;
			} else if ("copyOf" in from) {
				const src = service.get(from.copyOf);
				if (!src) return { ok: false, error: { kind: "not_found" } };
				params = src.params;
			} else {
				// 結果から新しい戦略として保存するときは、条件を検証する
				const errors = validateConditionSet(from.params);
				if (errors.length)
					return { ok: false, error: { kind: "invalid_params", errors } };
				params = from.params;
			}
			return {
				ok: true,
				strategy: repo.insert(
					name.trim(),
					DEFAULT_INSTRUMENT.marketId,
					params,
					now(),
				),
			};
		},

		updateParams(id, params) {
			if (!service.get(id)) return { ok: false, error: { kind: "not_found" } };
			const errors = validateConditionSet(params);
			if (errors.length)
				return { ok: false, error: { kind: "invalid_params", errors } };
			repo.updateParams(id, params, now());
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
