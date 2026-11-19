/**
 * Build the listening gallery: a short sample per voice, in its own language, plus
 * the page that plays them.
 *
 * The samples are the point. A voice name says nothing: "es-MX-JorgeNeural" could be
 * anything until you hear it. This writes one small MP3 per voice under
 * `docs/samples/<locale>/<voice>.mp3`, a `docs/samples.json` manifest, and
 * `docs/voices.html`, a page with a button per voice grouped by language.
 *
 * The page is meant for GitHub Pages, where it is clickable by anyone, no install.
 *
 * Usage:
 *   node tools/muestra-voces.mjs                 every voice
 *   node tools/muestra-voces.mjs --male          only male voices
 *   node tools/muestra-voces.mjs --language es   only one language
 *   node tools/muestra-voces.mjs --page          only rebuild the page from the manifest
 *
 * It is resumable: an MP3 already on disk is not synthesized again, so a run that
 * dies halfway costs nothing to repeat.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEdgeEngine, listVoices } from '../lib/edge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SAMPLES = join(ROOT, 'docs', 'samples');
const MANIFEST = join(ROOT, 'docs', 'samples.json');
const PAGE = join(ROOT, 'docs', 'voices.html');

/** How long the sentence should last: short, but long enough to judge a voice. */
const PHRASE = {
	af: 'Hallo, dit is my stem.',
	sq: 'Pershendetje, ky eshte zeri im.',
	am: 'Selam, yihinetse inegna.',
	ar: 'مرحبا، هذا صوتي.',
	az: 'Salam, bu menim sesimdir.',
	bg: 'Здравей, това е моят глас.',
	bn: 'হ্যালো, এটি আমার কণ্ঠ।',
	bs: 'Zdravo, ovo je moj glas.',
	ca: 'Hola, aquesta es la meva veu.',
	cs: 'Ahoj, toto je muj hlas.',
	cy: 'Helo, dyma fy llais i.',
	da: 'Hej, dette er min stemme.',
	de: 'Hallo, das ist meine Stimme.',
	el: 'Γεια σου, αυτή είναι η φωνή μου.',
	en: 'Hello, this is my voice.',
	es: 'Hola, esta es mi voz.',
	et: 'Tere, see on minu haal.',
	fa: 'سلام، این صدای من است.',
	fi: 'Hei, tama on minun aaneni.',
	fil: 'Kumusta, ito ang boses ko.',
	fr: 'Bonjour, ceci est ma voix.',
	ga: 'Dia dhuit, seo mo ghuth.',
	gl: 'Ola, esta e a miña voz.',
	gu: 'નમસ્તે, આ મારો અવાજ છે.',
	he: 'שלום, זה הקול שלי.',
	hi: 'नमस्ते, यह मेरी आवाज़ है।',
	hr: 'Bok, ovo je moj glas.',
	hu: 'Szia, ez az en hangom.',
	hy: 'Բարև, սա իմ ձայնն է։',
	id: 'Halo, ini suara saya.',
	is: 'Hallo, thetta er roddin min.',
	it: 'Ciao, questa e la mia voce.',
	ja: 'こんにちは、これが私の声です。',
	jv: 'Sugeng rawuh, iki swaraku.',
	ka: 'გამარჯობა, ეს ჩემი ხმაა.',
	kk: 'Сәлем, бұл менің даусым.',
	km: 'សួស្តី នេះជាសំឡេងរបស់ខ្ញុំ។',
	kn: 'ನಮಸ್ಕಾರ, ಇದು ನನ್ನ ಧ್ವನಿ.',
	ko: '안녕하세요, 이것은 제 목소리입니다.',
	lo: 'ສະບາຍດີ, ນີ້ແມ່ນສຽງຂອງຂ້ອຍ.',
	lt: 'Labas, tai mano balsas.',
	lv: 'Sveiki, si ir mana balss.',
	mk: 'Здраво, ова е мојот глас.',
	ml: 'നമസ്കാരം, ഇതാണ് എന്റെ ശബ്ദം.',
	mn: 'Сайн байна уу, энэ миний дуу хоолой.',
	mr: 'नमस्कार, हा माझा आवाज आहे.',
	ms: 'Helo, ini suara saya.',
	mt: 'Bongu, din il-vuci tieghi.',
	my: 'မင်္ဂလာပါ၊ ဒါက ကျွန်တော့်အသံပါ။',
	nb: 'Hei, dette er stemmen min.',
	ne: 'नमस्ते, यो मेरो आवाज हो।',
	nl: 'Hallo, dit is mijn stem.',
	pl: 'Czesc, to jest moj glos.',
	ps: 'سلام، دا زما غږ دی.',
	pt: 'Ola, esta e a minha voz.',
	ro: 'Buna, aceasta este vocea mea.',
	ru: 'Привет, это мой голос.',
	si: 'ආයුබෝවන්, මේ මගේ හඬයි.',
	sk: 'Ahoj, toto je moj hlas.',
	sl: 'Zdravo, to je moj glas.',
	so: 'Salaan, kani waa codkayga.',
	sr: 'Здраво, ово је мој глас.',
	sv: 'Hej, det har ar min rost.',
	sw: 'Habari, hii ni sauti yangu.',
	ta: 'வணக்கம், இது என் குரல்.',
	te: 'నమస్కారం, ఇది నా స్వరం.',
	th: 'สวัสดี นี่คือเสียงของฉัน',
	tr: 'Merhaba, bu benim sesim.',
	uk: 'Привіт, це мій голос.',
	ur: 'سلام، یہ میری آواز ہے۔',
	uz: 'Salom, bu mening ovozim.',
	vi: 'Xin chao, day la giong cua toi.',
	zh: '你好，这是我的声音。',
	zu: 'Sawubona, leli yizwi lami.',
};

