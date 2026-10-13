import type { ConditionSet } from "@trading-studio/core";
import type { StoredStrategy } from "./types-domain";

export interface StrategyRepository {
	list(): StoredStrategy[];
	get(id: number): StoredStrategy | null;
	/** 名前が name の戦略の ID。無ければ null */
	idByName(name: string): number | null;
	insert(name: string, params: ConditionSet, at: number): StoredStrategy;
	updateParams(id: number, params: ConditionSet, at: number): void;
	rename(id: number, name: string, at: number): void;
	/** 消せたら true */
	remove(id: number): boolean;
}
