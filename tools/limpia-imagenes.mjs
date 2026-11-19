/**
 * Remove every optional chunk from a PNG, so an image carries nothing but the
 * pixels it needs to be drawn.
 *
 * A PNG is a signature followed by chunks. Only five of them are needed to render
 * a still image: `IHDR` (size and format), `PLTE` and `tRNS` (palette, when the
 * image uses one), `IDAT` (the pixels) and `IEND`. Everything else is optional and
 * is where descriptive data hides: `tEXt`, `zTXt` and `iTXt` (free text: software,
 * comments, sometimes a path or a user name), `eXIf` (camera and location data),
 * `tIME` (a timestamp) and `pHYs` (physical resolution).
 *
 * Usage:
 *   node tools/limpia-imagenes.mjs <file.png> [more.png ...]
 *   node tools/limpia-imagenes.mjs --list <file.png>    (only report, change nothing)
 *
 * It rewrites the file in place and prints what it found and what it kept. A PNG
 * without a signature is refused rather than damaged.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks that carry pixels or the format of them. Nothing else survives. */
const NEEDED = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/**
 * Read the chunk list of a PNG without decoding it.
 * @param buffer - the whole file.
 * @returns the chunks, in order, with their raw bytes.
 */
function readChunks(buffer) {
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG: the signature is missing');
	const chunks = [];
	let offset = 8;
	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
		const end = offset + 8 + length + 4;
		if (end > buffer.length) throw new Error(`truncated chunk ${type}`);
		chunks.push({ type, raw: buffer.subarray(offset, end) });
		offset = end;
		if (type === 'IEND') break;
	}
	return chunks;
}

/**
 * Describe one chunk in a way a person can read.
 * @param chunk - one chunk read from the file.
 * @returns the text written inside it, or a short note.
 */
function describe(chunk) {
	// The payload starts after the 8 header bytes and before the 4 CRC bytes.
	const data = chunk.raw.subarray(8, chunk.raw.length - 4);
	if (chunk.type === 'tEXt') {
		const text = data.toString('latin1');
		const split = text.indexOf('\u0000');
		const key = split === -1 ? text : text.slice(0, split);
		const value = split === -1 ? '' : text.slice(split + 1);
		return `${key} = ${value.slice(0, 80)}`;
	}
	if (chunk.type === 'iTXt' || chunk.type === 'zTXt') return `${data.length} bytes of text`;
	if (chunk.type === 'eXIf') return `${data.length} bytes of Exif metadata`;
	if (chunk.type === 'tIME') return 'a timestamp';
	if (chunk.type === 'pHYs') return 'physical resolution';
	return '';
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const files = args.filter((value) => value !== '--list');
if (files.length === 0) {
	console.error('usage: node tools/limpia-imagenes.mjs [--list] <file.png> [...]');
	process.exit(2);
}

let removedTotal = 0;
for (const file of files) {
	const before = readFileSync(file);
	let chunks;
	try {
		chunks = readChunks(before);
	} catch (error) {
		console.error(`${file}: ${error.message}`);
		process.exitCode = 1;
		continue;
	}
	const extra = chunks.filter((chunk) => !NEEDED.has(chunk.type));
	console.log(`\n${file} (${before.length} bytes)`);
	console.log(`  chunks: ${chunks.map((chunk) => chunk.type).join(', ')}`);
	if (extra.length === 0) {
		console.log('  nothing to remove: it already carries only what it needs');
	} else {
		const verb = listOnly ? 'would remove' : 'removing';
		for (const chunk of extra) console.log(`  ${verb} ${chunk.type}${describe(chunk) === '' ? '' : ' — ' + describe(chunk)}`);
	}
	if (listOnly || extra.length === 0) continue;
	const kept = chunks.filter((chunk) => NEEDED.has(chunk.type));
	const clean = Buffer.concat([SIGNATURE, ...kept.map((chunk) => chunk.raw)]);
	try {
		writeFileSync(file, clean);
	} catch (error) {
		// A file copied from a read-only folder keeps that attribute, and the write
		// then fails with a bare EPERM that says nothing useful.
		console.error(`  could not write ${file}: ${error.code === 'EPERM' ? 'the file is read-only, clear the attribute first' : error.message}`);
		process.exitCode = 1;
		continue;
	}
	removedTotal += extra.length;
	console.log(`  written: ${clean.length} bytes, chunks: ${kept.map((chunk) => chunk.type).join(', ')}`);
}

if (!listOnly) {
	console.log(`\n${removedTotal} optional chunk(s) removed.`);
	if (removedTotal === 0) console.log('The images were already clean.');
}
