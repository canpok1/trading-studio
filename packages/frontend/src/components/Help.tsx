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
	}>();
	const button = useRef<HTMLButtonElement>(null);
	const bubble = useRef<HTMLDivElement>(null);
	const id = useId();

	useLayoutEffect(() => {
		if (!open || !button.current) return;
		const r = button.current.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const width = Math.min(WIDTH, vw - GUTTER * 2);
		const left = Math.min(
			Math.max(r.left + r.width / 2 - width / 2, GUTTER),
			vw - width - GUTTER,
		);
		setPos({ top: r.bottom + 6, left, width });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
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
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", close, true);
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
					className={`fixed z-90 flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-xs leading-relaxed font-normal text-text shadow-xl ${pos ? "" : "invisible"}`}
				>
					{children}
				</div>
			)}
		</>
	);
}
