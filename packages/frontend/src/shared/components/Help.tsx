import type { ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { HelpIcon } from "./icons";

/** 吹き出しの幅の上限と、画面の端からあける幅 */
const WIDTH = 320;
const GUTTER = 12;

/**
 * 見出しの横に置く「？」。押すと説明を吹き出しで出す。
 * 使い慣れれば要らない説明を、見たいときだけ見られるようにする。
 * 外側を押す・Esc・スクロールで閉じる
 */
export function Help({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{
		top: number;
		left: number;
		width: number;
		maxHeight: number;
	}>();
	const button = useRef<HTMLButtonElement>(null);
	const bubble = useRef<HTMLDivElement>(null);
	const id = useId();

	useLayoutEffect(() => {
		if (!open || !button.current || !bubble.current) return;
		const r = button.current.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		const width = Math.min(WIDTH, vw - GUTTER * 2);
		const left = Math.min(
			Math.max(r.left + r.width / 2 - width / 2, GUTTER),
			vw - width - GUTTER,
		);
		// 高さは幅で決まるので、幅を当ててから測る。下に収まらず上に収まるなら上に出す
		bubble.current.style.width = `${width}px`;
		const h = bubble.current.offsetHeight;
		const below = r.bottom + 6;
		const above = r.top - 6 - h;
		const top = below + h > vh - GUTTER && above >= GUTTER ? above : below;
		setPos({ top, left, width, maxHeight: vh - top - GUTTER });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		// 吹き出しの中のスクロール（長い説明）では閉じない
		const onScroll = (e: Event) => {
			if (bubble.current?.contains(e.target as Node)) return;
			close();
		};
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (bubble.current?.contains(t) || button.current?.contains(t)) return;
			close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	return (
		<>
			<button
				ref={button}
				type="button"
				aria-label={`${label}の説明`}
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((v) => !v)}
				className={`-m-1.5 inline-flex shrink-0 items-center justify-center rounded-full p-1.5 align-middle font-normal ${open ? "text-accent" : "text-text-2/70 hover:text-text"}`}
			>
				<HelpIcon />
			</button>
			{open && (
				<div
					ref={bubble}
					id={id}
					role="note"
					aria-label={`${label}の説明`}
					style={pos}
					className={`fixed z-90 flex flex-col overflow-auto gap-1.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-xs leading-relaxed font-normal text-text shadow-xl ${pos ? "" : "invisible"}`}
				>
					{children}
				</div>
			)}
		</>
	);
}
