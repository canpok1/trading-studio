import type { ReactNode } from "react";
import { Link } from "react-router";
import { Help } from "./Help";

/** 1画面の枠。広い画面でも幅の上限を設けず、左右に余白を作らない */
export function Page({
	title,
	description,
	help,
	actions,
	back,
	children,
}: {
	title: string;
	/** 見出しの上に出す、一覧などへ戻るリンク */
	back?: { to: string; label: string };
	description?: ReactNode;
	/** 見出しの横の「？」で出す、画面の説明 */
	help?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:max-w-none lg:px-6">
			<div className="flex">
				<div className="flex flex-1 flex-col gap-1">
					{back && (
						<Link
							to={back.to}
							className="self-start text-[13px] font-semibold text-text-2 hover:text-text"
						>
							← {back.label}
						</Link>
					)}
					<div className="flex items-center gap-2">
						<h1 className="text-[22px] font-bold">{title}</h1>
						{help && <Help label={title}>{help}</Help>}
					</div>
					{description && <p className="text-xs text-text-2">{description}</p>}
				</div>
				{actions && <div className="flex items-start gap-2">{actions}</div>}
			</div>
			{children}
		</div>
	);
}
