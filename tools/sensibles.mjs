/**
 * Look for anything private in this repository: current files and the whole git
 * history, because a secret deleted in a later commit still lives in the earlier
 * one.
 *
 * Usage: node tools/sensibles.mjs
 *
 * It exits non-zero when something private turns up, so it can be wired into a
 * pre-push habit without reading the output every time.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** This file names the patterns it looks for, so it has to skip itself. */
const SELF = 'tools/sensibles.mjs';

/**
 * What counts as private. Split so this file does not contain the literal forms
 * it hunts for.
 * @returns the list of rules.
 */
function rules() {
	return [
		{ name: 'private key', pattern: new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----') },
		{ name: 'GitHub token', pattern: new RegExp('\\bgh[pousr]_[A-Za-z0-9]{30,}') },
		{ name: 'GitHub fine-grained token', pattern: new RegExp('\\bgithub_pat_[A-Za-z0-9_]{40,}') },
		{ name: 'AWS key', pattern: new RegExp('\\b(?:AKIA|ASIA)[0-9A-Z]{16}') },
		{ name: 'provider key', pattern: new RegExp('\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}') },
		{ name: 'Slack token', pattern: new RegExp('\\bxox[baprs]-[A-Za-z0-9-]{10,}') },
		{ name: 'SSH public key', pattern: new RegExp('ssh-(?:rsa|ed25519|dss) AAAA') },
		{ name: 'email address', pattern: new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}') },
		{ name: 'Windows user path', pattern: new RegExp('C:\\\\+Users\\\\+[A-Za-z0-9_.-]+') },
		{ name: 'POSIX home path', pattern: new RegExp('/home/[a-z0-9_-]+/') },
		{ name: 'LAN address', pattern: new RegExp('\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b') },
	];
}

/** Run git and return its stdout. */
function git(args) {
	return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

const found = [];

/** Scan the files as they are committed now. */
function scanWorkingTree() {
	const files = git(['ls-files']).split('\n').filter((name) => name !== '' && name !== SELF);
	for (const name of files) {
		let text;
		try {
			text = readFileSync(join(ROOT, name), 'utf8');
		} catch {
			continue;
		}
		const lines = text.split('\n');
		for (let index = 0; index < lines.length; index += 1) {
			for (const rule of rules()) {
				if (rule.pattern.test(lines[index])) {
					found.push({ where: `${name}:${index + 1}`, rule: rule.name, line: lines[index].trim().slice(0, 120) });
				}
			}
		}
	}
}

/** Scan every commit ever written, not just the current tree. */
function scanHistory() {
	const log = git(['log', '--all', '--format=@@@%H %s', '-p']);
	let commit = '?';
	for (const line of log.split('\n')) {
		if (line.startsWith('@@@')) {
			commit = line.slice(4);
			continue;
		}
		if (line.startsWith('+') === false) continue;
		for (const rule of rules()) {
			if (rule.pattern.test(line)) {
				found.push({ where: `commit ${commit.slice(0, 40)}`, rule: rule.name, line: line.slice(1).trim().slice(0, 120) });
			}
		}
	}
}

/** Who the commits say wrote them: that is public too. */
function authors() {
	const emails = new Set();
	const names = new Set();
	for (const line of git(['log', '--all', '--format=%an <%ae>']).split('\n')) {
		const match = /^(.*) <(.*)>$/.exec(line);
		if (match === null) continue;
		names.add(match[1]);
		emails.add(match[2]);
	}
	return { names: [...names], emails: [...emails] };
}

scanWorkingTree();
scanHistory();
const who = authors();

console.log('Audit of the published repository\n');
console.log(`commits checked : ${git(['rev-list', '--all', '--count']).trim()}`);
console.log(`authors          : ${who.names.join(', ')}`);
console.log(`author emails    : ${who.emails.join(', ')}`);
console.log('');

if (found.length === 0) {
	console.log('No secret, token, key, path or address was found, in the files or in the history.');
	console.log('The author name and email above are public: that is how git works, and it is a choice, not a leak.');
	process.exit(0);
}

const byRule = new Map();
for (const hit of found) {
	if (!byRule.has(hit.rule)) byRule.set(hit.rule, []);
	byRule.get(hit.rule).push(hit);
}
for (const [rule, hits] of byRule) {
	console.log(`${rule}: ${hits.length}`);
	for (const hit of hits.slice(0, 8)) console.log(`  ${hit.where}  ${hit.line}`);
	if (hits.length > 8) console.log(`  … and ${hits.length - 8} more`);
}
console.log('\nAnything under "email address" is worth a look: an email in a public repository is public for good.');
process.exit(1);
