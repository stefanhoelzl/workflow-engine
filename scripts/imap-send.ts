// Append a synthetic test message to the local hoodiecrow-imap dev server's
// INBOX (see scripts/imap.ts). Uses imapflow against imaps://localhost:3993
// with `rejectUnauthorized: false` because the dev cert is self-signed.
//
// Invoke: `pnpm imap:send [--subject <s>] [--from <addr>] [--body <s>]`

import { ImapFlow } from "imapflow";

interface Args {
	subject: string;
	from: string;
	body: string;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		subject: "test",
		from: "alice@example.com",
		body: "hello",
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) {
			continue;
		}
		switch (flag) {
			case "--subject":
				args.subject = value;
				i++;
				break;
			case "--from":
				args.from = value;
				i++;
				break;
			case "--body":
				args.body = value;
				i++;
				break;
			default:
				break;
		}
	}
	return args;
}

const { subject, from, body } = parseArgs(process.argv.slice(2));

const message = [
	`From: ${from}`,
	"To: dev@localhost",
	`Subject: ${subject}`,
	`Date: ${new Date().toUTCString()}`,
	"MIME-Version: 1.0",
	"Content-Type: text/plain; charset=utf-8",
	"",
	body,
	"",
].join("\r\n");

const client = new ImapFlow({
	host: "localhost",
	port: 3993,
	secure: true,
	tls: { rejectUnauthorized: false },
	auth: { user: "dev@localhost", pass: "devpass" },
	logger: false,
});

await client.connect();
try {
	const result = await client.append("INBOX", message);
	console.log(
		`Appended message to INBOX${result && typeof result === "object" && "uid" in result ? ` (uid=${String(result.uid)})` : ""}: subject=${JSON.stringify(subject)}`,
	);
} finally {
	await client.logout();
}
