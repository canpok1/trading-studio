// 候補が2つ以上の戦略（ADR 0037）の、銘柄ごとの保有の見せ方

import type { AutoTradingStatus } from "@trading-studio/backend";
import type { Instrument } from "@trading-studio/core";
import { unrealizedPnl } from "@trading-studio/core";

/** 保有中の銘柄（候補の並び順） */
export function heldInstruments(status: AutoTradingStatus): Instrument[] {
	return status.instruments.filter((i) =>
		status.account.holdings.some(
			(h) => h.instrument === i.id && h.position.quantity > 0,
		),
	);
}

/** 全銘柄の保有の含み損益の和。保有が無いか、価格が分からない銘柄があれば null */
export function totalUnrealized(status: AutoTradingStatus): number | null {
	const held = heldInstruments(status);
	if (held.length === 0) return null;
	let sum = 0;
	for (const i of held) {
		const h = status.account.holdings.find((x) => x.instrument === i.id);
		const pnl = h
			? unrealizedPnl(i, h.position.quantity, h.position.entryPrice, h.price)
			: null;
		if (pnl === null) return null;
		sum += pnl;
	}
	return sum;
}
