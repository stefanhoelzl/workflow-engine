// Mail plugin entry file. The `?sandbox-plugin` vite transform produces two
// independent rollup bundles from this file:
//
//   • WORKER PASS — synthetic entry `export { worker as default }`. Only
//     `worker` is reachable; its transitive imports (worker.ts → nodemailer,
//     net-guard) are bundled into `workerSource` as an ESM string. The
//     json() plugin handles nodemailer's `require('../../package.json')`
//     version-string reads.
//
//   • GUEST PASS — synthetic entry `import { guest } from ...; guest()`. The
//     worker re-export is unreachable from guest() and gets DCE'd, along
//     with worker.ts and nodemailer. This is why `worker` lives in a
//     separate file: if nodemailer imports lived at the top of this file,
//     the guest pass's `moduleSideEffects: "no-external"` would preserve
//     them as side-effectful and pull the whole SMTP stack into a QuickJS
//     IIFE that has no Node surface to run it.

// biome-ignore lint/style/noExportedImports: MAIL_DISPATCHER_NAME is consumed inside this file AND re-exported so worker.ts (and tests) reference the same constant
import { MAIL_DISPATCHER_NAME } from "./descriptor-name.js";

const name = "mail";
const dependsOn: readonly string[] = ["web-platform"];

// Phase-2 IIFE: capture `$mail/send` into a locked `__mail` global with a
// frozen inner `{send}`, so tenant code cannot replace the dispatcher.
// Phase-3 deletes the raw `$mail/send` binding (public !== true).
function guest(): void {
	type SendFn = (opts: unknown) => Promise<unknown>;
	const g = globalThis as unknown as Record<string, unknown>;
	const raw = g[MAIL_DISPATCHER_NAME] as SendFn;
	const mail = Object.freeze({
		send: (opts: unknown) => raw(opts),
	});
	Object.defineProperty(globalThis, "__mail", {
		value: mail,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

export type {
	MailAttachmentWire,
	MailErrorKind,
	MailOptsWire,
	MailResultWire,
	Recipient,
	SmtpConfigWire,
} from "./types.js";
// biome-ignore lint/performance/noBarrelFile: the `?sandbox-plugin` vite transform discovers `worker` through this file's re-export; the guest pass DCEs worker.ts so the re-export costs nothing at runtime
export { worker } from "./worker.js";
export { dependsOn, guest, MAIL_DISPATCHER_NAME, name };
