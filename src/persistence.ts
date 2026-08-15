/**
 * src/persistence.ts — config persistence (localStorage, small JSON only) and
 * local media storage (IndexedDB Blobs — files are never base64-packed).
 */
import {
	AREAS, DEFAULT_AREA, DEFAULT_IMAGE, IDB_NAME, IDB_STORE, MODES, REPEATS, STORAGE_KEY, clamp,
	defaultState, mediaOfName
} from "./constants";
import type { AreaConfig, BackgroundState, GroupDef, ImageConfig, SurfaceId } from "./types";

//#region config persistence (localStorage)

/** Build a fresh (default) state object. Each surface owns its media array. */
export function freshState(): BackgroundState {
	return defaultState();
}

/** True when a stored surface key is recognized: one of the built-in areas,
 * a whole vscode-sidebar panel (panel-right / panel-bottom), or one of its
 * tab surfaces (panel-right:/panel-bottom: + title). */
function validSurfaceKey(key: string): boolean {
	if ((AREAS as readonly string[]).includes(key)) return true;
	if (key === "panel-right" || key === "panel-bottom") return true;
	if (key.startsWith("panel-right:") || key.startsWith("panel-bottom:")) return true;
	// Merged-group surfaces persist their media like any other surface.
	return key.startsWith("group:");
}

/** Narrow an unknown parsed value to an ImageConfig, or null. */
function parseImage(value: unknown): ImageConfig | null {
	if (value === null || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const img: ImageConfig = { ...DEFAULT_IMAGE };
	if (raw.source === "file") {
		if (typeof raw.fileId !== "string" || raw.fileId === "") return null;
		img.source = "file";
		img.fileId = raw.fileId;
		img.name = typeof raw.name === "string" ? raw.name : "";
		img.media = typeof raw.media === "string" && raw.media === "video" ? "video" : mediaOfName(img.name);
	} else {
		if (typeof raw.url !== "string" || raw.url === "") return null;
		img.source = "url";
		img.url = raw.url;
		img.media = typeof raw.media === "string" && raw.media === "video" ? "video" : mediaOfName(raw.url);
	}
	if (typeof raw.mode === "string" && (MODES as readonly string[]).includes(raw.mode)) img.mode = raw.mode as ImageConfig["mode"];
	if (typeof raw.posX === "string") img.posX = raw.posX;
	if (typeof raw.posY === "string") img.posY = raw.posY;
	if (typeof raw.scale === "number" && Number.isFinite(raw.scale)) img.scale = clamp(raw.scale, 10, 500);
	if (typeof raw.width === "string") img.width = raw.width;
	if (typeof raw.height === "string") img.height = raw.height;
	if (typeof raw.repeat === "string" && (REPEATS as readonly string[]).includes(raw.repeat)) img.repeat = raw.repeat as ImageConfig["repeat"];
	if (typeof raw.rotate === "number" && Number.isFinite(raw.rotate)) img.rotate = clamp(raw.rotate, -180, 180);
	if (typeof raw.radius === "number" && Number.isFinite(raw.radius)) img.radius = clamp(raw.radius, 0, 200);
	if (typeof raw.opacity === "number" && Number.isFinite(raw.opacity)) img.opacity = clamp(raw.opacity, 0, 1);
	if (typeof raw.blur === "number" && Number.isFinite(raw.blur)) img.blur = clamp(raw.blur, 0, 24);
	return img;
}

/** Read the persisted state; unknown or unreadable values fall back to defaults. */
export function restoreState(): BackgroundState {
	if (typeof localStorage === "undefined") return freshState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return freshState();
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return freshState();
		const areas = (parsed as Record<string, unknown>).areas;
		if (areas === null || typeof areas !== "object") return freshState();
		const state = freshState();
		const groupsRaw = (parsed as Record<string, unknown>).groups;
		if (Array.isArray(groupsRaw)) {
			for (const rawGroup of groupsRaw) {
				if (rawGroup === null || typeof rawGroup !== "object") continue;
				const rec = rawGroup as Record<string, unknown>;
				if (typeof rec.id !== "string" || !rec.id.startsWith("group:") || !Array.isArray(rec.members)) continue;
				const members = rec.members.filter((m): m is string => typeof m === "string" && validSurfaceKey(m));
				if (members.length > 0) state.groups.push({ id: rec.id, members });
			}
		}
		for (const storedKey of Object.keys(areas as Record<string, unknown>)) {
			if (!validSurfaceKey(storedKey)) continue;
			const stored = (areas as Record<string, unknown>)[storedKey];
			if (stored === null || typeof stored !== "object") continue;
			const cfg: AreaConfig = state.areas[storedKey] ?? { ...DEFAULT_AREA, images: [] };
			state.areas[storedKey] = cfg;
			const rec = stored as Record<string, unknown>;
			if (typeof rec.enabled === "boolean") cfg.enabled = rec.enabled;
			if (Array.isArray(rec.images)) {
				const parsed = rec.images.map(parseImage).filter((img): img is ImageConfig => img !== null);
				// Groups are single-kind (images OR videos, never mixed):
				// configs saved by older builds could hold a mix, so keep the
				// first image's kind and drop the rest.
				const kind = parsed.length > 0 ? parsed[0].media : undefined;
				cfg.images = kind !== undefined ? parsed.filter((img) => img.media === kind) : [];
			}
			if (typeof rec.intervalSec === "number" && Number.isFinite(rec.intervalSec)) cfg.intervalSec = clamp(rec.intervalSec, 0, 3600);
			if (typeof rec.random === "boolean") cfg.random = rec.random;
		}
		return state;
	} catch {
		return freshState();
	}
}

/** Persist the config; returns false on storage failure. */
export function persistState(state: BackgroundState): boolean {
	if (typeof localStorage === "undefined") return true;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}

//#endregion

//#region IndexedDB media blobs

/** Open the IndexedDB database (creates the file store on first use). */
function idbOpen(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(IDB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** A stored local file: its raw bytes plus the original MIME type. */
export interface StoredImage {
	buffer: ArrayBuffer;
	type: string;
}

/** Store a file's raw bytes (ArrayBuffer) under a key. Storing the Blob
 * object itself is unreliable — structured-cloning a File can yield a
 * zero-byte blob in some Chromium paths — so the bytes are read explicitly. */
export async function idbPutFile(key: string, data: StoredImage): Promise<void> {
	const db = await idbOpen();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(data, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** Read a stored file back as a Blob (null when missing). */
export async function idbGetFile(key: string): Promise<Blob | null> {
	const db = await idbOpen();
	try {
		return await new Promise<Blob | null>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(key);
			request.onsuccess = () => {
				const rec = request.result as StoredImage | undefined;
				resolve(rec !== undefined ? new Blob([rec.buffer], { type: rec.type }) : null);
			};
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

/** Delete a stored Blob by key. */
export async function idbDeleteFile(key: string): Promise<void> {
	const db = await idbOpen();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

//#endregion
