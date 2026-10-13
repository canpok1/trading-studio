// ホームのパネルの枠と見出し。6つのパネルで見た目を揃える

import type { ReactNode } from "react";
import { Link } from "react-router";

export const PANEL =
	"flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3.5";

/** 見出し。link を渡すと右端に移動先を出す */
export function PanelHeader({
	title,
	tag,
	link,
}: {
	title: string;
	tag?: ReactNode;
	link?: { to: string; label: string };
}) {
	return (
		<div className="flex min-h-6 items-center justify-between gap-2">
			<h2 className="flex items-center gap-2 text-[15px] font-bold">
				{title}
				{tag}
			</h2>
			{link && (
				<Link
					to={link.to}
					className="-my-1.5 h-9 px-1.5 text-[13px] leading-9 font-semibold text-accent"
				>
					{link.label}
				</Link>
			)}
		</div>
	);
}
