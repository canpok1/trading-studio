import type { MarketRegime } from "@trading-studio/core";
import type { Db } from "../db/open";
import type { Dataset } from "./types";

type Row = {
	id: number;
	from_time: number;
	to_time: number;
	regime: MarketRegime;
	return_ppm: number;
	volatility_ppm: number;
	created_at: number;
};

const toDataset = (r: Row): Dataset => ({
	id: r.id,
	from: r.from_time,
	to: r.to_time,
	regime: r.regime,
	returnPpm: r.return_ppm,
	volatilityPpm: r.volatility_ppm,
	createdAt: r.created_at,
});

export class DatasetRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	list(regime: MarketRegime | null): Dataset[] {
		const rows =
			regime === null
				? this.sql
						.query<Row, []>("select * from datasets order by from_time desc")
						.all()
				: this.sql
						.query<Row, [string]>(
							"select * from datasets where regime = ? order by from_time desc",
						)
						.all(regime);
		return rows.map(toDataset);
	}

	get(id: number): Dataset | null {
		const r = this.sql
			.query<Row, [number]>("select * from datasets where id = ?")
			.get(id);
		return r ? toDataset(r) : null;
	}

	exists(from: number, to: number): boolean {
		return (
			this.sql
				.query<{ n: number }, [number, number]>(
					"select 1 as n from datasets where from_time = ? and to_time = ?",
				)
				.get(from, to) !== null
		);
	}

	create(d: Omit<Dataset, "id">): void {
		this.sql.run(
			"insert into datasets (from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, ?, ?, ?, ?) on conflict (from_time, to_time) do nothing",
			[d.from, d.to, d.regime, d.returnPpm, d.volatilityPpm, d.createdAt],
		);
	}
}
