/**
 * Read-aloud action for assistant messages.
 *
 * Registers one entry into the `conversation.chat.assistant-actions` strip —
 * the same row that already holds copy, like/dislike and branch — so every
 * finalized assistant message gets a speaker button with pause/resume and stop.
 *
 * One engine: the Host's neural voice (`lib/index.js` serves `/tts` on loopback
 * and, when the GUI has one, under its own origin at `/dsh-tts`), played through
 * an <audio> element in segments that are prefetched ahead. There is no second
 * voice: if the Host cannot be reached, the button says so and stays silent.
 *
 * Text comes from the chat store: the turn whose `closing.finalNode.messageId`
 * matches the slot's `messageId` carries the settled `blocks`, and only
 * `kind === "text"` blocks are spoken. If the chat hook is missing on some
 * build, the component reads the rendered DOM of the same turn instead.
 */
window.__ModuleLoader__.load({
	id: "dsh-read-aloud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region dsh-read-aloud/ReadAloudActions.module.css
		const css = ".dshra_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}.dshra_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}.dshra_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.dshra_action[data-active]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary))}.dshra_action[aria-busy=true] svg{animation:dshra_pulse 1.1s ease-in-out infinite}@keyframes dshra_pulse{0%,100%{opacity:1}50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.dshra_action[aria-busy=true] svg{animation:none}}.dshra_note{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}";
		const tagId = "dsh-read-aloud/ReadAloudActions.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-read-aloud";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		/** Language asked of the Host's neural voice. */
		const SPEECH_LANG = "es";
		/** Ports the Host tries, in the same order. */
		const SERVER_PORTS = [37625, 37626, 37627, 37628, 37629, 37630];
		/** Playback settings the Host publishes in `/health`. */
		const settings = {
			segmentChars: 240,
			rate: 1
		};
		/**
		* Keep only prose: fenced code, inline code, links, tables and emphasis
		* markers are dropped so the voice does not read programming syntax aloud.
		* @param value - raw assistant markdown.
		* @returns speakable text.
		*/
		function toSpeech(value) {
			let text = typeof value === "string" ? value : "";
			text = text.replace(/```[\s\S]*?```/g, " ");
			text = text.replace(/~~~[\s\S]*?~~~/g, " ");
			text = text.replace(/`([^`]*)`/g, "$1");
			text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
			text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
			text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");
			text = text.replace(/^\s*[-*+]\s+/gm, "");
			text = text.replace(/^\s*\d+[.)]\s+/gm, "");
			text = text.replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " "));
			text = text.replace(/^\s*[-:|\s]+$/gm, " ");
			text = text.replace(/[*_~]{1,3}/g, "");
			text = text.replace(/\s+/g, " ").trim();
			return text;
		}
		/**
		* Split speakable text at sentence boundaries into pieces no longer than
		* `max`. Used for the audio
		* segments fetched from the Host.
		* @param value - speakable text.
		* @param max - soft piece length in characters.
		* @returns non-empty pieces.
		*/
		function splitSegments(value, max) {
			const limit = typeof max === "number" && max > 40 ? max : 500;
			const pieces = String(value ?? "").split(/(?<=[.!?;:])\s+|\n+/).map((piece) => piece.trim()).filter((piece) => piece !== "");
			const chunks = [];
			let current = "";
			for (const piece of pieces) {
				if (current === "") current = piece;
				else if (current.length + 1 + piece.length <= limit) current += " " + piece;
				else {
					chunks.push(current);
					current = piece;
				}
				while (current.length > limit) {
					chunks.push(current.slice(0, limit));
					current = current.slice(limit);
				}
			}
			if (current !== "") chunks.push(current);
			return chunks;
		}
		/**
		* Collect the prose of one Assistant lifecycle.
		* @param blocks - settled assistant content blocks.
		* @returns concatenated text blocks.
		*/
		function blocksToText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks.filter((block) => block !== null && typeof block === "object" && block.kind === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
		}
		/**
		* Read one message's speakable text out of the chat snapshot.
		* @param snapshot - chat store snapshot.
		* @param messageId - the message the action strip belongs to.
		* @returns speakable text, or an empty string when the message is not found.
		*/
		function selectMessageText(snapshot, messageId) {
			try {
				const turns = snapshot !== null && typeof snapshot === "object" && snapshot.timeline !== null && typeof snapshot.timeline === "object" ? snapshot.timeline.turns : null;
				if (turns === null || turns === void 0 || typeof turns.values !== "function") return "";
				for (const turn of turns.values()) {
					const data = turn !== null && typeof turn === "object" ? turn.data : null;
					if (data === null || data === void 0 || typeof data.get !== "function") continue;
					const closing = data.get("turn-tail")?.closing;
					if (closing === void 0 || closing === null || closing.finalNode === void 0) continue;
					if (closing.finalNode.messageId !== messageId) continue;
					return toSpeech(blocksToText(closing.blocks));
				}
			} catch (_error) {
				/* a shape change must never break the message row */
			}
			return "";
		}
		/**
		* Speakable text of the turn that owns one action row, read from the DOM.
		* Used only when the chat hook is not part of the slot props.
		* @param element - the action button, already mounted inside the row.
		* @returns speakable text.
		*/
		function domTurnText(element) {
			try {
				const tail = element !== null && element !== void 0 && typeof element.closest === "function" ? element.closest("[data-turn-tail]") : null;
				let node = tail === null ? null : tail.previousElementSibling;
				while (node !== null) {
					const value = typeof node.innerText === "string" ? node.innerText.trim() : "";
					if (value !== "") return toSpeech(value);
					node = node.previousElementSibling;
				}
				return toSpeech(tail === null ? "" : tail.innerText);
			} catch (_error) {
				return "";
			}
		}
		/**
		* The playback state machine shared by every message row.
		* @returns the controller: state, subscription, and the transport verbs.
		*/
		function createController() {
			const listeners = /* @__PURE__ */ new Set();
			let messageId = null;
			let phase = "idle";
			/** Why the last attempt failed; cleared on the next one. */
			let error = "";
			let token = 0;
			let segments = [];
			let index = 0;
			let audio = null;
			let ahead = null;
			let base;
			let probing = null;
			let failedAt = 0;
			const snapshot = () => {
				return {
					messageId,
					phase,
					error
				};
			};
			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (_error) {
						/* a broken row must not stop playback */
					}
				}
			};
			const set = (nextMessageId, nextPhase, nextError) => {
				messageId = nextMessageId;
				phase = nextPhase;
				error = typeof nextError === "string" ? nextError : "";
				emit();
			};
			const release = () => {
				if (audio !== null) {
					try {
						audio.pause();
						audio.removeAttribute("src");
					} catch (_error) {
						/* the element is already gone */
					}
					audio = null;
				}
				if (ahead !== null) {
					try {
						ahead.removeAttribute("src");
					} catch (_error) {
						/* the element is already gone */
					}
					ahead = null;
				}
			};
			const segmentUrl = (segment) => {
				const query = "text=" + encodeURIComponent(segment) + "&lang=" + encodeURIComponent(SPEECH_LANG);
				return base + "/tts?" + query;
			};
			const warmAhead = (next) => {
				if (next >= segments.length) return;
				try {
					ahead = new Audio(segmentUrl(segments[next]));
					ahead.preload = "auto";
					ahead.playbackRate = settings.rate;
					ahead.load();
				} catch (_error) {
					ahead = null;
				}
			};
			const finish = (mine) => {
				if (mine !== token) return;
				release();
				segments = [];
				index = 0;
				set(null, "idle");
			};
			const playSegment = (mine) => {
				if (mine !== token) return;
				if (index >= segments.length) {
					finish(mine);
					return;
				}
				let element;
				try {
					element = new Audio(segmentUrl(segments[index]));
				} catch (_error) {
					finish(mine);
					return;
				}
				audio = element;
				element.preload = "auto";
				try {
					element.playbackRate = settings.rate;
					element.preservesPitch = true;
				} catch (_error) {
					/* pitch preservation is the renderer's default anyway */
				}
				element.addEventListener("playing", () => {
					if (mine === token) set(messageId, "speaking");
				});
				element.addEventListener("ended", () => {
					if (mine !== token) return;
					index += 1;
					playSegment(mine);
				});
				element.addEventListener("error", () => {
					if (mine !== token) return;
					if (index === 0) {
						// The Host answered the health probe but not the audio. Silence
						// and a note: a substitute voice is never played.
						release();
						segments = [];
						index = 0;
						set(messageId, "idle", "La voz de Jorge no responde ahora mismo");
						return;
					}
					index += 1;
					playSegment(mine);
				});
				const started = element.play();
				if (started !== void 0 && typeof started.catch === "function") started.catch(() => {
					/* the error listener above owns the fallback */
				});
				warmAhead(index + 1);
			};
			return {
				getState: snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/** Find the Host once, then remember the base URL that answered. */
				async locate() {
					if (typeof base === "string") return base;
					if (failedAt !== 0 && Date.now() - failedAt < 30000) return null;
					if (probing !== null) return probing;
					probing = (async () => {
						const candidates = [];
						if (typeof location !== "undefined" && /^https?:$/.test(location.protocol ?? "")) candidates.push(location.origin + "/dsh-tts");
						for (const port of SERVER_PORTS) candidates.push("http://127.0.0.1:" + port);
						for (const candidate of candidates) {
							try {
								const controller = typeof AbortController === "function" ? new AbortController() : null;
								const timer = controller === null ? null : setTimeout(() => controller.abort(), 1500);
								const response = await fetch(candidate + "/health", {
									method: "GET",
									signal: controller === null ? void 0 : controller.signal
								});
								if (timer !== null) clearTimeout(timer);
								if (!response.ok) continue;
								const body = await response.json().catch(() => null);
								if (body?.ok === true) {
									if (Number.isFinite(body.segmentChars) && body.segmentChars >= 60) settings.segmentChars = body.segmentChars;
									if (Number.isFinite(body.rate) && body.rate > 0) settings.rate = body.rate;
									base = candidate;
									failedAt = 0;
									return base;
								}
							} catch (_error) {
								/* try the next candidate */
							}
						}
						base = null;
						failedAt = Date.now();
						return null;
					})();
					try {
						return await probing;
					} finally {
						probing = null;
					}
				},
				async speak(nextMessageId, text) {
					this.stop();
					const clean = typeof text === "string" ? text.trim() : "";
					if (clean === "") return false;
					token += 1;
					const mine = token;
					set(nextMessageId, "loading");
					const located = await this.locate();
					if (mine !== token) return true;
					if (located === null) {
						// The Host is not answering: silence and a note beat another voice.
						set(nextMessageId, "idle", "La voz de Jorge no está disponible");
						return false;
					}
					segments = splitSegments(clean, settings.segmentChars);
					index = 0;
					if (segments.length === 0) {
						finish(mine);
						return false;
					}
					playSegment(mine);
					return true;
				},
				pause() {
					if (phase === "loading") {
						this.stop();
						return;
					}
					if (phase !== "speaking") return;
					if (audio !== null) {
						try {
							audio.pause();
						} catch (_error) {
							/* already stopped */
						}
					}
					set(messageId, "paused");
				},
				resume() {
					if (phase !== "paused") return;
					if (audio !== null) {
						try {
							const started = audio.play();
							if (started !== void 0 && typeof started.catch === "function") started.catch(() => {});
						} catch (_error) {
							/* the element is gone */
						}
					}
					set(messageId, "speaking");
				},
				resumeText() {
					return segments.join(" ");
				},
				stop() {
					token += 1;
					release();
					segments = [];
					index = 0;
					if (messageId !== null || phase !== "idle") set(null, "idle");
				}
			};
		}
		const controller = createController();
		/** Speaker glyph, kept local because the primitives ship no volume artwork. */
		function SpeakerIcon() {
			return react.createElement("svg", {
				viewBox: "0 0 16 16",
				width: 15,
				height: 15,
				"aria-hidden": "true",
				focusable: "false"
			}, react.createElement("path", {
				d: "M8.6 2.3 5.3 4.9H3.4a.9.9 0 0 0-.9.9v4.4c0 .5.4.9.9.9h1.9l3.3 2.6c.6.5 1.6.1 1.6-.7V3c0-.8-1-1.2-1.6-.7Z",
				fill: "currentColor"
			}), react.createElement("path", {
				d: "M11.3 5.4a.75.75 0 0 1 1.06 0 4.4 4.4 0 0 1 0 5.2.75.75 0 1 1-1.14-.98 2.9 2.9 0 0 0 0-3.24.75.75 0 0 1 .08-1.06Z",
				fill: "currentColor"
			}), react.createElement("path", {
				d: "M13.2 3.3a.75.75 0 0 1 1.06 0 7.4 7.4 0 0 1 0 9.4.75.75 0 1 1-1.14-.98 5.9 5.9 0 0 0 0-7.44.75.75 0 0 1 .08-1.06Z",
				fill: "currentColor"
			}));
		}
		/**
		* Subscribe one action row to the shared controller.
		* @param messageId - the message the row belongs to.
		* @returns whether this row is the one speaking, and its phase.
		*/
		function useReadAloudState(messageId) {
			const [snapshot, setSnapshot] = react.useState(() => controller.getState());
			react.useEffect(() => controller.subscribe(() => {
				setSnapshot(controller.getState());
			}), []);
			const active = snapshot.messageId === messageId;
			return {
				active,
				phase: active ? snapshot.phase : "idle",
				error: active && typeof snapshot.error === "string" ? snapshot.error : ""
			};
		}
		/**
		* The speaker, pause/resume and stop controls of one assistant message.
		* @param props - the message identity and the text resolved for it.
		* @returns the action buttons, with a notice when there is nothing to read.
		*/
		function ReadAloudControls(props) {
			const messageId = props.messageId;
			const text = props.text;
			const state = useReadAloudState(messageId);
			const buttonRef = react.useRef(null);
			const [failed, setFailed] = react.useState(false);
			const start = react.useCallback(() => {
				const value = typeof text === "string" && text.trim() !== "" ? text : domTurnText(buttonRef.current);
				if (value.trim() === "") {
					setFailed(true);
					return;
				}
				setFailed(false);
				Promise.resolve(controller.speak(messageId, value)).then((accepted) => {
					if (accepted !== true) setFailed(true);
				}, () => setFailed(true));
			}, [messageId, text]);
			const toggle = react.useCallback(() => {
				if (state.phase === "speaking") controller.pause();
				else if (state.phase === "paused") controller.resume();
				else if (state.phase === "loading") controller.stop();
				else start();
			}, [state.phase, start]);
			const stop = react.useCallback(() => {
				controller.stop();
			}, []);
			const label = state.phase === "speaking" ? "Pausar lectura" : state.phase === "paused" ? "Reanudar lectura" : state.phase === "loading" ? "Cancelar la lectura" : "Leer en voz alta";
			const mainIcon = state.phase === "speaking" ? react.createElement(primitives.IconPauseOutlineRegular, {}) : state.phase === "paused" ? react.createElement(primitives.IconPlayOutlineRegular, {}) : react.createElement(SpeakerIcon, {});
			return react.createElement(react.Fragment, null, react.createElement(primitives.Tooltip, {
				label,
				side: "bottom"
			}, react.createElement("button", {
				ref: buttonRef,
				type: "button",
				className: "dshra_action",
				"aria-label": label,
				"aria-busy": state.phase === "loading" || void 0,
				"data-active": state.active || void 0,
				onClick: toggle
			}, mainIcon)), state.active && state.phase !== "loading" ? react.createElement(primitives.Tooltip, {
				label: "Detener lectura",
				side: "bottom"
			}, react.createElement("button", {
				type: "button",
				className: "dshra_action",
				"aria-label": "Detener lectura",
				onClick: stop
			}, react.createElement(primitives.IconStopFillRegular, {}))) : null, failed || state.error !== "" ? react.createElement("span", {
				className: "dshra_note",
				role: "status"
			}, state.error !== "" ? state.error : "No hay texto que leer") : null);
		}
		/** Reads the text from the chat store through the session's standard `useChat` hook. */
		function ReadAloudWithStore(props) {
			const text = props.useChat((snapshot) => selectMessageText(snapshot, props.messageId));
			return react.createElement(ReadAloudControls, {
				messageId: props.messageId,
				text
			});
		}
		/** Fallback for builds whose slot props carry no chat hook: read the rendered turn. */
		function ReadAloudWithDom(props) {
			return react.createElement(ReadAloudControls, {
				messageId: props.messageId,
				text: ""
			});
		}
		/**
		* One entry of the assistant action strip.
		* @param props - the strip's `messageId` plus the session standard kit.
		* @returns the read-aloud controls.
		*/
		function ReadAloudAction(props) {
			return typeof props.useChat === "function" ? react.createElement(ReadAloudWithStore, props) : react.createElement(ReadAloudWithDom, props);
		}
		/**
		* Why the document could not be read, in the words the reader needs: a
		* scanned PDF is not a broken file and must not be reported as one.
		* @param status - HTTP status of the refusal.
		* @param _message - the Host's own message, kept for diagnostics.
		* @returns the note shown next to the speaker.
		*/
		function documentFailure(status, _message) {
			if (status === 422) return "Es un PDF escaneado, sin capa de texto: necesita OCR";
			if (status === 413) return "El archivo es demasiado grande para leerlo";
			if (status === 415) return "Ese tipo de archivo no se puede leer";
			if (status === 404) return "No se encuentra el archivo";
			return "No se pudo abrir el documento";
		}
		/**
		* Speaker for the document preview: reads the file open in the right pane with
		* the same voice as a chat answer.
		* @param props - the preview's `absolutePath` owner prop.
		* @returns the action button.
		*/
		function DocumentReadAloud(props) {
			const absolutePath = typeof props.absolutePath === "string" ? props.absolutePath : "";
			const messageId = absolutePath === "" ? null : "document:" + absolutePath;
			const state = useReadAloudState(messageId);
			const [failure, setFailure] = react.useState("");
			const toggle = react.useCallback(async () => {
				if (messageId === null) {
					setFailure("No hay un documento abierto");
					return;
				}
				if (state.active && state.phase !== "idle") {
					controller.stop();
					return;
				}
				setFailure("");
				const base = await controller.locate();
				if (base === null) {
					setFailure("La voz de Jorge no está disponible");
					return;
				}
				try {
					const response = await fetch(base + "/document?path=" + encodeURIComponent(absolutePath));
					if (!response.ok) {
						const body = await response.json().catch(() => null);
						setFailure(documentFailure(response.status, body?.error));
						return;
					}
					const body = await response.json();
					const text = toSpeech(typeof body?.text === "string" ? body.text : "");
					if (text === "") {
						setFailure("No hay texto que leer");
						return;
					}
					const accepted = await controller.speak(messageId, text);
					if (accepted !== true) setFailure(controller.getState().error || "No se pudo leer el documento");
				} catch (_error) {
					setFailure("No se pudo abrir el documento");
				}
			}, [absolutePath, messageId, state.active, state.phase]);
			const label = state.active && state.phase !== "idle" ? "Detener la lectura del documento" : "Leer el documento en voz alta";
			const icon = state.phase === "speaking" ? react.createElement(primitives.IconPauseOutlineRegular, {}) : react.createElement(SpeakerIcon, {});
			return react.createElement(react.Fragment, null, react.createElement(primitives.Tooltip, {
				label,
				side: "bottom"
			}, react.createElement("button", {
				type: "button",
				className: "dshra_action",
				"aria-label": label,
				"aria-busy": state.phase === "loading" || void 0,
				"data-active": state.active || void 0,
				onClick: toggle
			}, icon)), failure !== "" ? react.createElement("span", {
				className: "dshra_note",
				role: "status"
			}, failure) : null);
		}
		/** Client services required by this plugin. */
		const inject = ["slots"];
		/**
		* Browser plugin body: one read-aloud entry in the assistant action strip.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			controller.locate().catch(() => {});
			ctx.effect(() => () => {
				controller.stop();
			}, "dsh-read-aloud: stop speech on unload");
			// The voice must survive the window losing the foreground. Chromium on
			// Windows reports an occluded window as hidden, so a visibilitychange
			// listener stopped the reading the very moment another window covered
			// Harness (medido 2026-11-15: pasar a Brave cortaba la lectura). Una
			// ventana tapada o minimizada no es una ventana que se va: se va en
			// pagehide o en beforeunload, y solo ahi se corta.
			//
			// Efecto buscado y querido: si la ventana se esconde a la bandeja, el
			// audio sigue. Es lo que quiere quien escucha, y se para con el boton.
			ctx.effect(() => {
				const onPageHide = () => controller.stop();
				const onBeforeUnload = () => controller.stop();
				if (typeof window !== "undefined") {
					window.addEventListener("pagehide", onPageHide);
					window.addEventListener("beforeunload", onBeforeUnload);
				}
				return () => {
					if (typeof window !== "undefined") {
						window.removeEventListener("pagehide", onPageHide);
						window.removeEventListener("beforeunload", onBeforeUnload);
					}
				};
			}, "dsh-read-aloud: stop speech only when the page really goes away");
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "read-aloud",
				order: 5
			}, ReadAloudAction));
			// Document preview: the same voice, for the file open in the right pane.
			try {
				ctx.slots.inject("sidebar.right.tab.document.actions", () => ctx.slots.register({
					name: "sidebar.right.tab.document.actions",
					id: "read-aloud"
				}, DocumentReadAloud));
			} catch (_error) {
				/* a build without the right pane simply has no document speaker */
			}
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			toSpeech,
			splitSegments,
			selectMessageText,
			blocksToText,
			controller
		};
		return module.exports;
	}
});
