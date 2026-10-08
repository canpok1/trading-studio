// データセットの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { MarketRegime } from "@trading-studio/core";

export type Dataset = {
	id: number;
	from: number;
	/** この時刻は含まない */
	to: number;
	regime: MarketRegime;
	/** 期間の騰落率（ppm） */
	returnPpm: number;
	/** 日ごとの騰落率の標準偏差（ppm） */
	volatilityPpm: number;
	createdAt: number;
};

export interface DatasetService {
	/** 新しい順。regime を渡すとその相場だけ */
	list(regime?: MarketRegime | null): Dataset[];
	get(id: number): Dataset | null;
}
