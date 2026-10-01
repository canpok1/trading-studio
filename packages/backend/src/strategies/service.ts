import type { ConditionSet } from "@trading-studio/core";
import {
	parseConditionSet,
	strategyTemplate,
	validateConditionSet,
} from "@trading-studio/core";
import type { Db } from "../db/open";
import type { StoredStrategy, StrategyResult, StrategyService } from "./types";

type Row = {
	id: number;
	name: string;
	params: string;
	created_at: number;
	updated_at: number;
};

const NAME_MAX = 40;

function toStrategy(r: Row): StoredStrategy {
	return {
		id: r.id,
		name: r.name,
		// 保存するときに形を検証しているので、読み出しでは形が崩れていない前提で読む
		params: parseConditionSet(JSON.parse(r.params)) as ConditionSet,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export function checkName(name: string): string | null {
	const n = name.trim();
	if (!n) return "名前を入れる";
	if (n.length > NAME_MAX) return `${NAME_MAX} 文字以内にする`;
	return null;
}

export function createStrategyService(
	db: Db,
	now: () => number = Date.now,
): StrategyService {
	const sql = db.$client;
	const byName = (name: string) =>
		sql
			.query<{ id: number }, [string]>(
				"select id from strategies where name = ?",
			)
			.get(name);

	const nameError = (name: string, selfId?: number): StrategyResult | null => {
		const invalid = checkName(name);
		if (invalid)
			return { ok: false, error: { kind: "invalid_name", message: invalid } };
		const same = byName(name.trim());
		if (same && same.id !== selfId) {
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
		list() {
			return sql
				.query<Row, []>("select * from strategies order by id")
				.all()
				.map(toStrategy);
		},

		get(id) {
			const r = sql
				.query<Row, [number]>("select * from strategies where id = ?")
				.get(id);
			return r ? toStrategy(r) : null;
		},

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
			const t = now();
			const r = sql
				.query<Row, [string, string, number, number]>(
					"insert into strategies (name, params, created_at, updated_at) values (?, ?, ?, ?) returning *",
				)
				.get(name.trim(), JSON.stringify(params), t, t) as Row;
			return { ok: true, strategy: toStrategy(r) };
		},

		updateParams(id, params) {
			if (!service.get(id)) return { ok: false, error: { kind: "not_found" } };
			const errors = validateConditionSet(params);
			if (errors.length)
				return { ok: false, error: { kind: "invalid_params", errors } };
			sql.run("update strategies set params = ?, updated_at = ? where id = ?", [
				JSON.stringify(params),
				now(),
				id,
			]);
			return { ok: true, strategy: service.get(id) as StoredStrategy };
		},

		rename(id, name) {
			if (!service.get(id)) return { ok: false, error: { kind: "not_found" } };
			const bad = nameError(name, id);
			if (bad) return bad;
			sql.run("update strategies set name = ?, updated_at = ? where id = ?", [
				name.trim(),
				now(),
				id,
			]);
			return { ok: true, strategy: service.get(id) as StoredStrategy };
		},

		remove(id) {
			return sql.run("delete from strategies where id = ?", [id]).changes > 0;
		},
	};
	return service;
}
