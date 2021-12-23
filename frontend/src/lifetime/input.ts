import { DialogState } from "@/state/dialog";
import { FullscreenState } from "@/state/fullscreen";
import { DocumentsState } from "@/state/documents";
import { EditorState } from "@/state/wasm-loader";

type EventName = keyof HTMLElementEventMap | keyof WindowEventHandlersEventMap;
interface EventListenerTarget {
	addEventListener: typeof window.addEventListener;
	removeEventListener: typeof window.removeEventListener;
}

export function createInputManager(editor: EditorState, container: HTMLElement, dialog: DialogState, document: DocumentsState, fullscreen: FullscreenState) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const listeners: { target: EventListenerTarget; eventName: EventName; action: (event: any) => void; options?: boolean | AddEventListenerOptions }[] = [
		{ target: window, eventName: "resize", action: () => onWindowResize(container) },
		{ target: window, eventName: "beforeunload", action: (e) => onBeforeUnload(e) },
		{ target: window.document, eventName: "contextmenu", action: (e) => e.preventDefault() },
		{ target: window.document, eventName: "fullscreenchange", action: () => fullscreen.fullscreenModeChanged() },
		{ target: window, eventName: "keyup", action: (e) => onKeyUp(e) },
		{ target: window, eventName: "keydown", action: (e) => onKeyDown(e) },
		{ target: window, eventName: "pointermove", action: (e) => onPointerMove(e) },
		{ target: window, eventName: "pointerdown", action: (e) => onPointerDown(e) },
		{ target: window, eventName: "pointerup", action: (e) => onPointerUp(e) },
		{ target: window, eventName: "mousedown", action: (e) => onMouseDown(e) },
		{ target: window, eventName: "wheel", action: (e) => onMouseScroll(e), options: { passive: false } },
	];

	let viewportPointerInteractionOngoing = false;

	// Keyboard events

	const shouldRedirectKeyboardEventToBackend = (e: KeyboardEvent): boolean => {
		// Don't redirect user input from text entry into HTML elements
		const { target } = e;
		if (target instanceof HTMLElement && (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.isContentEditable)) return false;

		// Don't redirect when a modal is covering the workspace
		if (dialog.dialogIsVisible()) return false;

		const key = getLatinKey(e);

		// Don't redirect a fullscreen request
		if (key === "f11" && e.type === "keydown" && !e.repeat) {
			e.preventDefault();
			fullscreen.toggleFullscreen();
			return false;
		}

		// Don't redirect a reload request
		if (key === "f5") return false;

		// Don't redirect debugging tools
		if (key === "f12") return false;
		if (e.ctrlKey && e.shiftKey && key === "c") return false;
		if (e.ctrlKey && e.shiftKey && key === "i") return false;
		if (e.ctrlKey && e.shiftKey && key === "j") return false;

		// Redirect to the backend
		return true;
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const key = getLatinKey(e);

		if (shouldRedirectKeyboardEventToBackend(e)) {
			e.preventDefault();
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_key_down(key, modifiers);
			return;
		}

		if (dialog.dialogIsVisible()) {
			if (key === "escape") dialog.dismissDialog();
			if (key === "enter") {
				dialog.submitDialog();

				// Prevent the Enter key from acting like a click on the last clicked button, which might reopen the dialog
				e.preventDefault();
			}
		}
	};

	const onKeyUp = (e: KeyboardEvent) => {
		const key = getLatinKey(e);

		if (shouldRedirectKeyboardEventToBackend(e)) {
			e.preventDefault();
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_key_up(key, modifiers);
		}
	};

	// Pointer events

	const onPointerMove = (e: PointerEvent) => {
		if (!e.buttons) viewportPointerInteractionOngoing = false;

		const modifiers = makeModifiersBitfield(e);
		editor.instance.on_mouse_move(e.clientX, e.clientY, e.buttons, modifiers);
	};

	const onPointerDown = (e: PointerEvent) => {
		const { target } = e;
		const inCanvas = target instanceof Element && target.closest(".canvas");
		const inDialog = target instanceof Element && target.closest(".dialog-modal .floating-menu-content");

		if (dialog.dialogIsVisible() && !inDialog) {
			dialog.dismissDialog();
			e.preventDefault();
			e.stopPropagation();
		}

		if (inCanvas) viewportPointerInteractionOngoing = true;

		if (viewportPointerInteractionOngoing) {
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_mouse_down(e.clientX, e.clientY, e.buttons, modifiers);
		}
	};

	const onPointerUp = (e: PointerEvent) => {
		if (!e.buttons) viewportPointerInteractionOngoing = false;

		const modifiers = makeModifiersBitfield(e);
		editor.instance.on_mouse_up(e.clientX, e.clientY, e.buttons, modifiers);
	};

	// Mouse events

	const onMouseDown = (e: MouseEvent) => {
		// Block middle mouse button auto-scroll mode (the circlar widget that appears and allows quick scrolling by moving the cursor above or below it)
		// This has to be in `mousedown`, not `pointerdown`, to avoid blocking Vue's middle click detection on HTML elements
		if (e.button === 1) e.preventDefault();
	};

	const onMouseScroll = (e: WheelEvent) => {
		const { target } = e;
		const inCanvas = target instanceof Element && target.closest(".canvas");

		const horizontalScrollableElement = target instanceof Element && target.closest(".scrollable-x");
		if (horizontalScrollableElement && e.deltaY !== 0) {
			horizontalScrollableElement.scrollTo(horizontalScrollableElement.scrollLeft + e.deltaY, 0);
			return;
		}

		if (inCanvas) {
			e.preventDefault();
			const modifiers = makeModifiersBitfield(e);
			editor.instance.on_mouse_scroll(e.clientX, e.clientY, e.buttons, e.deltaX, e.deltaY, e.deltaZ, modifiers);
		}
	};

	// Window events

	const onWindowResize = (container: HTMLElement) => {
		const viewports = Array.from(container.querySelectorAll(".canvas"));
		const boundsOfViewports = viewports.map((canvas) => {
			const bounds = canvas.getBoundingClientRect();
			return [bounds.left, bounds.top, bounds.right, bounds.bottom];
		});

		const flattened = boundsOfViewports.flat();
		const data = Float64Array.from(flattened);

		if (boundsOfViewports.length > 0) editor.instance.bounds_of_viewports(data);
	};

	const onBeforeUnload = (e: BeforeUnloadEvent) => {
		// Skip the message if the editor crashed, since work is already lost
		if (editor.instance.has_crashed()) return;

		// Skip the message during development, since it's annoying when testing
		if (process.env.NODE_ENV === "development") return;

		const allDocumentsSaved = document.state.documents.reduce((acc, doc) => acc && doc.isSaved, true);
		if (!allDocumentsSaved) {
			e.returnValue = "Unsaved work will be lost if the web browser tab is closed. Close anyway?";
			e.preventDefault();
		}
	};

	// Event bindings

	const addListeners = () => {
		listeners.forEach(({ target, eventName, action, options }) => target.addEventListener(eventName, action, options));
	};

	const removeListeners = () => {
		listeners.forEach(({ target, eventName, action }) => target.removeEventListener(eventName, action));
	};

	// Run on creation
	addListeners();
	onWindowResize(container);

	return {
		removeListeners,
	};
}
export type InputManager = ReturnType<typeof createInputManager>;

