import { expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { changeValue, setupDom } from "./test-setup";

setupDom();

function Field({ type, initial }: { type: string; initial: string }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<input
				type={type}
				aria-label="欄"
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			<output>{value}</output>
		</>
	);
}

test.each([
	["text", "a", "b"],
	["date", "2026-01-01", "2026-02-03"],
	["number", "1", ""],
])(
	"changeValue で %s の入力欄の onChange が呼ばれる",
	(type, initial, next) => {
		const view = render(<Field type={type} initial={initial} />);
		changeValue(view.getByLabelText("欄"), next);
		expect(view.container.querySelector("output")?.textContent).toBe(next);
		cleanup();
	},
);
