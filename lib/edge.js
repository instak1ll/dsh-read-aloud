/**
 * Edge neural engine for the read-aloud service.
 *
 * Uses the voice service behind Microsoft Edge's "Read aloud": Azure neural
 * voices over a WebSocket, with no account, key, or quota. That is the same
 * family of voices as the assistants' own speech, and it includes male Spanish
 * voices (`es-ES-AlvaroNeural`, `es-MX-JorgeNeural`, `es-AR-TomasNeural`).
 *
 * Hosts: in October 2026 Microsoft moved synthesis to `api.msedgeservices.com`
 * and started refusing the handshake on `speech.platform.bing.com` region by
 * region with a 403 (rany2/edge-tts#490). The new host takes the same client
 * token a second time as `Ocp-Apim-Subscription-Key`; the old one stays as a
 * second host for wherever it still answers. Both hosts speak the configured
 * voice, and behind them there is no other voice at all.
 *
 * The endpoint rejects handshakes that do not carry a current `Sec-MS-GEC`
 * token and the extension origin Edge uses, so both are computed here. Audio
 * arrives as MP3 frames, which are forwarded to the caller as they land: the
 * user hears the first sentence while the rest is still being synthesized.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocketImpl = require('../vendor/ws/index.js');

/** Public token Edge embeds in the read-aloud page. */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/** Edge version whose security token shape the service currently accepts. */
const CHROMIUM_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_VERSION}`;
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
/**
 * Synthesis hosts, in the order they are tried. Only a refused handshake moves
 * on to the next one: once a host has accepted and audio started, that audio is
 * the answer.
 */
const ENDPOINTS = [
	{ host: 'api.msedgeservices.com', url: 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1', subscriptionKey: true },
	{
		host: 'speech.platform.bing.com',
		url: 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
		subscriptionKey: false,
	},
];
const VOICES = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list';
/** 24 kHz mono MP3 at 48 kbps: small, streamable, and what the service emits natively. */
const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const HANDSHAKE_TIMEOUT_MS = 15000;
const STREAM_TIMEOUT_MS = 45000;
/** The catalogue, once it has been fetched. */
let voiceList = null;
/** Rounds the same voice is asked again before giving up (a 429 is a throttle, not a death). */
const ROUNDS = 3;
/** Base backoff between rounds; grows linearly so the endpoint is not hammered. */
const ROUND_DELAY_MS = 600;

/** Seconds the local clock is behind the service; the token is time-based. */
let clockSkewSeconds = 0;
let skewChecked = false;

async function refreshClockSkew(log) {
	if (skewChecked) return;
	skewChecked = true;
	try {
		const response = await fetch('https://speech.platform.bing.com/', { method: 'GET' });
		const serverDate = response.headers.get('date');
		if (serverDate !== null) {
			const skew = (new Date(serverDate).getTime() - Date.now()) / 1000;
			if (Number.isFinite(skew) && Math.abs(skew) < 3600) clockSkewSeconds = skew;
		}
		log?.('clock-skew', { seconds: Number(clockSkewSeconds.toFixed(1)) });
	} catch {
		/* local time is good enough */
	}
}

/**
 * The time-based token the handshake requires: Windows ticks rounded down to
 * five minutes, concatenated with the trusted client token, SHA-256, uppercase.
 * @returns the token value.
 */
function secMsGec() {
	const ticks = Math.floor(Date.now() / 1000 + clockSkewSeconds + 11644473600);
	const rounded = ticks - (ticks % 300);
	return createHash('sha256').update(`${rounded}0000000${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

/**
 * Handshake URL for one endpoint: the four parameters every host takes, plus the
 * client token repeated as the subscription key where the new host wants it.
 * @param endpoint - one entry of `ENDPOINTS`.
 * @returns the WebSocket URL to open.
 */
function handshakeUrl(endpoint) {
	return (
		`${endpoint.url}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}` +
		`&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${randomUUID().replace(/-/g, '')}` +
		(endpoint.subscriptionKey ? `&Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}` : '')
	);
}

const escapeXml = (value) =>
	String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Build the Edge engine.
 * @param options - `voice`, `prosodyRate`, `pitch`, `volume`, `log`.
 * @returns an engine with `describe()` and `synthesizeStream()`.
 */
function createEdgeEngine(options) {
	const log = options.log ?? (() => {});
	const voice = options.voice;
	const rate = options.prosodyRate ?? '+0%';
	const pitch = options.pitch ?? '+0Hz';
	const volume = options.volume ?? '+0%';
	// Language of the TEXT. The Multilingual voices keep their own locale unless
	// the reader is told otherwise inside <voice>, which is what makes an
	// Italian or English voice read Spanish with Spanish pronunciation.
	const language = options.language ?? 'es-ES';

	return {
		kind: 'edge',
		voice,
		language,
		describe: () => ({
			engine: 'edge',
			voice,
			language,
			rate,
			pitch,
		}),
		/**
		* Synthesize one piece of text, handing audio to the caller as it arrives.
		* Tries each host in turn, but only while nothing has been spoken yet: an
		* interrupted sentence is worse than a failed one.
		* @param text - the text to speak.
		* @param onChunk - called with each MP3 frame batch.
		* @returns the number of audio bytes delivered.
		*/
		async synthesizeStream(text, onChunk) {
			await refreshClockSkew(log);
			let delivered = false;
			let lastError = null;
			// The public endpoint refuses bursts with 429/403. There is no other voice
			// to fall back to, so the only honest move is to wait a moment and ask the
			// same voice again; three rounds is enough to ride out a short throttle.
			for (let round = 1; round <= ROUNDS; round += 1) {
				for (const endpoint of ENDPOINTS) {
					try {
						return await this.openSynthesis(endpoint, text, onChunk, () => {
							delivered = true;
						});
					} catch (error) {
						lastError = error;
						log('endpoint-error', { host: endpoint.host, round, message: error?.message ?? String(error) });
						// Half a sentence already reached the speaker: switching hosts now
						// would repeat it, so the failure is final.
						if (delivered) throw error;
					}
				}
				if (round < ROUNDS) await new Promise((resolve) => setTimeout(resolve, ROUND_DELAY_MS));
			}
			throw lastError ?? new Error('edge: no endpoint answered');
		},
		/**
		* One handshake against one host, resolving with the number of bytes sent.
		* @param endpoint - one entry of `ENDPOINTS`.
		* @param text - the text to speak.
		* @param onChunk - called with each audio batch.
		* @param markDelivered - called once the first audio batch is out.
		* @returns the number of audio bytes delivered.
		*/
		openSynthesis(endpoint, text, onChunk, markDelivered) {
			return new Promise((resolve, reject) => {
				const url = handshakeUrl(endpoint);
				const socket = new WebSocketImpl(url, {
					headers: {
						Origin: ORIGIN,
						'User-Agent':
							'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
							`Chrome/${CHROMIUM_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_VERSION.split('.')[0]}.0.0.0`,
						'Accept-Encoding': 'gzip, deflate, br, zstd',
						'Accept-Language': 'en-US,en;q=0.9',
						Pragma: 'no-cache',
						'Cache-Control': 'no-cache',
					},
				});
				let bytes = 0;
				let settled = false;
				let idle = null;
				const timer = setTimeout(() => fail(new Error('edge handshake timed out')), HANDSHAKE_TIMEOUT_MS);
				const armIdle = () => {
					if (idle !== null) clearTimeout(idle);
					idle = setTimeout(() => fail(new Error('edge stream timed out')), STREAM_TIMEOUT_MS);
				};
				const cleanup = () => {
					clearTimeout(timer);
					if (idle !== null) clearTimeout(idle);
					try {
						socket.terminate();
					} catch {
						/* already closed */
					}
				};
				const finish = (fn, value) => {
					if (settled) return;
					settled = true;
					cleanup();
					fn(value);
				};
				const fail = (error) => finish(reject, error);

				socket.on('unexpected-response', (_request, response) => fail(new Error(`edge handshake refused (${response.statusCode})`)));
				socket.on('error', (error) => fail(new Error(`edge socket: ${error.message}`)));
				socket.on('open', () => {
					armIdle();
					const timestamp = new Date().toString();
					socket.send(
						`X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
							JSON.stringify({
								context: {
									synthesis: {
										audio: {
											metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
											outputFormat: AUDIO_FORMAT,
										},
									},
								},
							}),
					);
					// Note: the read-aloud endpoint rejects the SSML <lang> element
					// (closes with 1007) and ignores the text language on
					// Multilingual voices, so a correct Spanish accent requires a
					// native Spanish voice. `xml:lang` is declared anyway, which the
					// endpoint accepts, and `language` documents what was asked.
					const ssml =
						`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapeXml(language)}'>` +
						`<voice name='${escapeXml(voice)}' xml:lang='${escapeXml(language)}'>` +
						`<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
						`${escapeXml(text)}</prosody></voice></speak>`;
					socket.send(
						`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n` +
							`X-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`,
					);
				});
				socket.on('message', (data, isBinary) => {
					armIdle();
					if (!isBinary) {
						const message = data.toString('utf8');
						if (message.includes('Path:turn.end')) {
							if (bytes === 0) fail(new Error('edge returned no audio'));
							else finish(resolve, bytes);
						}
						return;
					}
					const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
					if (buffer.length < 2) return;
					const headerLength = buffer.readUInt16BE(0);
					const header = buffer.subarray(2, 2 + headerLength).toString('utf8');
					if (!/Path:audio/i.test(header)) return;
					const audio = buffer.subarray(2 + headerLength);
					if (audio.length === 0) return;
					bytes += audio.length;
					markDelivered();
					onChunk(audio);
				});
				socket.on('close', (code) => {
					if (bytes > 0) finish(resolve, bytes);
					else fail(new Error(`edge closed (${code})`));
				});
			});
		},
	};
}

/**
 * The voices the service offers, as the service describes them.
 *
 * Cached for the life of the process: the catalogue changes rarely and asking for
 * it on every synthesis would be rude. Each entry is reduced to what this plugin
 * needs, so the shape does not depend on Microsoft's field names.
 * @param log - optional diagnostics sink.
 * @returns a list of { name, gender, locale, friendlyName, multilingual }.
 */
async function listVoices(log) {
	if (voiceList !== null) return voiceList;
	await refreshClockSkew(log);
	const query = new URLSearchParams({
		TrustedClientToken: TRUSTED_CLIENT_TOKEN,
		'Sec-MS-GEC': secMsGec(),
		'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
	});
	const response = await fetch(`${VOICES}?${query.toString()}`, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
		},
	});
	if (!response.ok) throw new Error(`voices list: HTTP ${response.status}`);
	const raw = await response.json();
	if (!Array.isArray(raw)) throw new Error('voices list: unexpected payload');
	voiceList = raw.map((voice) => ({
		name: String(voice.ShortName ?? ''),
		gender: String(voice.Gender ?? ''),
		locale: String(voice.Locale ?? ''),
		friendlyName: String(voice.FriendlyName ?? ''),
		multilingual: /Multilingual/i.test(String(voice.ShortName ?? '')),
	}));
	log?.('voices-listed', { count: voiceList.length });
	return voiceList;
}

export { createEdgeEngine };
export { listVoices };
export { secMsGec };