/** Languages that read left to right but are written around, for the page. */
const DISPLAY = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * The sentence one voice should read.
 * @param locale - the voice locale, like "es-MX".
 * @returns the phrase, in that language when there is one.
 */
function phraseFor(locale) {
	const language = String(locale ?? '').toLowerCase().split(/[-_]/)[0];
	return PHRASE[language] ?? PHRASE.en;
}

/**
 * A stable file name for one voice.
 * @param name - the voice name.
 * @returns the file name, safe for every filesystem.
 */
function fileNameFor(name) {
	return `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.mp3`;
}

/**
 * Synthesize one voice to disk.
 * @param voice - catalogue entry.
 * @returns the byte length written.
 */
async function synthesizeOne(voice) {
	const language = String(voice.locale).toLowerCase().split(/[-_]/)[0];
	const target = join(SAMPLES, voice.locale, fileNameFor(voice.name));
	if (existsSync(target)) return 0;
	const phrase = phraseFor(voice.locale);
	const engine = createEdgeEngine({ voice: voice.name, language: voice.locale, prosodyRate: '+0%', pitch: '+0Hz', volume: '+0%' });
	const chunks = [];
	await engine.synthesizeStream(phrase, (chunk) => chunks.push(chunk));
	const buffer = Buffer.concat(chunks);
	if (buffer.length === 0) throw new Error('no audio');
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, buffer);
	return buffer.length;
}

/**
 * The README carries every voice too, as links. GitHub serves an MP3 as
 * `audio/mpeg`, so clicking one plays it in the browser: no Pages, no download.
 * The block is regenerated from the manifest, between markers, so it cannot drift.
 */
function writeReadmeBlock() {
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	// Not raw.githubusercontent: it sends `Content-Disposition: attachment`, so the
	// browser downloads. jsDelivr serves the same file from the same repo with
	// `audio/mpeg` and no attachment, so a click plays it.
	// Two modes. By default each voice links straight at its MP3 through jsDelivr, so a
	// click plays it in the browser. With --pages, each voice links at the gallery on
	// that voice's anchor, which gives a real player with controls and a filter.
	const pages = process.argv.includes('--pages');
	const base = pages
		? 'https://instak1ll.github.io/dsh-read-aloud/voices.html#'
		: 'https://cdn.jsdelivr.net/gh/instak1ll/dsh-read-aloud@main/docs/';
	const groups = new Map();
	for (const entry of manifest) {
		const language = String(entry.voice.locale).toLowerCase().split(/[-_]/)[0];
		if (!groups.has(language)) groups.set(language, []);
		groups.get(language).push(entry);
	}
	const blocks = [...groups.keys()]
		.sort()
		.map((language) => {
			const entries = groups
				.get(language)
				.sort((left, right) => left.voice.locale.localeCompare(right.voice.locale) || left.voice.name.localeCompare(right.voice.name));
			let title = language;
			try {
				title = DISPLAY.of(language) ?? language;
			} catch {
				/* an unknown tag keeps its code */
			}
			const lines = entries.map(
				(entry) =>
					pages
						? `- [${entry.voice.name}](${base}${entry.voice.name}) · ${entry.voice.gender.toLowerCase()} · ${entry.voice.locale}`
						: `- [${entry.voice.name}](${base}${entry.file}) · ${entry.voice.gender.toLowerCase()} · ${entry.voice.locale}`,
			);
			return `<details>\n<summary><b>${title}</b> · ${entries.length} ${entries.length === 1 ? 'voice' : 'voices'}</summary>\n\n${lines.join('\n')}\n\n</details>`;
		})
		.join('\n\n');
	const body = [
		'<!-- voces:inicio',
		'     Written by node tools/muestra-voces.mjs --page. Do not edit by hand: it is overwritten.',
		'     Links go through jsDelivr because raw.githubusercontent sends Content-Disposition:',
		'     attachment (a download), while jsDelivr serves audio/mpeg, so a click plays. -->',
		'',
		'',
		blocks,
		'',
		'<!-- voces:fin -->',
	].join('\n');
	const readmePath = join(ROOT, 'README.md');
	const readme = readFileSync(readmePath, 'utf8');
	const start = readme.indexOf('<!-- voces:inicio');
	const end = readme.indexOf('<!-- voces:fin -->');
	if (start === -1 || end === -1) {
		console.log('README has no voice block markers; nothing written');
		return;
	}
	writeFileSync(readmePath, readme.slice(0, start) + body + readme.slice(end + '<!-- voces:fin -->'.length), 'utf8');
}

