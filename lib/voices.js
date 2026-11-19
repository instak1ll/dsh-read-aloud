/**
 * Choosing a voice without asking the reader anything.
 *
 * The catalogue behind Edge's "Read aloud" carries 318 voices across 142 locales,
 * and 75 languages have at least one male voice. That is enough to pick a decent
 * default for whoever installs the plugin, instead of shipping one Spanish voice
 * and leaving everyone else with a language they cannot read.
 *
 * The rules, in order:
 *
 *   1. only male voices, because that is the default the plugin promises
 *   2. the reader's own locale first (`es-ES` before `es-MX` for someone in Spain)
 *   3. the newest family first: the multilingual neural voices are better than the
 *      older single-locale ones when both exist for that locale
 *   4. alphabetical, so the choice is stable and testable
 *
 * Everything here is pure: it takes the catalogue and returns names. No network,
 * no disk, no clock. That is what makes it checkable.
 */

/**
 * Last resort per language, for when the catalogue cannot be reached at all.
 * Small on purpose: it is a net, not the plan.
 */
const FALLBACK = {
	es: 'es-MX-JorgeNeural',
	en: 'en-US-AndrewMultilingualNeural',
	fr: 'fr-FR-HenriNeural',
	de: 'de-DE-ConradNeural',
	it: 'it-IT-DiegoNeural',
	pt: 'pt-BR-AntonioNeural',
	ru: 'ru-RU-DmitryNeural',
	ja: 'ja-JP-KeitaNeural',
	ko: 'ko-KR-InJoonNeural',
	zh: 'zh-CN-YunxiNeural',
	ar: 'ar-EG-ShakirNeural',
	hi: 'hi-IN-MadhurNeural',
	nl: 'nl-NL-MaartenNeural',
	pl: 'pl-PL-MarekNeural',
	tr: 'tr-TR-AhmetNeural',
	sv: 'sv-SE-MattiasNeural',
	da: 'da-DK-JeppeNeural',
	fi: 'fi-FI-HarriNeural',
	nb: 'nb-NO-FinnNeural',
	cs: 'cs-CZ-AntoninNeural',
	el: 'el-GR-NestorasNeural',
	he: 'he-IL-AvriNeural',
	hu: 'hu-HU-TamasNeural',
	id: 'id-ID-ArdiNeural',
	ro: 'ro-RO-EmilNeural',
	sk: 'sk-SK-LukasNeural',
	uk: 'uk-UA-OstapNeural',
	vi: 'vi-VN-NamMinhNeural',
	th: 'th-TH-NiwatNeural',
};

/**
 * The language part of a locale tag.
 * @param locale - something like "es-ES", "en_US" or "pt-BR".
 * @returns the lower-case language, or an empty string.
 */
function languageOf(locale) {
	if (typeof locale !== 'string') return '';
	return locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * What locale is this machine on.
 * @param options - optional `locale` to force, and an `intl` to read from.
 * @returns a tag like "es-ES", or an empty string when nothing is known.
 */
function detectLocale(options = {}) {
	if (typeof options.locale === 'string' && options.locale !== '') return options.locale;
	const intl = options.intl ?? Intl;
	try {
		const resolved = intl.DateTimeFormat().resolvedOptions().locale;
		return typeof resolved === 'string' ? resolved : '';
	} catch {
		/* a broken ICU must not take the plugin down */
		return '';
	}
}

/**
 * Every male voice for one language, best first.
 * @param voices - the catalogue: `{ name, gender, locale, multilingual }`.
 * @param language - two-letter language, e.g. "es".
 * @param locale - the reader's exact locale, e.g. "es-ES".
 * @returns the names, best first.
 */
function rankMaleVoices(voices, language, locale) {
	if (!Array.isArray(voices) || language === '') return [];
	const exact = String(locale ?? '').toLowerCase();
	return voices
		.filter((voice) => voice.gender === 'Male' && languageOf(voice.locale) === language)
		.sort((left, right) => {
			const leftExact = languageOf(left.locale) === language && String(left.locale).toLowerCase() === exact ? 0 : 1;
			const rightExact = languageOf(right.locale) === language && String(right.locale).toLowerCase() === exact ? 0 : 1;
			if (leftExact !== rightExact) return leftExact - rightExact;
			const leftMulti = left.multilingual === true ? 0 : 1;
			const rightMulti = right.multilingual === true ? 0 : 1;
			if (leftMulti !== rightMulti) return leftMulti - rightMulti;
			return String(left.name).localeCompare(String(right.name));
		})
		.map((voice) => voice.name);
}

/**
 * The voice to use when nobody has chosen one.
 * @param voices - the catalogue.
 * @param language - two-letter language.
 * @param locale - the reader's exact locale.
 * @returns a voice name, or null when the language has no male voice and no fallback.
 */
function pickMaleVoice(voices, language, locale) {
	const ranked = rankMaleVoices(voices, language, locale);
	if (ranked.length > 0) return ranked[0];
	return FALLBACK[language] ?? null;
}

/**
 * Every language the catalogue can speak with a male voice, with one example each.
 * @param voices - the catalogue.
 * @returns `{ es: 'es-MX-JorgeNeural', … }`, sorted by language.
 */
function languagesWithMaleVoice(voices) {
	const found = {};
	if (!Array.isArray(voices)) return found;
	for (const voice of [...voices].sort((left, right) => String(left.name).localeCompare(String(right.name)))) {
		if (voice.gender !== 'Male') continue;
		const language = languageOf(voice.locale);
		if (language !== '' && found[language] === undefined) found[language] = voice.name;
	}
	return found;
}

export { FALLBACK };
export { detectLocale };
export { languageOf };
export { languagesWithMaleVoice };
export { pickMaleVoice };
export { rankMaleVoices };
