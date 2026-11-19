/**
 * Host half of the read-aloud feature: a small loopback speech service.
 *
 * One voice and only one: the Edge neural voice configured in the profile
 * (`es-MX-JorgeNeural`). There is no fallback voice of any kind — if that voice
 * cannot answer, the request fails and the client says so. A substitute voice
 * is worse than silence.
 *
 * Endpoints (on its own loopback port and, when the composition has one, under
 * the GUI's `/dsh-tts` prefix):
 *
 *   GET  /health                          → engine settings for the client
 *   GET  /tts?text=…&lang=es              → audio/mpeg
 *   POST /tts  {"text":…,"lang":"es"}     → the same, for texts past URL limits
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { createEdgeEngine, listVoices } from './edge.js';
import { FALLBACK, detectLocale, languageOf, pickMaleVoice } from './voices.js';

/** Ports tried in order; the first free one wins. */
const PORT_CANDIDATES = [37625, 37626, 37627, 37628, 37629, 37630];
/** Piece length used when splitting text: small pieces keep the first sound fast. */
const PIECE_CHARS = 160;
/** Keep recently spoken audio in memory: re-reading a message is then instant. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** @type {Map<string, {buffer: Buffer, contentType: string}>} */
const cache = new Map();
let cachedBytes = 0;

/** Defaults, overridable from the profile row's `config`. */
const DEFAULTS = {
	voice: 'auto',
	language: '',
	prosodyRate: '+25%',
	pitch: '+0Hz',
	volume: '+0%',
	segmentChars: 220,
	rate: 1,
	ports: PORT_CANDIDATES,
	statusFile: join(homedir(), '.dsh', 'dsh-tts-status.jsonl'),
	// Where a choice made from the chat is remembered: it has to survive a restart.
	choiceFile: join(homedir(), '.dsh', 'read-aloud.json'),
	// Force a locale instead of reading the machine's: empty means read it.
	locale: '',
	// Last resort when the catalogue cannot be reached and the language is unknown.
	fallbackVoice: 'es-MX-JorgeNeural',
};

/** Split text into speakable pieces at sentence boundaries, then hard-wrap. */
function splitForSynthesis(text, max = PIECE_CHARS) {
	const limit = Number.isFinite(max) && max > 40 ? Math.floor(max) : PIECE_CHARS;
	const pieces = String(text ?? '')
		.split(/(?<=[.!?;:])\s+|\n+/)
		.map((piece) => piece.trim())
		.filter((piece) => piece !== '');
	const chunks = [];
	let current = '';
	for (const piece of pieces) {
		if (current === '') current = piece;
		else if (current.length + 1 + piece.length <= limit) current += ` ${piece}`;
		else {
			chunks.push(current);
			current = piece;
		}
		while (current.length > limit) {
			chunks.push(current.slice(0, limit));
			current = current.slice(limit);
		}
	}
	if (current !== '') chunks.push(current);
	return chunks;
}

/** Remember audio, dropping the oldest entries to stay under the ceiling. */
function remember(key, value) {
	cache.set(key, value);
	cachedBytes += value.buffer.length;
	while (cachedBytes > CACHE_MAX_BYTES && cache.size > 1) {
		const oldest = cache.keys().next().value;
		const dropped = cache.get(oldest);
		cache.delete(oldest);
		cachedBytes -= dropped?.buffer.length ?? 0;
	}
}