/**
 * Write the listening page from what is on disk.
 */
function writePage() {
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const byLanguage = new Map();
	for (const entry of manifest) {
		const language = String(entry.voice.locale).toLowerCase().split(/[-_]/)[0];
		if (!byLanguage.has(language)) byLanguage.set(language, []);
		byLanguage.get(language).push(entry);
	}
	const sections = [...byLanguage.keys()]
		.sort()
		.map((language) => {
			const rows = byLanguage
				.get(language)
				.sort((left, right) => left.voice.locale.localeCompare(right.voice.locale) || left.voice.name.localeCompare(right.voice.name))
				.map((entry) => {
					let nice = entry.locale;
					try {
						nice = `${DISPLAY.of(language) ?? language} (${entry.voice.locale})`;
					} catch {
						/* an unknown tag keeps its code */
					}
					return `      <li id="${entry.voice.name}" data-search="${entry.voice.name.toLowerCase()} ${entry.voice.locale.toLowerCase()} ${String(DISPLAY.of(language) ?? '').toLowerCase()}"><button data-src="${entry.file}">${entry.voice.name}</button><span>${entry.voice.gender.toLowerCase()} · ${nice}</span></li>`;
				})
				.join('\n');
			const title = (() => {
				try {
					return DISPLAY.of(language) ?? language;
				} catch {
					return language;
				}
			})();
			return `  <details data-language="${language}">\n    <summary><span class="lang">${title}</span><span class="count">${byLanguage.get(language).length} ${byLanguage.get(language).length === 1 ? 'voice' : 'voices'}</span></summary>\n    <ul>\n${rows}\n    </ul>\n  </details>`;
		})
		.join('\n');

	const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Read aloud · every voice</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px;max-width:1000px;margin-inline:auto}
  h1{font-size:22px;margin:0 0 4px}
  p.hint{color:#777;margin:0 0 16px}
  input{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #bbb;background:transparent;color:inherit;width:min(340px,100%);margin-bottom:20px}
  details{border-bottom:1px solid rgba(128,128,128,.18)}
  summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 2px;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"\\25B8";color:#888;transition:transform .15s}
  details[open] summary::before{transform:rotate(90deg)}
  summary .lang{font-size:15px;font-weight:600}
  summary .count{color:#888;font-size:13px;margin-left:auto;font-variant-numeric:tabular-nums}
  details ul{padding:2px 0 10px 24px}
  ul{list-style:none;padding:0;margin:0}
  li{display:flex;align-items:center;gap:12px;padding:5px 0;border-bottom:1px solid rgba(128,128,128,.18)}
  button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #bbb;background:rgba(128,128,128,.10);color:inherit;cursor:pointer;min-width:300px;text-align:left}
  button:hover{background:rgba(128,128,128,.22)}
  button.playing{outline:2px solid #3b6fd4}
  span{color:#888;font-size:13px}
</style>
<h1>Read aloud · every voice</h1>
<p class="hint">${manifest.length} voices in ${byLanguage.size} languages. Open a language, then click a voice to hear it read a short sentence of its own. Click the same voice again to stop.</p>
<input type="search" placeholder="Filter by voice, language or code…" id="q" aria-label="Filter voices">
${sections}
<script>
const audio = new Audio();
let current = null;
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-src]');
  if (button === null) return;
  if (current === button) { audio.pause(); current.classList.remove('playing'); current = null; return; }
  if (current !== null) current.classList.remove('playing');
  current = button;
  button.classList.add('playing');
  audio.src = button.dataset.src;
  audio.play();
});
audio.addEventListener('ended', () => { if (current !== null) current.classList.remove('playing'); current = null; });
// A link ending in #es-MX-JorgeNeural opens that language and plays that voice, so
// every entry in the README can point at the player instead of at a file.
const target = decodeURIComponent(location.hash.slice(1));
if (target !== '') {
  const item = document.getElementById(target);
  if (item !== null) {
    const group = item.closest('details');
    if (group !== null) group.open = true;
    item.scrollIntoView({ block: 'center' });
    const button = item.querySelector('button[data-src]');
    if (button !== null) button.click();
  }
}
const filter = document.getElementById('q');
filter.addEventListener('input', () => {
  const needle = filter.value.trim().toLowerCase();
  for (const item of document.querySelectorAll('li[data-search]')) {
    item.style.display = needle === '' || item.dataset.search.includes(needle) ? '' : 'none';
  }
  for (const group of document.querySelectorAll('details[data-language]')) {
    const visible = [...group.querySelectorAll('li')].some((item) => item.style.display !== 'none');
    group.style.display = visible ? '' : 'none';
    // Filtrar abre lo que coincide, y limpiar el filtro los vuelve a cerrar.
    group.open = needle !== '' && visible;
  }
});
</script>
</html>
`;
	writeFileSync(PAGE, html, 'utf8');
}

const args = process.argv.slice(2);
const pageOnly = args.includes('--page');
const maleOnly = args.includes('--male');
const languageIndex = args.indexOf('--language');
const onlyLanguage = languageIndex === -1 ? null : args[languageIndex + 1];

if (pageOnly) {
	writePage();
	writeReadmeBlock();
	console.log(`page and README block rewritten from ${MANIFEST}`);
	process.exit(0);
}

mkdirSync(SAMPLES, { recursive: true });
const voices = await listVoices((event, data) => {
	if (event === 'voices-listed') console.log(`catalogue: ${data.count} voices`);
});
let wanted = voices;
if (maleOnly) wanted = wanted.filter((voice) => voice.gender === 'Male');
if (onlyLanguage !== null) wanted = wanted.filter((voice) => String(voice.locale).toLowerCase().startsWith(onlyLanguage.toLowerCase()));
wanted = wanted.sort((left, right) => left.locale.localeCompare(right.locale) || left.name.localeCompare(right.name));

console.log(`synthesizing ${wanted.length} voices…`);
const manifest = [];
let done = 0;
let bytes = 0;
let failed = 0;
/** Simple bounded pool: four at a time is kind to the service. */
const queue = [...wanted];
const worker = async () => {
	for (;;) {
		const voice = queue.shift();
		if (voice === undefined) return;
		try {
			const written = await synthesizeOne(voice);
			bytes += written;
			done += 1;
			const file = `samples/${voice.locale}/${fileNameFor(voice.name)}`;
			manifest.push({ voice: { name: voice.name, gender: voice.gender, locale: voice.locale }, file, phrase: phraseFor(voice.locale) });
			if (done % 20 === 0) console.log(`  ${done}/${wanted.length} · ${(bytes / 1024 / 1024).toFixed(1)} MB written`);
		} catch (error) {
			failed += 1;
			console.error(`  ${voice.name}: ${error?.message ?? String(error)}`);
		}
	}
};
await Promise.all([worker(), worker(), worker(), worker()]);

// The manifest is rebuilt from what is on disk, so a resumed run keeps everything.
const onDisk = [];
for (const locale of readdirSync(SAMPLES, { withFileTypes: true })) {
	if (!locale.isDirectory()) continue;
	for (const file of readdirSync(join(SAMPLES, locale.name))) {
		if (!file.endsWith('.mp3')) continue;
		const name = file.replace(/\.mp3$/, '');
		const known = voices.find((voice) => voice.name === name);
		onDisk.push({
			voice: { name, gender: known?.gender ?? '', locale: locale.name },
			file: `samples/${locale.name}/${file}`,
			phrase: phraseFor(locale.name),
		});
	}
}
onDisk.sort((left, right) => left.voice.locale.localeCompare(right.voice.locale) || left.voice.name.localeCompare(right.voice.name));
writeFileSync(MANIFEST, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
writePage();
writeReadmeBlock();
console.log(`\nsamples on disk: ${onDisk.length} · failures this run: ${failed}`);
console.log(`manifest: ${MANIFEST}`);
console.log(`page:     ${PAGE}`);
