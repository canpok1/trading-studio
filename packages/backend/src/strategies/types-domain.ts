// 戦略の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	ConditionSet,
	TemplateId,
	ValidationError,
} from "@trading-studio/core";

export type StoredStrategy = {
	id: number;
	name: string;
	/** 市場（core の Market の id） */
	market: string;
	/** 候補の銘柄（core の Instrument の id）。順位の決め方が無ければ、並び順が買いの優先順位 */
	instruments: string[];
	params: ConditionSet;
	createdAt: number;
	updatedAt: number;
};

export type StrategyFailure =
	| { kind: "not_found" }
	| { kind: "invalid_name"; message: string }
	| { kind: "duplicate_name"; message: string }
	| { kind: "invalid_params"; errors: ValidationError[] };

export type StrategyResult =
	| { ok: true; strategy: StoredStrategy }
	| { ok: false; error: StrategyFailure };

export type CreateStrategyInput = {
	name: string;
	from:
		| { template: TemplateId }
		| { copyOf: number }
		| {
				params: ConditionSet;
				/** 候補の銘柄の id。省くと BTC/JPY だけ */
				instruments?: string[];
		  };
};

export interface StrategyService {
	list(): StoredStrategy[];
	get(id: number): StoredStrategy | null;
	create(input: CreateStrategyInput): StrategyResult;
	/** instruments（候補の銘柄の id）を省くと今の候補のまま */
	updateParams(
		id: number,
		params: ConditionSet,
		instruments?: string[],
	): StrategyResult;
	rename(id: number, name: string): StrategyResult;
	remove(id: number): boolean;
}
