import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";

interface TarFile {
	readonly name: string;
	readonly content: string | Uint8Array;
}

/**
 * Packs the given files into a single gzipped tar in memory and returns the
 * bytes. No filesystem interaction. Used by `bundle()` to produce the sealed
 * tenant tarball that `wfe upload` POSTs.
 */
async function packTarGz(files: readonly TarFile[]): Promise<Uint8Array> {
	const packer = tarPack();
	for (const file of files) {
		const content =
			typeof file.content === "string"
				? file.content
				: Buffer.from(file.content);
		packer.entry({ name: file.name }, content);
	}
	packer.finalize();

	const chunks: Buffer[] = [];
	const gzip = createGzip();
	const sink = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk as Buffer);
			cb();
		},
	});
	await pipeline(packer, gzip, sink);
	return Uint8Array.from(Buffer.concat(chunks));
}

export type { TarFile };
export { packTarGz };
