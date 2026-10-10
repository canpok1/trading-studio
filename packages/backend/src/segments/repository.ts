import type { MarketRegime } from "@trading-studio/core";
import type { Db } from "../db/open";
import type { Segment } from "./types";

type Row = {
	id: number;
	from_time: number;
	to_time: number;
	regime: MarketRegime;
	return_ppm: number;
	volatility_ppm: number;
	created_at: number;
};

const toSegment = (r: Row): Segment => ({
	id: r.id,
	from: r.from_time,
	to: r.to_time,
	regime: r.regime,
	returnPpm: r.return_ppm,
	volatilityPpm: r.volatility_ppm,
	createdAt: r.created_at,
});

export class SegmentRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	list(regime: MarketRegime | null): Segment[] {
		const rows =
			regime === null
				? this.sql
						.query<Row, []>("select * from segments order by from_time desc")
						.all()
				: this.sql
						.query<Row, [string]>(
							"select * from segments where regime = ? order by from_time desc",
						)
						.all(regime);
		return rows.map(toSegment);
	}

	get(id: number): Segment | null {
		const r = this.sql
			.query<Row, [number]>("select * from segments where id = ?")
			.get(id);
		return r ? toSegment(r) : null;
	}

	exists(from: number, to: number): boolean {
		return (
			this.sql
				.query<{ n: number }, [number, number]>(
					"select 1 as n from segments where from_time = ? and to_time = ?",
				)
				.get(from, to) !== null
		);
	}

	create(d: Omit<Segment, "id">): void {
		this.sql.run(
			"insert into segments (from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, ?, ?, ?, ?) on conflict (from_time, to_time) do nothing",
			[d.from, d.to, d.regime, d.returnPpm, d.volatilityPpm, d.createdAt],
		);
	}
}
