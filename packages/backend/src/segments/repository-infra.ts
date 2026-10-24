import type { MarketRegime } from "@trading-studio/core";
import type { Db } from "../db/open-infra";
import type { SegmentRepository } from "./repository-domain";
import type { Segment } from "./types-domain";

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

export class SqliteSegmentRepository implements SegmentRepository {
	/** instrument は相場データの銘柄（core の Instrument の id） */
	constructor(
		private readonly db: Db,
		private readonly instrument: string,
	) {}

	private get sql() {
		return this.db.$client;
	}

	list(regime: MarketRegime | null): Segment[] {
		const rows =
			regime === null
				? this.sql
						.query<Row, [string]>(
							"select * from segments where instrument = ? order by from_time desc",
						)
						.all(this.instrument)
				: this.sql
						.query<Row, [string, string]>(
							"select * from segments where instrument = ? and regime = ? order by from_time desc",
						)
						.all(this.instrument, regime);
		return rows.map(toSegment);
	}

	get(id: number): Segment | null {
		const r = this.sql
			.query<Row, [number, string]>(
				"select * from segments where id = ? and instrument = ?",
			)
			.get(id, this.instrument);
		return r ? toSegment(r) : null;
	}

	exists(from: number, to: number): boolean {
		return (
			this.sql
				.query<{ n: number }, [string, number, number]>(
					"select 1 as n from segments where instrument = ? and from_time = ? and to_time = ?",
				)
				.get(this.instrument, from, to) !== null
		);
	}

	create(d: Omit<Segment, "id">): void {
		this.sql.run(
			"insert into segments (instrument, from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (instrument, from_time, to_time) do nothing",
			[
				this.instrument,
				d.from,
				d.to,
				d.regime,
				d.returnPpm,
				d.volatilityPpm,
				d.createdAt,
			],
		);
	}
}