/** Status log shared with the other speech plugins, for diagnostics. */
function createLog(statusFile) {
	return (event, extra = {}) => {
		if (statusFile === null) return;
		try {
			mkdirSync(dirname(statusFile), { recursive: true });
			appendFileSync(statusFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`, 'utf8');
		} catch {
			/* diagnostics must never break speech */
		}
	};
}

/** A line this short is not a header worth removing: it may be a page number. */
const HEADER_MIN_CHARS = 8;

/** Normalise one page's raw text into trimmed lines without soft hyphens. */
function tidyLines(text) {
	return String(text ?? '')
		.normalize('NFC')
		.replace(/\u00ad/g, '')
		.replace(/\u00a0/g, ' ')
		.replace(/\uf0b7/g, '-')
		.split('\n')
		.map((line) => line.replace(/[•●▪◦‣]/gu, ' ').replace(/[ \t]+/g, ' ').trim())
		// A bullet is a pause, not a word: reading «guion dos gigabytes» is noise.
		.map((line) => line.replace(/^[-*–—+]\s+/u, ''));
}

/**
* Turn the extracted pages into speakable prose: drop running headers and
* footers that repeat on page after page, undo the hyphenation PDFs add at the
* right margin, and join the hard-wrapped lines back into sentences. A reader
* that spells out «Intro- ducción» or repeats the course name on every page is
* worse than silence.
* @param pages - one string per page, in reading order.
* @returns the speakable text.
*/
function pagesToSpeech(pages) {
	const perPage = pages.map(tidyLines);
	const seen = new Map();
	for (const lines of perPage) {
		const unicas = new Set(lines.filter((line) => line.length >= HEADER_MIN_CHARS));
		for (const line of unicas) seen.set(line, (seen.get(line) ?? 0) + 1);
	}
	const umbral = Math.max(3, Math.ceil(perPage.length * 0.5));
	const ruido = new Set([...seen.entries()].filter(([, veces]) => veces >= umbral).map(([line]) => line));
	const sinRuido = perPage.map((lines) => lines.filter((line) => line !== '' && !ruido.has(line)).join('\n'));
	const totalLineas = perPage.reduce((suma, lines) => suma + lines.filter((line) => line !== '').length, 0);
	const restanteLineas = sinRuido.reduce((suma, text) => suma + text.split('\n').filter((line) => line !== '').length, 0);
	// A PDF made of identical pages would lose everything to this filter: if the
	// "noise" is most of the document, it is not noise, it is the document.
	const limpias = totalLineas > 0 && restanteLineas < totalLineas * 0.5 ? perPage.map((lines) => lines.filter((line) => line !== '').join('\n')) : sinRuido;
	return limpias
		.join('\n\n')
		.replace(/([\p{Ll}])-\n+([\p{Ll}])/gu, '$1$2')
		.replace(/\n+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
* Read the text layer of a PDF with the same engine (pdf.js) the document
* preview already uses. Scanned PDFs have no text layer: the result is then an
* empty string, which the caller reports as such instead of reading nothing.
* @param buffer - the whole PDF file.
* @returns the page count and the speakable text.
*/
async function extractPdfText(buffer) {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const document = await pdfjs.getDocument({
		data: new Uint8Array(buffer),
		useSystemFonts: false,
		useWorkerFetch: false,
		isEvalSupported: false,
		disableFontFace: true,
		verbosity: 0,
	}).promise;
	const pages = [];
	for (let number = 1; number <= document.numPages; number += 1) {
		const page = await document.getPage(number);
		const content = await page.getTextContent();
		let line = '';
		for (const item of content.items) {
			if (typeof item.str !== 'string') continue;
			line += item.str;
			if (item.hasEOL === true) line += '\n';
		}
		pages.push(line);
		page.cleanup();
	}
	const caracteres = pages.reduce((suma, page) => suma + page.length, 0);
	const total = document.numPages;
	await document.destroy();
	if (caracteres === 0) return { pages: total, text: '' };
	return { pages: total, text: pagesToSpeech(pages) };
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'content-type',
	'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
	'Access-Control-Max-Age': '600',
};

function sendJson(response, status, value) {
	const body = Buffer.from(JSON.stringify(value), 'utf8');
	response.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
	response.end(body);
}

function readBody(request, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		const parts = [];
		let size = 0;
		request.on('data', (piece) => {
			size += piece.length;
			if (size > limit) {
				reject(new Error('body too large'));
				request.destroy();
				return;
			}
			parts.push(piece);
		});
		request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
		request.on('error', reject);
	});
}

/**
 * Build the route handler serving both transports.
 * @param options - resolved settings, the Edge engine, the status log, and the port list.
 * @returns an HTTP handler.
 */
function createTtsHandler(options) {
	const log = options.log;
	const settings = options.settings;

	/** Cache key: the voice and its delivery are part of the identity of the audio. */
	// The live voice and rate go into the key. Without them, changing the voice and
	// replaying the same message returns the previous voice from the cache.
	const keyFor = (text, forcedVoice) =>
		createHash('sha256')
			.update(
				`edge\u0000${forcedVoice ?? options.currentVoice?.() ?? settings.voice}\u0000${settings.language}\u0000${options.currentRate?.() ?? settings.prosodyRate}\u0000${settings.pitch}\u0000${text}`,
			)
			.digest('hex');

	/**
	* Answer one request with audio from the configured voice, streamed as it is
	* generated. A failure before the first frame becomes an error response: the
	* client shows it and stays silent, because there is no substitute voice.
	* @param response - the HTTP response to write.
	* @param text - text to speak.
	*/
	const respondWithAudio = async (response, text, forcedVoice, forcedRate) => {
		const started = Date.now();
		// Resolve the voice first: the cache key depends on it, and /health should report
		// the voice that will actually speak rather than the word "auto".
		await options.engine();
		const liveVoice = options.currentVoice();
		const requestVoice = typeof forcedVoice === 'string' && forcedVoice !== '' ? forcedVoice : undefined;
		const key = keyFor(text, requestVoice);
		const cached = cache.get(key);
		if (cached !== undefined) {
			log('synthesize', { chars: text.length, engine: 'edge', voice: options.currentVoice(), cached: true, ms: 0 });
			response.writeHead(200, {
				...CORS,
				'Content-Type': cached.contentType,
				'Content-Length': cached.buffer.length,
				'X-Tts-Engine': 'edge',
				'Cache-Control': 'no-store',
			});
			response.end(cached.buffer);
			return;
		}
		const chunks = [];
		let headersSent = false;
		try {
			const engineNow = requestVoice === undefined ? await options.engine() : options.engineFor(requestVoice, forcedRate ?? undefined);
			await engineNow.synthesizeStream(text, (chunk) => {
				if (!headersSent) {
					response.writeHead(200, { ...CORS, 'Content-Type': 'audio/mpeg', 'X-Tts-Engine': 'edge', 'Cache-Control': 'no-store' });
					headersSent = true;
				}
				chunks.push(chunk);
				response.write(chunk);
			});
			if (!headersSent) throw new Error('edge returned no audio');
			const buffer = Buffer.concat(chunks);
			response.end();
			remember(key, { buffer, contentType: 'audio/mpeg' });
			log('synthesize', { chars: text.length, engine: 'edge', voice: requestVoice ?? liveVoice, cached: false, ms: Date.now() - started, bytes: buffer.length });
		} catch (error) {
			log('edge-error', { message: error?.message ?? String(error) });
			if (headersSent) {
				try {
					response.end();
				} catch {
					/* the client is gone */
				}
				return;
			}
			throw error;
		}
	};

	/** Suffixes this service will read aloud from the document preview. */
	const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf']);
	/** Refuse absurdly large files instead of chewing through them. */
	const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
	/** A PDF carries its own weight: allow it more room than a plain text file. */
	const PDF_MAX_BYTES = 64 * 1024 * 1024;

	/**
	* Hand the plain text of a document over to the client, which speaks it with the
	* same voice and the same playback machinery as a chat answer.
	* @param response - the HTTP response to write.
	* @param target - absolute path of the file open in the preview.
	*/
	const respondWithDocument = async (response, target) => {
		if (target.trim() === '') {
			sendJson(response, 400, { error: 'path is required' });
			return;
		}
		const suffix = extname(target).toLowerCase();
		if (!DOCUMENT_EXTENSIONS.has(suffix)) {
			sendJson(response, 415, { error: 'only .md, .markdown, .txt and .pdf can be read aloud' });
			return;
		}
		const esPdf = suffix === '.pdf';
		let info;
		try {
			info = await stat(target);
		} catch {
			sendJson(response, 404, { error: 'file not found' });
			return;
		}
		if (!info.isFile()) {
			sendJson(response, 404, { error: 'file not found' });
			return;
		}
		if (info.size > (esPdf ? PDF_MAX_BYTES : DOCUMENT_MAX_BYTES)) {
			sendJson(response, 413, { error: 'file is too large to read aloud' });
			return;
		}
		if (!esPdf) {
			const text = await readFile(target, 'utf8');
			sendJson(response, 200, { path: target, text });
			return;
		}
		const extraido = await extractPdfText(await readFile(target));
		// A scanned PDF has pages but no text layer: say so, never read silence.
		if (extraido.text === '') {
			sendJson(response, 422, {
				error: 'this PDF is a scan without a text layer: it needs OCR before it can be read aloud',
				pages: extraido.pages,
			});
			return;
		}
		log('document-pdf', { pages: extraido.pages, chars: extraido.text.length });
		sendJson(response, 200, { path: target, text: extraido.text, pages: extraido.pages });
	};

	return async function handle(request, response) {
		try {
			if (request.method === 'OPTIONS') {
				response.writeHead(204, CORS);
				response.end();
				return;
			}
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const path = url.pathname;
			if (path.endsWith('/document')) {
				await respondWithDocument(response, url.searchParams.get('path') ?? '');
				return;
			}
			if (path.endsWith('/health')) {
				sendJson(response, 200, {
					ok: true,
					service: 'dsh-read-aloud',
					engine: 'edge',
					voice: options.currentVoice(),
					language: settings.language || 'auto',
					detected: detectLocale({ locale: settings.locale }),
					prosodyRate: options.currentRate(),
					configured: options.currentChoice?.() !== 'auto',
					segmentChars: settings.segmentChars,
					rate: settings.rate,
					documents: ['.md', '.markdown', '.txt', '.pdf'],
					ports: options.ports ?? [],
				});
				return;
			}
			if (!path.endsWith('/tts')) {
				sendJson(response, 404, { error: 'not found' });
				return;
			}

			let text;
			if (request.method === 'POST') {
				const raw = await readBody(request);
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					sendJson(response, 400, { error: 'body must be JSON' });
					return;
				}
				text = typeof parsed?.text === 'string' ? parsed.text : '';
			} else {
				text = url.searchParams.get('text') ?? '';
			}

			if (text.trim() === '') {
				sendJson(response, 400, { error: 'text is required' });
				return;
			}

			await respondWithAudio(response, text, url.searchParams.get('voice') ?? undefined, url.searchParams.get('rate') ?? undefined);
		} catch (error) {
			log('error', { message: error?.message ?? String(error) });
			try {
				if (response.headersSent) response.end();
				else sendJson(response, 502, { error: error?.message ?? 'synthesis failed' });
			} catch {
				/* the client is gone */
			}
		}
	};
}

/**
 * Cordis plugin body: expose the TTS service on loopback and, when the
 * composition has one, under the GUI's own origin as well.
 * @param ctx - host context.
 * @param config - overrides for {@link DEFAULTS} (`voice`, `language`, `prosodyRate`, …).
 */
function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config ?? {}) };
	const log = createLog(settings.statusFile === 'none' ? null : settings.statusFile);
	const ports = [];
	// The reader's saved choice wins over the profile, so a change made from the chat
	// survives a restart even when the profile pins a voice.
	const readChoice = (file) => {
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf8'));
			return parsed !== null && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	};
	const writeChoice = (file, value) => {
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
		} catch (error) {
			log('choice-write-failed', { message: error?.message ?? String(error) });
		}
	};

	const saved = readChoice(settings.choiceFile);
	let voiceChoice = typeof saved.voice === 'string' && saved.voice !== '' ? saved.voice : settings.voice;
	let voice = voiceChoice;
	let prosodyRate = typeof saved.prosodyRate === 'string' && saved.prosodyRate !== '' ? saved.prosodyRate : settings.prosodyRate;
	let engine = null;

	/**
	 * The SSML language of one voice: the first two segments of its name.
	 * @param name - a voice like "es-MX-JorgeNeural".
	 * @returns "es-MX", or the configured language.
	 */
	const localeOfVoice = (name) => {
		const parts = String(name ?? '').split('-');
		return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : settings.language;
	};

	/**
	 * Build the engine for one voice.
	 * @param chosen - the voice name.
	 * @returns the engine.
	 */
	const engineFor = (chosen, rateOverride) =>
		createEdgeEngine({
			voice: chosen,
			language: settings.language || localeOfVoice(chosen),
			prosodyRate: rateOverride ?? prosodyRate,
			pitch: settings.pitch,
			volume: settings.volume,
			log,
		});

	/**
	 * The voice in force, resolved on first use when it is "auto": the reader's own
	 * language, a male voice, taken from the live catalogue.
	 * @returns the voice name.
	 */
	const resolveVoice = async () => {
		if (voiceChoice !== 'auto') {
			voice = voiceChoice;
			return voice;
		}
		const locale = detectLocale({ locale: settings.locale });
		const language = languageOf(locale) || languageOf(settings.language) || 'en';
		try {
			const voices = await listVoices(log);
			const picked = pickMaleVoice(voices, language, locale);
			if (picked !== null) {
				voice = picked;
				log('voice-auto', { locale, language, voice });
				return voice;
			}
		} catch (error) {
			log('voice-auto-failed', { message: error?.message ?? String(error) });
		}
		voice = FALLBACK[language] ?? settings.fallbackVoice;
		log('voice-auto-fallback', { language, voice });
		return voice;
	};

	/**
	 * The engine for the voice in force, built once.
	 * @returns the engine.
	 */
	const currentEngine = async () => {
		await resolveVoice();
		if (engine === null) engine = engineFor(voice);
		return engine;
	};

	/**
	 * Change the voice and the rate while running, and remember the choice.
	 * @param change - voice and prosodyRate, either or both.
	 * @returns the settings now in force.
	 */
	const configure = async (change) => {
		if (typeof change?.voice === 'string' && change.voice !== '') {
			voiceChoice = change.voice;
			voice = change.voice;
			engine = null;
		}
		if (typeof change?.prosodyRate === 'string' && change.prosodyRate !== '') prosodyRate = change.prosodyRate;
		await resolveVoice();
		if (engine === null) engine = engineFor(voice);
		// Remember what was chosen, not what it resolved to: "auto" has to keep following
		// the machine if the reader only asked to change the speed.
		writeChoice(settings.choiceFile, { voice: voiceChoice, prosodyRate });
		log('configured', { choice: voiceChoice, voice, prosodyRate });
		return { voice, prosodyRate };
	};

	const handler = createTtsHandler({
		settings,
		log,
		ports,
		engine: currentEngine,
		engineFor,
		currentVoice: () => voice,
		currentChoice: () => voiceChoice,
		currentRate: () => prosodyRate,
		configure,
	});

	/**
	 * A sentence per language, so every voice in the test page reads something in its
	 * own tongue instead of mangling an English sentence.
	 */
	const SAMPLES = {
		es: 'Hola, esta es una muestra corta de mi voz. Asi suena cuando te leo.',
		en: 'Hello, this is a short sample of my voice. This is how I sound when I read to you.',
		fr: 'Bonjour, ceci est un court echantillon de ma voix. Voici comment je lis.',
		de: 'Hallo, das ist eine kurze Probe meiner Stimme. So klinge ich beim Vorlesen.',
		it: 'Ciao, questo e un breve esempio della mia voce. Ecco come suono quando leggo.',
		pt: 'Ola, esta e uma pequena amostra da minha voz. Assim eu soo quando leio.',
		ru: 'Privet, eto korotkiy obrazets moego golosa. Tak ya zvuchu, kogda chitayu.',
		ja: 'こんにちは。これは私の声の短いサンプルです。読み上げるときはこんな声です。',
		ko: '안녕하세요. 제 목소리의 짧은 샘플입니다. 읽어 줄 때는 이렇게 들립니다.',
		zh: '你好，这是我声音的简短示例。我朗读时就是这个声音。',
		ar: 'مرحبا، هذه عينة قصيرة من صوتي. هكذا أبدو عندما أقرأ لك.',
		hi: 'नमस्ते, यह मेरी आवाज़ का छोटा नमूना है। पढ़ते समय मैं ऐसी सुनाई देती हूँ।',
		nl: 'Hallo, dit is een korte proef van mijn stem. Zo klink ik als ik voorlees.',
		pl: 'Czesc, to jest krotka probka mojego glosu. Tak brzmie, gdy czytam.',
		tr: 'Merhaba, bu sesimin kisa bir ornegi. Okurken boyle duyuluyorum.',
		sv: 'Hej, det har ar ett kort prov pa min rost. Sa har later jag nar jag laser.',
		da: 'Hej, dette er en kort prove pa min stemme. Sa dan lyder jeg, nar jeg laeser.',
		el: 'Γεια σου, αυτό είναι ένα σύντομο δείγμα της φωνής μου.',
		he: 'שלום, זו דוגמה קצרה של הקול שלי.',
		cs: 'Ahoj, toto je kratka ukazka meho hlasu.',
		ro: 'Buna, aceasta este o mostra scurta a vocii mele.',
		hu: 'Szia, ez a hangom rovid mintaja.',
		fi: 'Hei, tassa on lyhyt nayte aantestani.',
		nb: 'Hei, dette er en kort prove pa stemmen min.',
		uk: 'Pryvit, tse korotkyi zrazok moho holosu.',
		vi: 'Xin chao, day la mot mau ngan cua giong noi cua toi.',
		th: 'สวัสดี นี่คือตัวอย่างเสียงของฉัน',
		id: 'Halo, ini contoh singkat suara saya.',
		sk: 'Ahoj, toto je kratka ukazka mojho hlasu.',
		bg: 'Здравей, това е кратък пример от гласа ми.',
		hr: 'Bok, ovo je kratak primjer mog glasa.',
		ca: 'Hola, aquesta es una mostra curta de la meva veu.',
	};

	/**
	 * The sentence a voice reads in its own language.
	 * @param locale - the voice locale, like "es-MX".
	 * @returns the sample text.
	 */
	const sampleFor = (locale) => SAMPLES[languageOf(locale)] ?? SAMPLES.en;

	/**
	 * Normalise a speed the reader typed into a prosody rate.
	 * Accepts "1.25x", "1,5x", "1.25", "+25%", "-10%".
	 * @param value - what the reader said.
	 * @returns the rate, or null when it cannot be understood.
	 */
	const normaliseRate = (value) => {
		if (typeof value !== 'string') return null;
		const text = value.trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
		if (text === '') return null;
		const percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(text);
		if (percent !== null) {
			const value2 = Math.round(Number(percent[1]));
			return `${value2 >= 0 ? '+' : ''}${value2}%`;
		}
		const factor = /^(\d+(?:\.\d+)?)x?$/.exec(text);
		if (factor === null) return null;
		const value3 = Math.round((Number(factor[1]) - 1) * 100);
		return `${value3 >= 0 ? '+' : ''}${value3}%`;
	};

	/**
	 * Write a page with a button per voice, so the reader hears them before choosing.
	 * @param voices - the voices to include.
	 * @param language - the language being offered.
	 * @returns the file path.
	 */
	const writeSamplesPage = async (voices, language) => {
		const port = ports[0];
		const rows = voices
			.map((voice) => {
				const marks = [voice.locale, voice.gender === 'Male' ? 'male' : 'female'];
				if (voice.default === true) marks.push('default');
				if (voice.active === true) marks.push('in use');
				const text = sampleFor(voice.locale);
				const url = `http://127.0.0.1:${port}/tts?voice=${encodeURIComponent(voice.name)}&text=${encodeURIComponent(text)}`;
				return `    <li><button data-src="${url}">${voice.name}</button> <span>${marks.join(' · ')}</span> <progress max="1" value="0"></progress></li>`;
			})
			.join('\n');
		const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Read aloud voices</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;margin:32px;max-width:900px}
  h1{font-size:20px;margin-bottom:4px}
  p.hint{color:#666;margin-top:0}
  ul{list-style:none;padding:0}
  li{display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid #eee}
  button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #bbb;background:#f6f6f6;cursor:pointer;min-width:290px;text-align:left}
  button:hover{background:#ececec}
  span{color:#666;font-size:13px}
  progress{width:120px;height:6px}
</style>
<h1>Read aloud voices</h1>
<p class="hint">Language offered: ${language}. Click a voice to hear a short sample in its own language. Close the page when you have chosen.</p>
<ul>
${rows}
</ul>
<script>
for (const button of document.querySelectorAll('button[data-src]')) {
  button.addEventListener('click', () => {
    const item = button.closest('li');
    const bar = item.querySelector('progress');
    let audio = item.querySelector('audio');
    if (audio === null) {
      audio = new Audio();
      audio.addEventListener('timeupdate', () => { if (audio.duration > 0) bar.value = audio.currentTime / audio.duration; });
      audio.addEventListener('ended', () => { bar.value = 0; });
      item.appendChild(audio);
    }
    audio.src = button.dataset.src;
    audio.play();
  });
}
</script>
</html>
`;
		const target = settings.choiceFile.replace(/\.json$/, '') + '-voices.html';
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, html, 'utf8');
		return target;
	};

	/**
	 * The tool the agent calls when the reader asks about voices or speed.
	 */
	const configTool = {
		name: 'read_aloud_config',
		description:
			'Configure the read-aloud voice and speed. Use action "list" to show the voices available in the reader\'s language with the default marked, action "set" to change the voice or the speed, and action "samples" to write an HTML page with a short sample of every voice so the reader can choose by listening.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'set', 'samples'], description: 'What to do. Defaults to list.' },
				voice: { type: 'string', description: 'Exact voice name, e.g. es-MX-JorgeNeural, or "auto" to detect the language again.' },
				rate: { type: 'string', description: 'Speed, e.g. "1.25x", "1.5x", "+25%", "-10%".' },
				gender: { type: 'string', enum: ['male', 'female', 'all'], description: 'Which voices to list. Defaults to male, which is the plugin default.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			const action = typeof args?.action === 'string' ? args.action : 'list';
			const locale = detectLocale({ locale: settings.locale });
			const language = languageOf(locale) || languageOf(settings.language) || 'en';
			let voices;
			try {
				voices = await listVoices(log);
			} catch (error) {
				return { text: `The voice catalogue could not be reached: ${error?.message ?? String(error)}. The plugin keeps working with ${voice === 'auto' ? settings.fallbackVoice : voice}.` };
			}
			await resolveVoice();
			const wanted = typeof args?.gender === 'string' ? args.gender : 'male';
			const sameLanguage = voices.filter((entry) => languageOf(entry.locale) === language);
			const wantedGender = wanted === 'all' ? sameLanguage : sameLanguage.filter((entry) => (wanted === 'female' ? entry.gender === 'Female' : entry.gender === 'Male'));
			const fallbackVoice = pickMaleVoice(voices, language, locale);
			const withMarks = wantedGender
				.map((entry) => ({ ...entry, default: entry.name === fallbackVoice, active: entry.name === voice }))
				.sort((left, right) => (left.default === right.default ? left.name.localeCompare(right.name) : left.default ? -1 : 1));

			if (action === 'set') {
				const change = {};
				if (typeof args?.voice === 'string' && args.voice.trim() !== '') {
					const requested = args.voice.trim();
					if (requested.toLowerCase() === 'auto') change.voice = 'auto';
					else {
						const match = voices.find((entry) => entry.name.toLowerCase() === requested.toLowerCase());
						if (match === undefined) {
							const near = voices.filter((entry) => entry.name.toLowerCase().includes(requested.toLowerCase())).slice(0, 5);
							return { text: `There is no voice called "${requested}".${near.length === 0 ? '' : ` Closest: ${near.map((entry) => entry.name).join(', ')}.`} Ask for the list to see them all.` };
						}
						change.voice = match.name;
					}
				}
				if (args?.rate !== undefined) {
					const rate = normaliseRate(args.rate);
					if (rate === null) return { text: `I cannot read "${args.rate}" as a speed. Use something like 1.25x, 1.5x or +25%.` };
					change.prosodyRate = rate;
				}
				if (Object.keys(change).length === 0) return { text: 'Nothing to change: give a voice, a speed, or both.' };
				const now = await configure(change);
				const speed = normaliseRate(now.prosodyRate);
				const factor = speed === null ? now.prosodyRate : `${1 + Number(speed.replace('%', '')) / 100}x`;
				return { text: `Done. Voice: ${now.voice}. Speed: ${factor} (${now.prosodyRate}). It stays that way after a restart.` };
			}

			if (action === 'samples') {
				const pool = wantedGender.length > 0 ? wantedGender : sameLanguage;
				if (pool.length === 0) return { text: `No ${wanted} voices exist for ${language}.` };
				try {
					const path = await writeSamplesPage(
						pool.map((entry) => ({ ...entry, default: entry.name === fallbackVoice, active: entry.name === voice })),
						language,
					);
					return { text: `Written: ${path}\nOpen it in a browser and click any voice to hear a short sample in its own language. ${pool.length} voices.` };
				} catch (error) {
					return { text: `The sample page could not be written: ${error?.message ?? String(error)}` };
				}
			}

			const speedNow = normaliseRate(prosodyRate);
			const factorNow = speedNow === null ? prosodyRate : `${1 + Number(speedNow.replace('%', '')) / 100}x`;
			const lines = withMarks.map((entry) => {
				const marks = [entry.locale, entry.gender === 'Male' ? 'male' : 'female'];
				if (entry.default === true) marks.push('default');
				if (entry.active === true) marks.push('in use');
				return `  ${entry.name} (${marks.join(', ')})`;
			});
			return {
				text: [
					`Language: ${language} (detected from ${locale}).`,
					`Voice in use: ${voice === 'auto' ? `auto, currently ${settings.fallbackVoice}` : voice}.`,
					`Speed in use: ${factorNow} (${prosodyRate}).`,
					`${wanted === 'all' ? 'All' : wanted} voices available: ${withMarks.length}.`,
					...lines,
					'',
					'To change something, ask for the voice by name or for a speed like 1.25x. To listen first, ask for "samples".',
				].join('\n'),
			};
		},
	};

	// The tool is optional: without `tools` in the composition, the voice and speed can
	// still be changed from the profile, and the plugin keeps reading aloud.
	try {
		ctx.inject?.(['tools'], (scope) => {
			scope.effect?.(() => scope.tools.register(configTool), 'dsh-read-aloud: configuration tool');
			log('tool-registered', { name: 'read_aloud_config' });
		});
	} catch (error) {
		log('tool-unavailable', { message: error?.message ?? String(error) });
	}

	// Same-origin path: the GUI webserver, when this composition has one.
	try {
		ctx.inject?.(['webServer'], (scope) => {
			scope.effect(() => scope.webServer.register({ kind: 'prefix', path: '/dsh-tts', handler }), 'dsh-read-aloud: /dsh-tts route');
			log('route-registered', { path: '/dsh-tts' });
		});
	} catch (error) {
		log('route-unavailable', { message: error?.message ?? String(error) });
	}

	// Loopback port: works even when the client is loaded from file://.
	const candidates = Array.isArray(settings.ports) && settings.ports.length > 0 ? settings.ports : PORT_CANDIDATES;
	const listen = (index) => {
		if (index >= candidates.length) {
			log('listen-failed', { tried: candidates });
			return;
		}
		const port = candidates[index];
		const server = createServer((request, response) => {
			handler(request, response).catch(() => {
				try {
					response.destroy();
				} catch {
					/* already gone */
				}
			});
		});
		server.on('error', () => listen(index + 1));
		server.listen(port, '127.0.0.1', () => {
			ports.push(port);
			log('listening', { port, engine: 'edge', voice: settings.voice, prosodyRate: settings.prosodyRate });
		});
	};
	listen(0);

	ctx.effect(
		() => () => {
			log('disposed');
		},
		'dsh-read-aloud: status',
	);
}

/** Cordis function-plugin name. */
const name = 'read-aloud';

export { apply };
export { name };
export { splitForSynthesis };
export { DEFAULTS };
export { extractPdfText };
export { pagesToSpeech };
export { createTtsHandler };
