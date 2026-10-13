// 戦略の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	ConditionSet,
	TemplateId,
	ValidationError,
} from "@trading-studio/core";

export type StoredStrategy = {
	id: number;
	name: string;
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
		| { params: ConditionSet };
};

export interface StrategyService {
	list(): StoredStrategy[];
	get(id: number): StoredStrategy | null;
	create(input: CreateStrategyInput): StrategyResult;
	updateParams(id: number, params: ConditionSet): StrategyResult;
	rename(id: number, name: string): StrategyResult;
	remove(id: number): boolean;
}