export function makeModifiersBitfield(e: WheelEvent | PointerEvent | KeyboardEvent): number {
	return Number(e.ctrlKey) | (Number(e.shiftKey) << 1) | (Number(e.altKey) << 2);
}

// This function is a naive, temporary solution to allow non-Latin keyboards to fall back on the physical QWERTY layout
function getLatinKey(e: KeyboardEvent): string {
	const key = e.key.toLowerCase();
	const isPrintable = isKeyPrintable(e.key);

	// Control (non-printable) characters are handled normally
	if (!isPrintable) return key;

	// These non-Latin characters should fall back to the Latin equivalent at the key location
	const LAST_LATIN_UNICODE_CHAR = 0x024f;
	if (key.length > 1 || key.charCodeAt(0) > LAST_LATIN_UNICODE_CHAR) return e.code.toLowerCase();

	// Otherwise, ths is a printable Latin character
	return e.key.toLowerCase();
}

function isKeyPrintable(key: string): boolean {
	const allPrintableKeys: string[] = [
		// Modifier
		"Alt",
		"AltGraph",
		"CapsLock",
		"Control",
		"Fn",
		"FnLock",
		"Meta",
		"NumLock",
		"ScrollLock",
		"Shift",
		"Symbol",
		"SymbolLock",
		// Legacy modifier
		"Hyper",
		"Super",
		// White space
		"Enter",
		"Tab",
		// Navigation
		"ArrowDown",
		"ArrowLeft",
		"ArrowRight",
		"ArrowUp",
		"End",
		"Home",
		"PageDown",
		"PageUp",
		// Editing
		"Backspace",
		"Clear",
		"Copy",
		"CrSel",
		"Cut",
		"Delete",
		"EraseEof",
		"ExSel",
		"Insert",
		"Paste",
		"Redo",
		"Undo",
		// UI
		"Accept",
		"Again",
		"Attn",
		"Cancel",
		"ContextMenu",
		"Escape",
		"Execute",
		"Find",
		"Help",
		"Pause",
		"Play",
		"Props",
		"Select",
		"ZoomIn",
		"ZoomOut",
		// Device
		"BrightnessDown",
		"BrightnessUp",
		"Eject",
		"LogOff",
		"Power",
		"PowerOff",
		"PrintScreen",
		"Hibernate",
		"Standby",
		"WakeUp",
		// IME composition keys
		"AllCandidates",
		"Alphanumeric",
		"CodeInput",
		"Compose",
		"Convert",
		"Dead",
		"FinalMode",
		"GroupFirst",
		"GroupLast",
		"GroupNext",
		"GroupPrevious",
		"ModeChange",
		"NextCandidate",
		"NonConvert",
		"PreviousCandidate",
		"Process",
		"SingleCandidate",
		// Korean-specific
		"HangulMode",
		"HanjaMode",
		"JunjaMode",
		// Japanese-specific
		"Eisu",
		"Hankaku",
		"Hiragana",
		"HiraganaKatakana",
		"KanaMode",
		"KanjiMode",
		"Katakana",
		"Romaji",
		"Zenkaku",
		"ZenkakuHankaku",
		// Common function
		"F1",
		"F2",
		"F3",
		"F4",
		"F5",
		"F6",
		"F7",
		"F8",
		"F9",
		"F10",
		"F11",
		"F12",
		"Soft1",
		"Soft2",
		"Soft3",
		"Soft4",
		// Multimedia
		"ChannelDown",
		"ChannelUp",
		"Close",
		"MailForward",
		"MailReply",
		"MailSend",
		"MediaClose",
		"MediaFastForward",
		"MediaPause",
		"MediaPlay",
		"MediaPlayPause",
		"MediaRecord",
		"MediaRewind",
		"MediaStop",
		"MediaTrackNext",
		"MediaTrackPrevious",
		"New",
		"Open",
		"Print",
		"Save",
		"SpellCheck",
		// Multimedia numpad
		"Key11",
		"Key12",
		// Audio
		"AudioBalanceLeft",
		"AudioBalanceRight",
		"AudioBassBoostDown",
		"AudioBassBoostToggle",
		"AudioBassBoostUp",
		"AudioFaderFront",
		"AudioFaderRear",
		"AudioSurroundModeNext",
		"AudioTrebleDown",
		"AudioTrebleUp",
		"AudioVolumeDown",
		"AudioVolumeUp",
		"AudioVolumeMute",
		"MicrophoneToggle",
		"MicrophoneVolumeDown",
		"MicrophoneVolumeUp",
		"MicrophoneVolumeMute",
		// Speech
		"SpeechCorrectionList",
		"SpeechInputToggle",
		// Application
		"LaunchApplication1",
		"LaunchApplication2",
		"LaunchCalendar",
		"LaunchContacts",
		"LaunchMail",
		"LaunchMediaPlayer",
		"LaunchMusicPlayer",
		"LaunchPhone",
		"LaunchScreenSaver",
		"LaunchSpreadsheet",
		"LaunchWebBrowser",
		"LaunchWebCam",
		"LaunchWordProcessor",
		// Browser
		"BrowserBack",
		"BrowserFavorites",
		"BrowserForward",
		"BrowserHome",
		"BrowserRefresh",
		"BrowserSearch",
		"BrowserStop",
		// Mobile phone
		"AppSwitch",
		"Call",
		"Camera",
		"CameraFocus",
		"EndCall",
		"GoBack",
		"GoHome",
		"HeadsetHook",
		"LastNumberRedial",
		"Notification",
		"MannerMode",
		"VoiceDial",
		// TV
		"TV",
		"TV3DMode",
		"TVAntennaCable",
		"TVAudioDescription",
		"TVAudioDescriptionMixDown",
		"TVAudioDescriptionMixUp",
		"TVContentsMenu",
		"TVDataService",
		"TVInput",
		"TVInputComponent1",
		"TVInputComponent2",
		"TVInputComposite1",
		"TVInputComposite2",
		"TVInputHDMI1",
		"TVInputHDMI2",
		"TVInputHDMI3",
		"TVInputHDMI4",
		"TVInputVGA1",
		"TVMediaContext",
		"TVNetwork",
		"TVNumberEntry",
		"TVPower",
		"TVRadioService",
		"TVSatellite",
		"TVSatelliteBS",
		"TVSatelliteCS",
		"TVSatelliteToggle",
		"TVTerrestrialAnalog",
		"TVTerrestrialDigital",
		"TVTimer",
		// Media controls
		"AVRInput",
		"AVRPower",
		"ColorF0Red",
		"ColorF1Green",
		"ColorF2Yellow",
		"ColorF3Blue",
		"ColorF4Grey",
		"ColorF5Brown",
		"ClosedCaptionToggle",
		"Dimmer",
		"DisplaySwap",
		"DVR",
		"Exit",
		"FavoriteClear0",
		"FavoriteClear1",
		"FavoriteClear2",
		"FavoriteClear3",
		"FavoriteRecall0",
		"FavoriteRecall1",
		"FavoriteRecall2",
		"FavoriteRecall3",
		"FavoriteStore0",
		"FavoriteStore1",
		"FavoriteStore2",
		"FavoriteStore3",
		"Guide",
		"GuideNextDay",
		"GuidePreviousDay",
		"Info",
		"InstantReplay",
		"Link",
		"ListProgram",
		"LiveContent",
		"Lock",
		"MediaApps",
		"MediaAudioTrack",
		"MediaLast",
		"MediaSkipBackward",
		"MediaSkipForward",
		"MediaStepBackward",
		"MediaStepForward",
		"MediaTopMenu",
		"NavigateIn",
		"NavigateNext",
		"NavigateOut",
		"NavigatePrevious",
		"NextFavoriteChannel",
		"NextUserProfile",
		"OnDemand",
		"Pairing",
		"PinPDown",
		"PinPMove",
		"PinPToggle",
		"PinPUp",
		"PlaySpeedDown",
		"PlaySpeedReset",
		"PlaySpeedUp",
		"RandomToggle",
		"RcLowBattery",
		"RecordSpeedNext",
		"RfBypass",
		"ScanChannelsToggle",
		"ScreenModeNext",
		"Settings",
		"SplitScreenToggle",
		"STBInput",
		"STBPower",
		"Subtitle",
		"Teletext",
		"VideoModeNext",
		"Wink",
		"ZoomToggle",
	];

	return !allPrintableKeys.includes(key);
}
