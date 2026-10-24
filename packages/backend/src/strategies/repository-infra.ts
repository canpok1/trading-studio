import type { ConditionSet } from "@trading-studio/core";
import { parseConditionSet } from "@trading-studio/core";
import type { Db } from "../db/open-infra";
import type { StrategyRepository } from "./repository-domain";
import type { StoredStrategy } from "./types-domain";

type Row = {
	id: number;
	name: string;
	market: string;
	instruments: string;
	params: string;
	created_at: number;
	updated_at: number;
};

function toStrategy(r: Row): StoredStrategy {
	return {
		id: r.id,
		name: r.name,
		market: r.market,
		instruments: JSON.parse(r.instruments),
		// 保存するときに形を検証しているので、読み出しでは形が崩れていない前提で読む
		params: parseConditionSet(JSON.parse(r.params)) as ConditionSet,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export class SqliteStrategyRepository implements StrategyRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	list(): StoredStrategy[] {
		return this.sql
			.query<Row, []>("select * from strategies order by id")
			.all()
			.map(toStrategy);
	}

	get(id: number): StoredStrategy | null {
		const r = this.sql
			.query<Row, [number]>("select * from strategies where id = ?")
			.get(id);
		return r ? toStrategy(r) : null;
	}

	idByName(name: string): number | null {
		return (
			this.sql
				.query<{ id: number }, [string]>(
					"select id from strategies where name = ?",
				)
				.get(name)?.id ?? null
		);
	}

	insert(
		name: string,
		market: string,
		instruments: readonly string[],
		params: ConditionSet,
		at: number,
	): StoredStrategy {
		const r = this.sql
			.query<Row, [string, string, string, string, number, number]>(
				"insert into strategies (name, market, instruments, params, created_at, updated_at) values (?, ?, ?, ?, ?, ?) returning *",
			)
			.get(
				name,
				market,
				JSON.stringify(instruments),
				JSON.stringify(params),
				at,
				at,
			) as Row;
		return toStrategy(r);
	}

	updateParams(id: number, params: ConditionSet, at: number): void {
		this.sql.run(
			"update strategies set params = ?, updated_at = ? where id = ?",
			[JSON.stringify(params), at, id],
		);
	}

	rename(id: number, name: string, at: number): void {
		this.sql.run(
			"update strategies set name = ?, updated_at = ? where id = ?",
			[name, at, id],
		);
	}

	remove(id: number): boolean {
		return (
			this.sql.run("delete from strategies where id = ?", [id]).changes > 0
		);
	}
}
