import type { MarketRegime } from "@trading-studio/core";
import type { Segment } from "./types-domain";

export interface SegmentRepository {
	list(regime: MarketRegime | null): Segment[];
	get(id: number): Segment | null;
	exists(from: number, to: number): boolean;
	create(d: Omit<Segment, "id">): void;
}
