// 自動取引の注文の表示。ホームと取引画面で使う

import type { StoredOrder, TradingMode } from "@trading-studio/backend";
import type { JudgmentValue } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";
import { useEffect, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson } from "../../lib/useAsync";
import { OrderSheet } from "../backtest/OrderViews";
import { JudgmentBadge } from "../judgment/JudgmentBadge";
import { Modal } from "../Modal";
import { Button } from "../ui";

export const MODE_LABELS: Record<TradingMode, string> = {
	paper: "ペーパー",
	live: "ライブ",
};

/** 行の右端に出すモードの印。「すべて」で見てもライブを見分けられるように色を変える */
export function ModeTag({ mode }: { mode: TradingMode }) {
	return (
		<span
			data-testid="mode-tag"
			className={`inline-flex h-[22px] items-center rounded px-[7px] text-[11px] font-bold ${mode === "live" ? "bg-loss text-white" : "bg-paper text-paper-ink"}`}
		>
			{MODE_LABELS[mode]}
		</span>
	);
}

type Detail = {
	order: StoredOrder;
	/** 判定器 → 発注した判断のときの判定。判断の記録が無ければ null */
	judgments: Record<string, string> | null;
};

/**
 * 注文の詳細。一覧で持っている注文をすぐ出し、そのときの判定は発注した判断の記録から読む。
 * 対応する売買へ移るときは onSelect で id を渡す
 */
export function TradeOrderSheet({
	mode,
	id,
	initial,
	onSelect,
	onClose,
}: {
	mode: TradingMode;
	id: string;
	initial: StoredOrder | null;
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	const api = useApi();
	const [detail, setDetail] = useState<Detail | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		setDetail(null);
		setError(null);
		api.api.trading.orders[":mode"][":id"]
			.$get({ param: { mode, id } })
			.then((res) => readJson<Detail>(res))
			.then((d) => {
				if (alive) setDetail(d);
			})
			.catch((e) => {
				if (alive) setError(errorMessage(e));
			});
		return () => {
			alive = false;
		};
	}, [api, mode, id]);

	const order = detail?.order ?? (initial?.id === id ? initial : null);
	if (!order) {
		return error ? <OrderError message={error} onClose={onClose} /> : null;
	}
	const judgments = detail?.judgments ?? null;
	return (
		<OrderSheet order={order} onClose={onClose} onPair={onSelect}>
			<div className="flex flex-col gap-1.5">
				<h3 className="text-xs font-semibold text-text-2">このときの判定</h3>
				{detail === null ? (
					<p className="text-sm text-text-2">
						{error ? `読み込めなかった（${error}）` : "読み込み中…"}
					</p>
				) : judgments && Object.keys(judgments).length > 0 ? (
					<div className="flex flex-wrap gap-1.5">
						{JUDGES.filter((j) => judgments[j] !== undefined).map((j) => (
							<JudgmentBadge
								key={j}
								judge={j}
								value={judgments[j] as JudgmentValue}
							/>
						))}
					</div>
				) : (
					<p className="text-sm text-text-2">記録がない</p>
				)}
			</div>
		</OrderSheet>
	);
}

function OrderError({
	message,
	onClose,
}: {
	message: string;
	onClose: () => void;
}) {
	return (
		<Modal title="注文の詳細" onClose={onClose}>
			<p role="alert" className="text-sm">
				注文を読み込めなかった（{message}）
			</p>
			<Button onClick={onClose}>閉じる</Button>
		</Modal>
	);
}
