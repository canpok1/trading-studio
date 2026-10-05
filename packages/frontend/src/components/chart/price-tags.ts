// 価格の軸に「今」「買」のような1文字付きの値を出す描画拡張。
// 組み込みの価格線の名前は描画領域の内側に出て最新の足に重なるため、名前ごと軸のラベルに入れる

import type {
	AutoscaleInfo,
	ISeriesApi,
	ISeriesPrimitive,
	ISeriesPrimitiveAxisView,
	SeriesAttachedParameter,
	SeriesType,
	Time,
} from "lightweight-charts";
import { formatInt } from "../../lib/number";

/** 軸のラベル1つの高さ（px）。既定の文字の大きさで描いたときの高さ */
const LABEL_H = 20;

export type PriceTag = {
	price: number;
	/** 値の前に付ける1文字 */
	label: string;
	color: string;
	textColor: string;
	/** 縦の範囲に含める（足から離れていても画面に入れる） */
	keepInView: boolean;
};

export class PriceTags implements ISeriesPrimitive<Time> {
	private series: ISeriesApi<SeriesType> | null = null;
	private requestUpdate: (() => void) | null = null;
	private tags: PriceTag[] = [];

	attached(p: SeriesAttachedParameter<Time>) {
		this.series = p.series;
		this.requestUpdate = p.requestUpdate;
	}

	detached() {
		this.series = null;
		this.requestUpdate = null;
	}

	/** 先頭のタグは線の位置に置き、残りは重ならないよう上下へずらす */
	setTags(tags: PriceTag[]) {
		this.tags = tags;
		this.requestUpdate?.();
	}

	priceAxisViews(): ISeriesPrimitiveAxisView[] {
		return this.tags.map((t, i) => ({
			// 位置は layout() で決めた固定の座標を使う。自動の配置で空きを作らないよう、こちらは画面外にする
			coordinate: () => -1000,
			fixedCoordinate: () => this.layout()[i],
			text: () => `${t.label} ${formatInt(t.price)}`,
			textColor: () => t.textColor,
			backColor: () => t.color,
		}));
	}

	/**
	 * ラベルの縦位置。組み込みの重なりの回避は効かないことがあるので自前で行う。
	 * 先頭のラベルは線の位置に置き、他はそこから上下へ押し出す
	 */
	private layout(): (number | undefined)[] {
		const s = this.series;
		if (!s) return this.tags.map(() => undefined);
		const ys = this.tags.map(
			(t) => s.priceToCoordinate(t.price) as number | null,
		);
		const out: (number | undefined)[] = ys.map((y) => y ?? undefined);
		const anchor = ys[0] ?? null;
		const rest: { y: number; i: number }[] = [];
		ys.forEach((y, i) => {
			if (i > 0 && y !== null) rest.push({ y, i });
		});
		const below = rest
			.filter((v) => anchor === null || v.y >= anchor)
			.sort((a, b) => a.y - b.y);
		const above = rest
			.filter((v) => anchor !== null && v.y < anchor)
			.sort((a, b) => b.y - a.y);
		let prev = anchor ?? Number.NEGATIVE_INFINITY;
		for (const v of below) {
			prev = Math.max(v.y, prev + LABEL_H);
			out[v.i] = prev;
		}
		prev = anchor ?? Number.POSITIVE_INFINITY;
		for (const v of above) {
			prev = Math.min(v.y, prev - LABEL_H);
			out[v.i] = prev;
		}
		return out;
	}

	autoscaleInfo(): AutoscaleInfo | null {
		const prices = this.tags.filter((t) => t.keepInView).map((t) => t.price);
		if (prices.length === 0) return null;
		return {
			priceRange: {
				minValue: Math.min(...prices),
				maxValue: Math.max(...prices),
			},
		};
	}
}
