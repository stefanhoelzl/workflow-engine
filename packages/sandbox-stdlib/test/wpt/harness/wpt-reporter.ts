import type { RunnerTask, RunnerTestFile } from "vitest";
import { DefaultReporter } from "vitest/node";

interface FileStats {
	executed: number;
	skipped: number;
}

interface TestStats {
	passed: number;
	failed: number;
	skipped: number;
}

function padTitle(label: string): string {
	return `${label.padStart(11)} `;
}

function formatDuration(ms: number): string {
	return ms > 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function percent(numerator: number, denominator: number): string {
	return denominator > 0 ? ((numerator / denominator) * 100).toFixed(1) : "0.0";
}

function sumBy<T>(items: T[], pick: (item: T) => number | undefined): number {
	let total = 0;
	for (const item of items) {
		total += pick(item) ?? 0;
	}
	return total;
}

function collectTests(task: RunnerTask, out: RunnerTask[]): void {
	if (task.type === "test") {
		out.push(task);
		return;
	}
	for (const child of task.tasks) {
		collectTests(child, out);
	}
}

function hasExecutedTest(task: RunnerTask): boolean {
	if (task.type === "test") {
		return task.mode === "run";
	}
	return task.tasks.some(hasExecutedTest);
}

function countFiles(files: RunnerTestFile[]): FileStats {
	let executed = 0;
	let skipped = 0;
	for (const file of files) {
		for (const task of file.tasks) {
			if (task.type !== "suite") {
				continue;
			}
			if (hasExecutedTest(task)) {
				executed++;
			} else {
				skipped++;
			}
		}
	}
	return { executed, skipped };
}

function classifyTest(task: RunnerTask, stats: TestStats): void {
	if (task.mode === "skip" || task.mode === "todo") {
		stats.skipped++;
		return;
	}
	if (task.result?.state === "pass") {
		stats.passed++;
		return;
	}
	if (task.result?.state === "fail") {
		stats.failed++;
	}
}

function countTests(files: RunnerTestFile[]): TestStats {
	const tests: RunnerTask[] = [];
	for (const file of files) {
		collectTests(file, tests);
	}
	const stats: TestStats = { passed: 0, failed: 0, skipped: 0 };
	for (const t of tests) {
		classifyTest(t, stats);
	}
	return stats;
}

class WptReporter extends DefaultReporter {
	override reportTestSummary(
		files: RunnerTestFile[],
		errors: unknown[],
		leakCount: number,
	): void {
		this.log();

		const fileStats = countFiles(files);
		const filesTotal = fileStats.executed + fileStats.skipped;
		const fileRate = percent(fileStats.executed, filesTotal);

		const testStats = countTests(files);
		const { passed, failed, skipped } = testStats;
		const testsTotal = passed + failed + skipped;
		const testRate = percent(passed, testsTotal);

		this.log(
			padTitle("Files"),
			`${fileStats.executed} executed | ${fileStats.skipped} skipped (${filesTotal})`,
		);
		this.log(
			padTitle("Tests"),
			`${passed} passed | ${failed} failed | ${skipped} skipped (${testsTotal})`,
		);
		this.log(
			padTitle("File rate"),
			`${fileRate}% (${fileStats.executed} / ${filesTotal})`,
		);
		this.log(padTitle("Test rate"), `${testRate}% (${passed} / ${testsTotal})`);

		if (errors.length > 0) {
			this.log(
				padTitle("Errors"),
				`${errors.length} error${errors.length > 1 ? "s" : ""}`,
			);
		}
		if (leakCount > 0) {
			this.log(
				padTitle("Leaks"),
				`${leakCount} leak${leakCount > 1 ? "s" : ""}`,
			);
		}
		const transform = this.ctx.state.transformTime;
		const setup = sumBy(files, (f) => f.setupDuration);
		const importTime = sumBy(files, (f) => f.collectDuration);
		const testsTime = sumBy(files, (f) => f.result?.duration);
		const environment = sumBy(files, (f) => f.environmentLoad);
		const breakdown = [
			`transform ${formatDuration(transform)}`,
			`setup ${formatDuration(setup)}`,
			`import ${formatDuration(importTime)}`,
			`tests ${formatDuration(testsTime)}`,
			`environment ${formatDuration(environment)}`,
		].join(", ");
		this.log(
			padTitle("Duration"),
			`${formatDuration(this.end - this.start)} (${breakdown})`,
		);
		this.log();
	}
}

export { WptReporter };
