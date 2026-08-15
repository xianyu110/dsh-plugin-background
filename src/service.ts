/**
 * src/service.ts — BackgroundService: owns the persisted per-surface state
 * (media groups + per-image display/rendering config + slideshow playback),
 * paints each surface's layer pair, and emits `background/change` snapshots.
 *
 * Surfaces: the four built-in areas (conversation / trajectory / sidebar /
 * settings) plus one surface PER dsh-plugin-vscode-sidebar tab (`panel-right:<title>`
 * / `panel-bottom:<title>`, discovered from the DOM and persisted per title
 * so a tab's background survives close/reopen). Each surface owns TWO stacked
 * layer elements (a/b) so media switches can crossfade: the incoming layer
 * fades in while the outgoing one fades out. Every layer hosts exactly one
 * media child — a background-image div for images/GIFs or a muted looping
 * <video> for videos.
 *
 * Switches are preloaded and crossfaded: the next media is fetched early
 * (half an interval ahead), and the switch only lands once the media has
 * actually loaded — the interval is allowed to overrun rather than flash an
 * empty layer. The crossfade itself is driven by the Web Animations API
 * (`Element.animate`), not by CSS transitions, so it runs regardless of
 * shell stylesheet overrides and can be retargeted mid-fade. A switch to
 * the SAME media (single-image surfaces, per-image tweaks) repaints in place
 * without any fade. Each surface's group holds ONE media kind — images
 * switch like a slideshow, videos play; mixed groups are not supported.
 * Local files live in IndexedDB as raw bytes and display through
 * lazily-created object URLs (cached and revoked here). Opacity and blur
 * are per image, not per surface.
 */
import { AREAS, DEFAULT_AREA, TICK_MS, clamp, escapeCssString, surfaceHash } from "./constants";
import { resolveDisplay, videoFitOf } from "./display";
import { deleteStoredFile } from "./files";
import { idbGetFile, persistState, restoreState } from "./persistence";
import type { AreaConfig, BackgroundSnapshot, BackgroundState, ImageConfig, MediaType, SurfaceId, SurfaceMeta } from "./types";

/** Cordis context subset the service needs. */
export interface BackgroundCtx {
	effect(callback: () => void | (() => void), label?: string): () => void;
	emit(event: string, payload?: unknown): void;
}

/** Outcome of adding media to a surface. A group holds ONE media kind —
 * images switch like a slideshow, videos play — mixed batches are filtered
 * to the group's kind and the leftovers reported here for the editor UI. */
export interface AddImagesResult {
	added: number;
	/** Count of configs skipped because their kind differs from the group's. */
	skipped: number;
	/** Media kind of the skipped configs (undefined when nothing was skipped). */
	skippedKind?: MediaType;
}

/** Crossfade duration and settle wait. The fade is WAAPI-driven; the settle
 * wait leaves a margin after the fade completes before the outgoing layer
 * is cleaned up. */
const FADE_MS = 450;
const FADE_SETTLE_MS = FADE_MS + 80;

/** Which physical layer element is which. */
type LayerIndex = 0 | 1;

/** True when a surface id is a vscode-sidebar tab surface. */
function isTabSurface(surface: SurfaceId): boolean {
	return surface.startsWith("panel-right:") || surface.startsWith("panel-bottom:");
}

/** True when a surface id is a WHOLE vscode-sidebar panel (right / bottom):
 * the entire panel paints one background no matter which tab is inside. */
function isPanelSurface(surface: SurfaceId): boolean {
	return surface === "panel-right" || surface === "panel-bottom";
}

/** The CSS/data-attribute token of a surface (tab titles carry arbitrary
 * characters, so tab surfaces use a stable hash). */
function surfaceToken(surface: SurfaceId): string {
	return isTabSurface(surface) ? `tab-${surfaceHash(surface)}` : surface;
}

export class BackgroundService {
	private ctx: BackgroundCtx;
	private state: BackgroundState;
	/** The current surface set: built-in areas + discovered vscode-sidebar tabs. */
	private surfaces = new Set<SurfaceId>();
	/** Tab surface → its paneTab host element (from the last discovery pass). */
	private tabHosts = new Map<SurfaceId, HTMLElement>();
	/** Tab surface → tab bar title (display label). */
	private tabLabels = new Map<SurfaceId, string>();
	/** Runtime per-surface playback state (lazily created records). */
	private index: Record<SurfaceId, number> = {};
	private elapsed: Record<SurfaceId, number> = {};
	private lastError: string | null = null;
	private revision = 0;
	private snapshot: BackgroundSnapshot;
	/** fileId -> object URL cache for local media. */
	private objectUrls = new Map<string, string>();
	/** URL -> preload promise cache (shared across prewarm/switch). */
	private preloadCache = new Map<string, Promise<boolean>>();
	/** Currently visible layer per surface. */
	private activeLayer: Record<SurfaceId, LayerIndex> = {};
	/** Layer elements projected at least once (painted or explicitly hidden). */
	private projectedLayers = new WeakSet<HTMLElement>();
	/** Last media painted per surface (same-media compare for no-fade repaints). */
	private lastPainted: Record<SurfaceId, ImageConfig | undefined | null> = {};
	private paintedOnce: Record<SurfaceId, boolean> = {};
	private fadeTimers: Record<SurfaceId, ReturnType<typeof setTimeout> | undefined> = {};
	/** Running WAAPI fade animations per LAYER ELEMENT id (cancelled on
	 * retarget so a newer switch can take over mid-fade). */
	private layerAnims = new Map<string, Animation | null>();
	/** Cached geometry signature per merged group (repaints on change). */
	private groupGeometryCache = new Map<SurfaceId, string>();
	/** A switch is in flight per surface (preload + crossfade). */
	private switching: Record<SurfaceId, boolean> = {};
	/** User-requested target index while a switch is in flight. */
	private pendingTarget: Record<SurfaceId, number | undefined> = {};
	/** Next image already prewarmed (half-interval lookahead). */
	private prewarmed: Record<SurfaceId, boolean> = {};
	/** Which surfaces' hosts exist right now. */
	private available: Record<SurfaceId, boolean> = {};
	/** Last painted merged-canvas geometry per group (slot -> slice, or null
	 * when no member was visible), so the observer can detect layout changes
	 * (tab switch, panel resize) that require recomputing the slices. */
	private lastGeometry = new Map<SurfaceId, Map<string, { w: number; h: number; dx: number; dy: number }> | null>();

	constructor(ctx: BackgroundCtx) {
		this.ctx = ctx;
		this.state = restoreState();
		this.refreshSurfaces();
		this.available = this.computeAvailability();
		this.snapshot = Object.freeze(this.buildSnapshot());
		ctx.effect(() => {
			this.applyDom();
			/* The plugin boots before the shell settles: #root still holds the
			 * loading screen, so column layers land on the wrong host. Watch the
			 * body, but ONLY re-anchor + re-paint when a layer is actually
			 * missing, on the wrong host, or misplaced — a full re-paint on
			 * every DOM churn would race the async file-media paints below. */
			let scheduled = false;
			const reapply = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					this.refreshSurfaces();
					let needsRepaint = false;
					for (const surface of this.surfaces) {
						for (const slot of this.surfaceSlots(surface)) {
							const host = slot.host;
							// Host not present yet (boot window, closed tab, closed
							// settings dialog): the availability sync reports it to
							// the UI — and the surface's on-marker must flip OFF,
							// or our transparency/lift CSS leaks onto whatever
							// unrelated dialog appears next.
							if (host === null) {
								this.markSlotGone(surface, slot.slot);
								continue;
							}
							if (!this.layersPlaced(surface, slot.slot, host)) {
								needsRepaint = true;
								break;
							}
							for (const which of [0, 1] as const) {
								const el = document.getElementById(this.layerId(surface, slot.slot, which));
								if (el === null || el.parentNode !== host) {
									needsRepaint = true;
									break;
								}
								if (surface === "sidebar" && slot.slot === "") {
									// Sidebar layers lead the column in fixed order
									// (a, then b, then content) — see ensureLayer.
									const lead = which === 0 ? null : document.getElementById(this.layerId(surface, "", 0));
									if (el.previousElementSibling !== (lead ?? null)) {
										needsRepaint = true;
										break;
									}
								}
							}
						}
						// Merged-canvas slices are px-anchored: a tab switch,
						// panel collapse or any layout change that moved a member
						// must recompute them (layers themselves stay in place,
						// so the checks above cannot see it).
						if (!needsRepaint && surface.startsWith("group:") && this.groupGeometryStale(surface)) {
							needsRepaint = true;
						}
					}
					if (this.syncAvailability()) needsRepaint = true;
					if (needsRepaint) this.applyDom();
				});
			};
			const observer = new MutationObserver(reapply);
			// childList catches hosts appearing/disappearing; the attribute
			// filter catches tab activation/panel resizes that flip
			// class/style/hidden without structural changes.
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
			const onResize = () => reapply();
			window.addEventListener?.("resize", onResize);
			const timer = setInterval(() => this.tick(), TICK_MS);
			return () => {
				clearInterval(timer);
				observer.disconnect();
				window.removeEventListener?.("resize", onResize);
				for (const surface of [...this.surfaces]) {
					for (const slot of this.surfaceSlots(surface)) {
						for (const which of [0, 1] as const) {
							this.cancelLayerFade(this.layerId(surface, slot.slot, which));
							this.removeLayer(surface, slot.slot, which);
						}
					}
					if (this.fadeTimers[surface] !== undefined) clearTimeout(this.fadeTimers[surface]);
				}
				for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
				this.objectUrls.clear();
				this.resetDom();
			};
		}, "background: DOM layers + slideshow timer");
	}

	/** Read the current immutable background snapshot. */
	getState(): BackgroundSnapshot {
		return this.snapshot;
	}

	/** Append image configs to a surface (non-empty additions enable it). A
	 * group holds ONE media kind: images switch like a slideshow, videos
	 * play — mixing the two is not supported. Mixed batches are filtered to
	 * the group's kind (an empty surface adopts the batch's kind, preferring
	 * images when the batch itself is mixed) and the skipped count is
	 * reported to the editor. */
	addImages(surface: SurfaceId, images: ImageConfig[]): AddImagesResult {
		this.ensureSurfaceRecords(surface);
		const cfg = this.cfgOf(surface);
		const valid = images.filter((img) =>
			(img.source === "url" && img.url !== "") || (img.source === "file" && img.fileId !== "")
		);
		if (valid.length === 0) return { added: 0, skipped: 0 };
		const existingKind = cfg.images.length > 0 ? cfg.images[0].media : undefined;
		const groupKind: MediaType = existingKind !== undefined
			? existingKind
			: (valid.some((img) => img.media === "image") ? "image" : "video");
		const accepted = valid.filter((img) => img.media === groupKind);
		const skipped = valid.length - accepted.length;
		if (accepted.length > 0) {
			cfg.images.push(...accepted.map((img) => ({ ...img })));
			cfg.enabled = true;
			this.publish();
		}
		return {
			added: accepted.length,
			skipped,
			skippedKind: skipped > 0 ? (groupKind === "image" ? "video" : "image") : undefined
		};
	}

	/** Remove one image from a surface (also drops its stored blob, if local). */
	removeImage(surface: SurfaceId, index: number): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined) return;
		if (index < 0 || index >= cfg.images.length) return;
		const [removed] = cfg.images.splice(index, 1);
		if (removed.source === "file" && !this.fileReferencedElsewhere(removed.fileId, surface)) {
			// Merged-group copies share one stored blob: deleting the bytes
			// here would break every other surface still referencing the file.
			deleteStoredFile(removed.fileId);
			this.revokeFileUrl(removed.fileId);
		}
		if (this.index[surface] >= cfg.images.length) this.index[surface] = cfg.images.length === 0 ? 0 : cfg.images.length - 1;
		if (cfg.images.length === 0) cfg.enabled = false;
		this.publish();
	}

	/** Patch one image's configuration (immutable update). */
	updateImage(surface: SurfaceId, index: number, patch: Partial<ImageConfig>): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined) return;
		if (index < 0 || index >= cfg.images.length) return;
		const img = cfg.images[index];
		const next: ImageConfig = { ...img, ...patch };
		next.scale = clamp(Number(next.scale) || 100, 10, 500);
		next.rotate = clamp(Number(next.rotate) || 0, -180, 180);
		next.radius = clamp(Number(next.radius) || 0, 0, 200);
		next.opacity = clamp(Number(next.opacity) || 0, 0, 1);
		next.blur = clamp(Number(next.blur) || 0, 0, 24);
		if (typeof next.posX !== "string") next.posX = img.posX;
		if (typeof next.posY !== "string") next.posY = img.posY;
		if (typeof next.width !== "string") next.width = img.width;
		if (typeof next.height !== "string") next.height = img.height;
		if (typeof next.name !== "string") next.name = img.name;
		if (next.media !== "image" && next.media !== "video") next.media = img.media;
		cfg.images[index] = next;
		this.publish();
	}

	/** Toggle a surface's background on/off. */
	setEnabled(surface: SurfaceId, enabled: boolean): void {
		const cfg = this.cfgOf(surface);
		if (cfg.enabled === enabled) return;
		cfg.enabled = enabled;
		this.elapsed[surface] = 0;
		this.publish();
	}

	/** Set the slideshow interval in seconds (0 stops playback). */
	setIntervalSec(surface: SurfaceId, seconds: number): void {
		const cfg = this.cfgOf(surface);
		const next = clamp(Number(seconds) || 0, 0, 3600);
		if (cfg.intervalSec === next) return;
		cfg.intervalSec = next;
		this.elapsed[surface] = 0;
		this.publish();
	}

	/** Toggle order vs random playback. */
	setRandom(surface: SurfaceId, random: boolean): void {
		const cfg = this.cfgOf(surface);
		if (cfg.random === random) return;
		cfg.random = random;
		this.elapsed[surface] = 0;
		this.publish();
	}

	/** Manually step to the next image. A single-image surface has no
	 * "next" — nothing switches, no fade fires (the UI disables the button
	 * too). */
	next(surface: SurfaceId): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined || cfg.images.length < 2) return;
		this.requestSwitch(surface);
	}

	/** Show a specific image (selecting a strip thumbnail previews it). */
	showImage(surface: SurfaceId, index: number): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined) return;
		if (index < 0 || index >= cfg.images.length) return;
		this.requestSwitch(surface, index);
	}

	/** Resolve an image's display URL. File images load lazily from IndexedDB
	 * into a cached object URL. */
	async displayUrlOf(img: ImageConfig): Promise<string> {
		if (img.source === "url") return img.url;
		const cached = this.objectUrls.get(img.fileId);
		if (cached !== undefined) return cached;
		try {
			const blob = await idbGetFile(img.fileId);
			if (blob === null) return "";
			const url = URL.createObjectURL(blob);
			this.objectUrls.set(img.fileId, url);
			return url;
		} catch {
			return "";
		}
	}

	/** Revoke (and forget) a local image's object URL. */
	revokeFileUrl(fileId: string): void {
		const url = this.objectUrls.get(fileId);
		if (url !== undefined) {
			URL.revokeObjectURL(url);
			this.objectUrls.delete(fileId);
		}
	}

	//#region surface discovery

	/** True when the element carries a CSS-module class whose local name
	 * ends with `suffix` (e.g. `_paneContent`). Hash prefixes vary per
	 * vscode-sidebar build, local names do not. */
	private hasClass(el: Element, suffix: string): boolean {
		for (const name of Array.from(el.classList)) {
			if (name.endsWith(suffix)) return true;
		}
		return false;
	}

	/** Resolve one vscode-sidebar panel host and mark it for the CSS. The
	 * panels are fixed-position direct children of the plugin's mount host
	 * ([data-dsh-plugin-vscode-sidebar] on body): the right panel carries an
	 * inline width, the bottom panel an inline height. Returns null while
	 * that plugin is absent. */
	private sidebarPanelHost(kind: "right" | "bottom"): HTMLElement | null {
		const host = document.querySelector("[data-dsh-plugin-vscode-sidebar]");
		if (!(host instanceof HTMLElement)) return null;
		for (const child of Array.from(host.children)) {
			if (!(child instanceof HTMLElement)) continue;
			const widthSet = child.style.width !== "" && child.style.width !== undefined;
			const heightSet = child.style.height !== "" && child.style.height !== undefined;
			if (kind === "bottom" && heightSet) {
				child.setAttribute("data-dsh-bg-panel", "bottom");
				return child;
			}
			if (kind === "right" && widthSet && !heightSet) {
				child.setAttribute("data-dsh-bg-panel", "right");
				return child;
			}
		}
		return null;
	}

	/** Discover every vscode-sidebar tab surface: for each pane, the tab-bar
	 * items (in order) name the pane's content divs (same order — both render
	 * pane.tabs in order), so tab i's content div hosts the surface
	 * `panel-<kind>:<tabTitle>`. Content divs get tagged with
	 * `data-dshbg-tab-surface` for the CSS. Tab items are looked up ONLY
	 * inside the pane's tab bar (class suffix `_tabBar`) — tab CONTENT can
	 * carry its own title-bearing elements, which must never pollute the
	 * naming. */
	private discoverTabSurfaces(): Map<SurfaceId, { host: HTMLElement; label: string }> {
		const out = new Map<SurfaceId, { host: HTMLElement; label: string }>();
		for (const kind of ["right", "bottom"] as const) {
			const panel = this.sidebarPanelHost(kind);
			if (panel === null) continue;
			const panes: HTMLElement[] = [];
			for (const el of panel.querySelectorAll("*")) {
				if (el instanceof HTMLElement && this.hasClass(el, "_paneContent")) panes.push(el);
			}
			for (const pane of panes) {
				const paneEl = pane.parentElement;
				const tabItems: HTMLElement[] = [];
				if (paneEl instanceof HTMLElement) {
					for (const el of paneEl.querySelectorAll("[title]")) {
						if (el instanceof HTMLElement && this.hasClass(el, "_tab") && this.insideTabBar(el)) {
							tabItems.push(el);
						}
					}
				}
				let i = 0;
				for (const child of Array.from(pane.children)) {
					if (!(child instanceof HTMLElement) || !this.hasClass(child, "_paneTab")) continue;
					const title = tabItems[i]?.getAttribute("title") ?? "";
					i += 1;
					if (title === "") continue;
					const key: SurfaceId = `panel-${kind}:${title}`;
					child.setAttribute("data-dshbg-tab-surface", key);
					out.set(key, { host: child, label: title });
				}
			}
		}
		return out;
	}

	/** True when the element sits inside a tab bar (an ancestor carries a
	 * class whose local name ends with `_tabBar`). */
	private insideTabBar(el: HTMLElement): boolean {
		let node: HTMLElement | null = el;
		while (node !== null && node !== document.body) {
			if (this.hasClass(node, "_tabBar")) return true;
			node = node.parentElement;
		}
		return false;
	}

	/** Rebuild the current surface set from the built-in areas plus the
	 * discovered vscode-sidebar panels and tabs. Returns whether the set
	 * changed. */
	private refreshSurfaces(): boolean {
		const found = this.discoverTabSurfaces();
		const next = new Set<SurfaceId>(AREAS as readonly string[]);
		// Whole-panel surfaces exist whenever their panel host is mounted
		// (the vscode-sidebar keeps panels mounted even while collapsed).
		for (const panel of ["panel-right", "panel-bottom"] as const) {
			if (this.sidebarPanelHost(panel === "panel-right" ? "right" : "bottom") !== null) next.add(panel);
		}
		for (const key of found.keys()) next.add(key);
		for (const group of this.state.groups) next.add(group.id);
		let changed = next.size !== this.surfaces.size;
		if (!changed) {
			for (const surface of next) {
				if (!this.surfaces.has(surface)) {
					changed = true;
					break;
				}
			}
		}
		this.surfaces = next;
		this.tabHosts = new Map();
		this.tabLabels = new Map();
		for (const [key, entry] of found) {
			this.tabHosts.set(key, entry.host);
			this.tabLabels.set(key, entry.label);
		}
		return changed;
	}

	/** Every surface the snapshot should carry: the ones present now plus any
	 * persisted config (a closed tab keeps its config visible — grayed in
	 * the UI — so it can be edited or cleaned up before the tab reopens). */
	private allSurfaces(): Set<SurfaceId> {
		return new Set([...this.surfaces, ...Object.keys(this.state.areas)]);
	}

	/** Current availability of every surface's host. */
	private computeAvailability(): Record<SurfaceId, boolean> {
		const rec: Record<SurfaceId, boolean> = {};
		for (const surface of this.allSurfaces()) {
			if (surface.startsWith("group:")) {
				rec[surface] = this.surfaceSlots(surface).some((slot) => slot.host !== null);
			} else if (isTabSurface(surface)) {
				rec[surface] = this.tabHosts.has(surface);
			} else if (isPanelSurface(surface)) {
				rec[surface] = this.areaHost(surface) !== null;
			} else {
				rec[surface] = true;
			}
		}
		return rec;
	}

	/** Re-check availability and republish the snapshot when the set changed
	 * (vscode-sidebar tabs come and go without any state change). Returns
	 * whether the availability changed (callers may need a repaint). */
	private syncAvailability(): boolean {
		const next = this.computeAvailability();
		let changed = false;
		for (const surface of this.allSurfaces()) {
			if (this.available[surface] !== next[surface]) {
				changed = true;
				break;
			}
		}
		if (!changed) return false;
		this.available = next;
		this.snapshot = Object.freeze(this.buildSnapshot());
		this.ctx.emit("background/change", this.snapshot);
		return true;
	}

	/** The persisted config of a surface, created on first touch. */
	private cfgOf(surface: SurfaceId): AreaConfig {
		let cfg = this.state.areas[surface];
		if (cfg === undefined) {
			cfg = { ...DEFAULT_AREA, images: [] };
			this.state.areas[surface] = cfg;
		}
		return cfg;
	}

	/** Lazily create a surface's runtime playback records. */
	private ensureSurfaceRecords(surface: SurfaceId): void {
		if (this.index[surface] !== undefined) return;
		this.index[surface] = 0;
		this.elapsed[surface] = 0;
		this.activeLayer[surface] = 0;
		this.lastPainted[surface] = null;
		this.paintedOnce[surface] = false;
		this.fadeTimers[surface] = undefined;
		this.switching[surface] = false;
		this.pendingTarget[surface] = undefined;
		this.prewarmed[surface] = false;
	}

	//#endregion

	//#region playback + preloaded switching

	/** Preload a media's bytes AND ready state (so switching never shows a
	 * gap): images decode through an Image element, videos reach canplay
	 * through a detached muted video element. */
	private preload(img: ImageConfig): Promise<boolean> {
		return this.displayUrlOf(img).then((url) => {
			if (url === "") return false;
			const existing = this.preloadCache.get(url);
			if (existing !== undefined) return existing;
			const promise = new Promise<boolean>((resolve) => {
				if (img.media === "video") {
					const video = document.createElement("video");
					video.muted = true;
					video.preload = "auto";
					video.addEventListener("canplay", () => resolve(true), { once: true });
					video.addEventListener("error", () => resolve(false), { once: true });
					video.src = url;
				} else {
					const image = new Image();
					image.onload = () => resolve(true);
					image.onerror = () => resolve(false);
					image.src = url;
				}
			});
			this.preloadCache.set(url, promise);
			return promise;
		});
	}

	/** Prewarm the next image half an interval early (bytes + ready cache). */
	private prewarm(surface: SurfaceId): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined || !cfg.enabled || cfg.images.length < 2) return;
		const nextIndex = this.nextIndex(surface, cfg.images.length);
		void this.preload(cfg.images[nextIndex]);
	}

	/** Compute the next playback index (order or random). */
	private nextIndex(surface: SurfaceId, count: number): number {
		const cfg = this.state.areas[surface];
		if (count < 2) return 0;
		if (cfg.random) {
			let pick: number;
			do {
				pick = Math.floor(Math.random() * count);
			} while (pick === this.index[surface] && count > 1);
			return pick;
		}
		return (this.index[surface] + 1) % count;
	}

	/** Queue a switch (to a specific image, or the next one). */
	private requestSwitch(surface: SurfaceId, targetIndex?: number): void {
		this.pendingTarget[surface] = targetIndex ?? this.pendingTarget[surface];
		if (!this.switching[surface]) void this.performSwitch(surface);
	}

	/** Preload the target media, then commit the index (crossfade lands via
	 * publish → applyArea). Waits for the load even past the scheduled time;
	 * a failed load keeps the current image until the next attempt. */
	private async performSwitch(surface: SurfaceId): Promise<void> {
		if (this.switching[surface]) return;
		this.switching[surface] = true;
		try {
			while (true) {
				const target = this.pendingTarget[surface];
				this.pendingTarget[surface] = undefined;
				const cfg = this.state.areas[surface];
				if (cfg === undefined || !cfg.enabled || cfg.images.length === 0) break;
				const nextIndex = target !== undefined ? target : this.nextIndex(surface, cfg.images.length);
				if (nextIndex === this.index[surface] && target === undefined) break;
				const ok = await this.preload(cfg.images[nextIndex]);
				if (!ok) break; // media unavailable: stay on the current one
				if (this.index[surface] !== nextIndex) {
					this.index[surface] = nextIndex;
					this.elapsed[surface] = 0;
					this.prewarmed[surface] = false;
					this.publish(); // → applyDom → applyArea → crossfade
				}
				if (this.pendingTarget[surface] === undefined) break;
			}
		} finally {
			this.switching[surface] = false;
		}
	}

	/** Slideshow heartbeat: prewarm at half interval, switch at the interval
	 * (the switch itself waits for the preload — the interval may overrun).
	 * Merged groups also re-check their canvas geometry here: when members
	 * moved or resized, the slices repaint so the shared image stays
	 * continuous (dragging only mutates inline styles — no DOM churn). */
	private tick(): void {
		for (const surface of this.surfaces) {
			const cfg = this.state.areas[surface];
			if (surface.startsWith("group:") && cfg !== undefined && cfg.enabled && cfg.images.length > 0) {
				this.refreshGroupGeometry(surface);
			}
			if (cfg === undefined || !cfg.enabled || cfg.images.length < 2 || cfg.intervalSec <= 0) continue;
			this.elapsed[surface] += TICK_MS;
			if (this.elapsed[surface] >= cfg.intervalSec * 500 && !this.prewarmed[surface]) {
				this.prewarmed[surface] = true;
				this.prewarm(surface);
			}
			if (this.elapsed[surface] >= cfg.intervalSec * 1000) {
				this.elapsed[surface] = 0;
				this.prewarmed[surface] = false;
				this.requestSwitch(surface);
			}
		}
	}

	/** Repaint a merged group when its member rectangles moved (canvas
	 * geometry changed since the last paint). */
	private refreshGroupGeometry(surface: SurfaceId): void {
		const geometry = this.groupGeometryOf(surface);
		if (geometry === null) return;
		const signature = [...geometry.entries()].map(([slot, g]) => `${slot}:${g.w},${g.h},${g.dx},${g.dy}`).join("|");
		if (this.groupGeometryCache.get(surface) === signature) return;
		this.groupGeometryCache.set(surface, signature);
		void this.applyArea(surface);
	}

	/** Merge several standalone surfaces into one logical surface: the
	 * shared media paints across every member as a single continuous canvas
	 * (multi-monitor wallpaper strategy). Members keep their own configs but
	 * stop painting on their own while merged. */
	mergeSurfaces(members: SurfaceId[]): SurfaceId | null {
		const valid = members.filter((member) =>
			!member.startsWith("group:")
			&& !this.state.groups.some((g) => g.members.includes(member))
			&& ((AREAS as readonly string[]).includes(member as (typeof AREAS)[number]) || isTabSurface(member) || isPanelSurface(member))
		);
		if (valid.length < 2) return null;
		let n = 0;
		for (const group of this.state.groups) {
			const match = group.id.match(/^group:(\d+)$/);
			if (match !== null) n = Math.max(n, Number(match[1]));
		}
		const id: SurfaceId = `group:${n + 1}`;
		this.state.groups = [...this.state.groups, { id, members: [...valid] }];
		this.cfgOf(id);
		// The group owns the members while merged: their own backgrounds stop
		// painting (their configs stay for the unmerge fallback).
		for (const member of valid) this.cfgOf(member).enabled = false;
		this.publish();
		return id;
	}

	/** Add one standalone surface to an existing merged group (dragging a
	 * row onto a group row). The newcomer stops painting on its own; its own
	 * config is kept for when it leaves again. Group entries are replaced
	 * immutably — the members array must never be mutated in place (it may
	 * have been frozen through snapshot sharing). */
	addMemberToGroup(groupId: SurfaceId, member: SurfaceId): void {
		const at = this.state.groups.findIndex((g) => g.id === groupId);
		if (at === -1) return;
		if (member.startsWith("group:")) return;
		const group = this.state.groups[at];
		if (group.members.includes(member)) return;
		if (this.state.groups.some((g) => g.members.includes(member))) return;
		this.state.groups = [
			...this.state.groups.slice(0, at),
			{ id: group.id, members: [...group.members, member] },
			...this.state.groups.slice(at + 1)
		];
		this.cfgOf(member).enabled = false;
		this.publish();
	}

	/** Remove one member from a merged group (chip × or drag-out). The
	 * member goes back to its own pre-merge config; a group that drops below
	 * two members dissolves — the last member inherits the group's media
	 * (the shared canvas no longer spans anything). */
	removeMemberFromGroup(groupId: SurfaceId, member: SurfaceId): void {
		const at = this.state.groups.findIndex((g) => g.id === groupId);
		if (at === -1) return;
		const group = this.state.groups[at];
		if (!group.members.includes(member)) return;
		const members = group.members.filter((m) => m !== member);
		this.state.groups = [
			...this.state.groups.slice(0, at),
			{ id: group.id, members },
			...this.state.groups.slice(at + 1)
		];
		// The group no longer paints this member: its slice layers must go
		// NOW — an orphaned slice keeps the group's media on top of the
		// member's own layers and resurfaces when the member's images are
		// later deleted.
		this.removeSliceLayers(groupId, member);
		const own = this.state.areas[member];
		if (own !== undefined) own.enabled = own.images.length > 0;
		if (members.length < 2) {
			// Dissolve: the last member keeps the group's media.
			this.removeSurfaceLayers(groupId);
			this.state.groups = this.state.groups.filter((g) => g.id !== groupId);
			this.lastGeometry.delete(groupId);
			const cfg = this.state.areas[groupId];
			if (cfg !== undefined && members.length === 1) {
				const last = this.cfgOf(members[0]);
				last.images = cfg.images.map((img) => ({ ...img }));
				last.enabled = cfg.enabled;
				last.intervalSec = cfg.intervalSec;
				last.random = cfg.random;
			}
			delete this.state.areas[groupId];
		}
		this.publish();
	}

	/** Clear a surface's media entirely (also drops stored local blobs). */
	clearSurface(surface: SurfaceId): void {
		const cfg = this.state.areas[surface];
		if (cfg === undefined || cfg.images.length === 0) return;
		for (const img of cfg.images) {
			if (img.source === "file" && !this.fileReferencedElsewhere(img.fileId, surface)) {
				deleteStoredFile(img.fileId);
				this.revokeFileUrl(img.fileId);
			}
		}
		cfg.images = [];
		cfg.enabled = false;
		this.index[surface] = 0;
		this.elapsed[surface] = 0;
		this.publish();
	}

	/** Whether another surface's config still references a local file id
	 * (merged groups copy configs between members, so one stored blob can be
	 * shared by several surfaces). */
	private fileReferencedElsewhere(fileId: string, except: SurfaceId): boolean {
		for (const [surface, cfg] of Object.entries(this.state.areas)) {
			if (surface === except) continue;
			if (cfg.images.some((img) => img.source === "file" && img.fileId === fileId)) return true;
		}
		return false;
	}

	/** Dissolve a merged group: the group's media lands on every member
	 * (each becomes standalone again with its own copy). */
	unmerge(groupId: SurfaceId): void {
		const group = this.state.groups.find((g) => g.id === groupId);
		if (group === undefined) return;
		// The group's slice layers must go BEFORE the group leaves the state:
		// surfaceSlots() reads state.groups, and leftover layers would keep
		// painting the shared media over the members' own backgrounds.
		this.removeSurfaceLayers(groupId);
		this.state.groups = this.state.groups.filter((g) => g.id !== groupId);
		this.lastGeometry.delete(groupId);
		const cfg = this.state.areas[groupId];
		if (cfg !== undefined) {
			for (const member of group.members) {
				const memberCfg = this.cfgOf(member);
				memberCfg.images = cfg.images.map((img) => ({ ...img }));
				memberCfg.enabled = cfg.enabled;
				memberCfg.intervalSec = cfg.intervalSec;
				memberCfg.random = cfg.random;
			}
			delete this.state.areas[groupId];
		}
		this.publish();
	}

	/** Remove a surface's entire layer pair set (fade animations included).
	 * A dissolved/removed merged group must not leave slice layers behind:
	 * they sit inside the member hosts with the shared media painted and
	 * would resurface the moment the member's own layers are cleared. */
	private removeSurfaceLayers(surface: SurfaceId): void {
		for (const slot of this.surfaceSlots(surface)) {
			this.removeSliceLayers(surface, slot.slot);
		}
		if (this.fadeTimers[surface] !== undefined) {
			clearTimeout(this.fadeTimers[surface]);
			this.fadeTimers[surface] = undefined;
		}
	}

	/** Remove ONE member's slice layers of a group (member left the group
	 * but the group itself lives on). `slot` is the member's surface token
	 * (the slot key the group painted under). */
	private removeSliceLayers(groupId: SurfaceId, member: SurfaceId): void {
		const slot = surfaceToken(member);
		for (const which of [0, 1] as const) {
			this.cancelLayerFade(this.layerId(groupId, slot, which));
			this.removeLayer(groupId, slot, which);
		}
	}

	/** Current image config for a surface (undefined when off or unset). */
	currentImage(surface: SurfaceId): ImageConfig | undefined {
		const cfg = this.state.areas[surface];
		if (cfg === undefined || !cfg.enabled || cfg.images.length === 0) return undefined;
		return cfg.images[this.index[surface] % cfg.images.length];
	}

	//#endregion

	//#region publish / snapshot

	private publish(): void {
		this.revision += 1;
		if (!persistState(this.state)) this.lastError = "quota";
		else this.lastError = null;
		// Refresh the surface set BEFORE snapshotting: a just-dissolved group
		// (or a just-created one) must not leak a stale default entry into
		// the snapshot.
		this.refreshSurfaces();
		this.snapshot = Object.freeze(this.buildSnapshot());
		this.applyDom();
		this.ctx.emit("background/change", this.snapshot);
	}

	/** Immutable snapshot: per-surface config + playback index + metadata.
	 * Images are deep-copied — the settings store's immer updates freeze
	 * whatever they receive, which must never be the live service state. */
	private buildSnapshot(): BackgroundSnapshot {
		const areas = {} as BackgroundSnapshot["areas"];
		const index = {} as BackgroundSnapshot["index"];
		const meta = {} as BackgroundSnapshot["meta"];
		for (const surface of this.allSurfaces()) {
			const cfg = this.state.areas[surface] ?? { ...DEFAULT_AREA, images: [] };
			areas[surface] = {
				...cfg,
				images: cfg.images.map((img) => ({ ...img }))
			};
			index[surface] = this.index[surface] ?? 0;
			meta[surface] = this.metaOf(surface);
		}
		return {
			areas,
			index,
			meta,
			groups: this.state.groups.map((g) => ({ id: g.id, members: [...g.members] })),
			lastError: this.lastError,
			revision: this.revision
		};
	}

	/** Display metadata of a surface. */
	private metaOf(surface: SurfaceId): SurfaceMeta {
		if (surface.startsWith("group:")) {
			const group = this.state.groups.find((g) => g.id === surface);
			return {
				label: "group",
				group: "group",
				available: this.available[surface] ?? false,
				// Copy: the snapshot reaches the settings store, whose immer
				// deep-freezes everything it touches — a shared live array
				// here would freeze the service's own group.members and break
				// every later push/splice ("object is not extensible").
				members: group !== undefined ? [...group.members] : []
			};
		}
		const memberOf = this.state.groups.find((g) => g.members.includes(surface))?.id;
		if (surface.startsWith("panel-right:")) {
			return { label: this.tabLabels.get(surface) ?? surface.slice("panel-right:".length), group: "panel-right", available: this.available[surface] ?? false, memberOf };
		}
		if (surface.startsWith("panel-bottom:")) {
			return { label: this.tabLabels.get(surface) ?? surface.slice("panel-bottom:".length), group: "panel-bottom", available: this.available[surface] ?? false, memberOf };
		}
		if (isPanelSurface(surface)) {
			return { label: surface, group: surface === "panel-right" ? "panel-right" : "panel-bottom", available: this.available[surface] ?? false, memberOf };
		}
		return { label: surface, group: "builtin", available: true, memberOf };
	}

	//#endregion

	//#region DOM projection (layer pairs + crossfade)

	/** One projection slot: a (host, key) pair. Non-group surfaces have one
	 * slot (empty key); merged groups have one slot PER member surface — the
	 * same media paints on every member as a slice of the shared canvas. */
	private surfaceSlots(surface: SurfaceId): Array<{ slot: string; host: HTMLElement | null }> {
		if (!surface.startsWith("group:")) {
			return [{ slot: "", host: this.areaHost(surface) }];
		}
		const group = this.state.groups.find((g) => g.id === surface);
		if (group === undefined) return [];
		const slots: Array<{ slot: string; host: HTMLElement | null }> = [];
		for (const member of group.members) {
			if (member.startsWith("group:")) continue; // nested groups are never created
			slots.push({ slot: surfaceToken(member), host: this.areaHost(member) });
		}
		return slots;
	}

	private layerId(surface: SurfaceId, slot: string, which: LayerIndex): string {
		const token = surfaceToken(surface);
		const suffix = which === 0 ? "a" : "b";
		return slot === "" ? `dsh-bg-layer-${token}-${suffix}` : `dsh-bg-layer-${token}-${slot}-${suffix}`;
	}

	/** Whether the host's children satisfy the placement invariant: the
	 * sidebar's own layers lead the column; every other layer trails it. */
	private layersPlaced(surface: SurfaceId, slot: string, host: HTMLElement): boolean {
		const leads = surface === "sidebar" && slot === "";
		let sawLayer = false;
		let sawContent = false;
		for (const child of Array.from(host.children)) {
			const isLayer = (child as HTMLElement).id?.startsWith("dsh-bg-layer") ?? false;
			if (isLayer) sawLayer = true;
			else sawContent = true;
			// lead: a layer after content is wrong; trail: content after a layer is wrong
			if (isLayer ? leads && sawContent : !leads && sawLayer) return false;
		}
		return true;
	}

	/** The DOM host a surface's layers mount into. */
	private areaHost(surface: SurfaceId): HTMLElement | null {
		if (isTabSurface(surface)) return this.tabHosts.get(surface) ?? null;
		if (isPanelSurface(surface)) return this.sidebarPanelHost(surface === "panel-right" ? "right" : "bottom");
		switch (surface) {
			case "sidebar": {
				// The column is the settings trigger's ancestor whose parent
				// holds the conversation surface. Slot outlets are wrapped in
				// display:contents divs, so structural selectors are off by
				// one — the climb works at any wrapper depth.
				const trigger = document.querySelector('button[aria-haspopup="dialog"]');
				const scroll = document.querySelector("[data-conversation-scroll]");
				let node = trigger?.parentElement ?? null;
				while (node instanceof HTMLElement && node !== document.body) {
					const parent = node.parentElement;
					if (parent instanceof HTMLElement && scroll !== null && parent.contains(scroll)) return node;
					node = parent;
				}
				return null;
			}
			case "conversation":
				// [data-conversation-scroll] is a direct child of the surface
				// root; mount the layers on that root so the background stays
				// fixed while the messages scroll.
				return document.querySelector("[data-conversation-scroll]")?.parentElement ?? null;
			case "trajectory":
				return document.querySelector("[data-conversation-composer-overlay]");
			case "settings":
				// Only the settings PANEL counts: it carries aria-labelledby,
				// while the harness Modal primitive (used by vscode-sidebar's
				// gear dialogs and others) carries aria-label — the settings
				// background must not flip onto a transient modal.
				return document.querySelector('[role="dialog"][aria-modal="true"][aria-labelledby]');
			default:
				return null;
		}
	}

	/** Create (or re-anchor) one layer element for a surface. Layers sit at
	 * the END of their host; the sidebar is the exception — its layers LEAD
	 * the column (a, then b, then content) so tree order alone (content
	 * position:relative, z auto) keeps content above the wallpaper without
	 * a z-index that would trap the settings dialog inside the wrapper. */
	private ensureLayer(surface: SurfaceId, slot: string, which: LayerIndex): HTMLElement {
		const id = this.layerId(surface, slot, which);
		const host = this.surfaceSlots(surface).find((candidate) => candidate.slot === slot)?.host ?? null;
		let el = document.getElementById(id) as HTMLElement | null;
		if (el === null) {
			el = document.createElement("div");
			el.id = id;
			el.setAttribute("aria-hidden", "true");
		}
		if (surface.startsWith("group:")) {
			// Group slices clip to their member (the canvas slice may extend
			// beyond the member's bounds).
			el.className = "dshbg-slice";
		}
		if (host !== null) {
			if (surface === "sidebar" && slot === "") {
				const lead = which === 0 ? null : document.getElementById(this.layerId(surface, "", 0));
				if (el.parentNode !== host || el.previousElementSibling !== (lead ?? null)) {
					const oldParent = el.parentNode;
					if (oldParent instanceof HTMLElement && oldParent !== host) oldParent.removeAttribute("data-dshbg-sidebar-host");
					host.insertBefore(el, lead !== null ? lead.nextSibling : host.firstChild);
				}
				// CSS matches the host via this marker (structural selectors are
				// off by one behind the shell's slot wrappers).
				host.setAttribute("data-dshbg-sidebar-host", "");
			} else if (el.parentNode !== host) {
				host.appendChild(el);
			} else if (host.lastElementChild !== el) {
				host.appendChild(el);
			}
		}
		return el;
	}

	private removeLayer(surface: SurfaceId, slot: string, which: LayerIndex): void {
		document.getElementById(this.layerId(surface, slot, which))?.remove();
	}

	private resetDom(): void {
		const root = document.documentElement;
		for (const surface of this.surfaces) {
			root.removeAttribute(`data-dsh-bg-${surfaceToken(surface)}`);
		}
		for (const host of Array.from(document.querySelectorAll("[data-dshbg-sidebar-host]"))) {
			host.removeAttribute("data-dshbg-sidebar-host");
		}
		for (const host of Array.from(document.querySelectorAll("[data-dshbg-tab-surface]"))) {
			host.removeAttribute("data-dshbg-tab-on");
		}
	}

	/** Project all surfaces onto the DOM (async crossfade paints). */
	applyDom(): void {
		this.refreshSurfaces();
		for (const surface of this.surfaces) {
			this.ensureSurfaceRecords(surface);
			for (const slot of this.surfaceSlots(surface)) {
				this.ensureLayer(surface, slot.slot, 0);
				this.ensureLayer(surface, slot.slot, 1);
			}
			void this.applyArea(surface);
		}
		this.syncAvailability();
	}

	/** Two configs denote the same media (no switch, no fade between them). */
	private sameMedia(a: ImageConfig | undefined | null, b: ImageConfig | undefined): boolean {
		if (a === undefined || a === null || b === undefined) return false;
		return a.url === b.url && a.fileId === b.fileId && a.media === b.media;
	}

	/** One surface's projection: when the target media changed, crossfade to
	 * it (incoming layers fade in while the outgoing ones fade out); when it
	 * is the same media (single-image surfaces, per-image render tweaks),
	 * repaint in place without any fade. A merged group paints EVERY member
	 * slot with the same media: the group canvas is the bounding box of the
	 * member rectangles and each member shows its slice (multi-monitor
	 * wallpaper strategy), so the image reads as ONE continuous picture. */
	private async applyArea(surface: SurfaceId): Promise<void> {
		const target = this.currentImage(surface);
		if (this.sameMedia(this.lastPainted[surface], target)) {
			this.lastPainted[surface] = target !== undefined ? { ...target } : null;
			// Same media = no crossfade — but the markers still need
			// refreshing: a host blip (settings dialog closed, vscode-sidebar
			// panel restructure) or an availability-triggered repaint may have
			// flipped a member marker off, and nothing else re-enables the
			// shell transparency CSS (a missing marker = opaque content over
			// the layers, e.g. the composer's black fade band).
			this.markSurfaceOn(surface, target !== undefined);
			if (this.fadeTimers[surface] !== undefined) {
				// A crossfade to this very media is in flight. If the layer
				// pairs survived, the fade already delivers it — repainting the
				// outgoing layers here would clobber the fade with an instant
				// full-opacity paint. If the layers were re-created meanwhile
				// (session/view switch destroyed the host), the fade cannot
				// settle on the new elements: cancel it and restore directly.
				if (this.layerPairsHealthy(surface)) return;
				clearTimeout(this.fadeTimers[surface]);
				this.fadeTimers[surface] = undefined;
			}
			this.refreshActiveLayer(surface);
			return;
		}
		// URL media resolve synchronously (gate + paint land immediately);
		// file media resolve from IndexedDB asynchronously.
		const url = target !== undefined && target.source === "url"
			? target.url
			: (target !== undefined ? await this.displayUrlOf(target) : "");
		if (this.currentImage(surface) !== target) return; // target changed meanwhile
		this.lastPainted[surface] = target !== undefined ? { ...target } : null;
		// A member of a merged group does NOT own its marker: the group's
		// markSurfaceOn paints every member slot. Flipping the member off
		// here (its own config is disabled while merged) would fight the
		// group's ON marker and leave the member's shell opaque.
		if (!this.isGroupMember(surface)) this.markSurfaceOn(surface, url !== "");
		const prev = this.activeLayer[surface];
		const next: LayerIndex = prev === 0 ? 1 : 0;
		if (!this.paintedOnce[surface]) {
			// First paint: show directly, no animation.
			this.paintSlots(surface, next, url, target, 1);
			this.fadeSlots(surface, prev, 0);
			this.activeLayer[surface] = next;
			this.paintedOnce[surface] = true;
			return;
		}
		// Crossfade: stage the incoming layers' media at fade 0, then fade
		// them in while the outgoing layers fade out (keeping their media
		// until settled). The fade is driven by the Web Animations API.
		const incomingFrom = this.currentLayerOpacity(surface, this.surfaceSlots(surface)[0]?.slot ?? "", next); // read before staging (retarget continuity)
		this.paintSlots(surface, next, url, target, 0);
		this.fadeSlots(surface, next, target !== undefined ? clamp(target.opacity, 0, 1) : 0, incomingFrom);
		this.fadeSlots(surface, prev, 0);
		if (this.fadeTimers[surface] !== undefined) clearTimeout(this.fadeTimers[surface]);
		this.fadeTimers[surface] = setTimeout(() => {
			this.fadeTimers[surface] = undefined;
			if (!this.layerPairsHealthy(surface)) {
				// The layer pairs were re-created while the fade ran: the fade
				// cannot settle on the new elements. Repaint the active layers
				// directly (the playback index already advanced, so the
				// current image is exactly the fade target).
				this.refreshActiveLayer(surface);
				return;
			}
			this.activeLayer[surface] = next;
			this.cleanupSlots(surface, prev);
			this.ensureActiveFade(surface);
			// A layout change (tab switch, resize) mid-fade left the slices
			// stale while applyArea had to stand down — refresh them now.
			if (surface.startsWith("group:") && this.groupGeometryStale(surface)) {
				this.refreshActiveLayer(surface);
			}
		}, FADE_SETTLE_MS);
	}

	/** A slot whose host disappeared (closed tab, closed settings dialog):
	 * flip its markers off so the transparency/lift CSS never leaks onto
	 * unrelated elements. Tab markers died with their host element; built-in
	 * member markers live on <html> and must be cleared explicitly. */
	private markSlotGone(surface: SurfaceId, slot: string): void {
		if (surface.startsWith("group:")) {
			if (slot !== "" && !slot.startsWith("tab-")) {
				document.documentElement.setAttribute(`data-dsh-bg-${slot}`, "off");
			}
			return;
		}
		this.markSurfaceOn(surface, false);
	}

	/** True when a merged group's painted slices no longer match the current
	 * member rects (tabs switched, panels resized, window resized). */
	private groupGeometryStale(surface: SurfaceId): boolean {
		const last = this.lastGeometry.get(surface);
		const now = this.groupGeometryOf(surface);
		if (now === null) return last !== undefined && last !== null;
		if (last === undefined || last === null) return true;
		if (now.size !== last.size) return true;
		for (const [slot, g] of now) {
			const l = last.get(slot);
			if (l === undefined) return true;
			if (Math.abs(l.w - g.w) > 1 || Math.abs(l.h - g.h) > 1 || Math.abs(l.dx - g.dx) > 1 || Math.abs(l.dy - g.dy) > 1) return true;
		}
		return false;
	}

	/** True when the surface currently belongs to a merged group. */
	private isGroupMember(surface: SurfaceId): boolean {
		return this.state.groups.some((g) => g.members.includes(surface));
	}

	/** Set the on/off markers of a surface's members (built-in members use
	 * the html data attribute their transparency CSS keys on; tab members
	 * use the per-host data-dshbg-tab-on marker). A surface whose host is
	 * GONE (closed tab, closed settings dialog) is marked OFF — stale marks
	 * would otherwise leak our transparency/lift CSS onto unrelated
	 * dialogs/surfaces and confuse the page's stacking. */
	private markSurfaceOn(surface: SurfaceId, on: boolean): void {
		const token = surfaceToken(surface);
		const slots = this.surfaceSlots(surface);
		if (!surface.startsWith("group:")) {
			const host = slots[0]?.host ?? null;
			const effective = on && host !== null;
			document.documentElement.setAttribute(`data-dsh-bg-${token}`, effective ? "on" : "off");
			if (isTabSurface(surface)) {
				if (host instanceof HTMLElement) {
					if (effective) host.setAttribute("data-dshbg-tab-on", "true");
					else host.removeAttribute("data-dshbg-tab-on");
				}
			} else if (isPanelSurface(surface)) {
				if (host instanceof HTMLElement) {
					if (effective) host.setAttribute("data-dshbg-panel-on", "true");
					else host.removeAttribute("data-dshbg-panel-on");
				}
			}
			return;
		}
		document.documentElement.setAttribute(`data-dsh-bg-${token}`, on ? "on" : "off");
		for (const slot of slots) {
			if (slot.host === null) {
				// Closed dialog/tab/panel member: clear the built-in member
				// marker (host markers died with their element).
				if (slot.slot !== "" && !slot.slot.startsWith("tab-")) {
					document.documentElement.setAttribute(`data-dsh-bg-${slot.slot}`, "off");
				}
				continue;
			}
			if (slot.slot.startsWith("tab-") && slot.host instanceof HTMLElement) {
				if (on) slot.host.setAttribute("data-dshbg-tab-on", "true");
				else slot.host.removeAttribute("data-dshbg-tab-on");
			} else if (slot.slot === "panel-right" || slot.slot === "panel-bottom") {
				// Whole-panel member: mark the panel host itself.
				if (on) slot.host.setAttribute("data-dshbg-panel-on", "true");
				else slot.host.removeAttribute("data-dshbg-panel-on");
			} else {
				// built-in member: its own transparency CSS keys on the
				// member's data attribute
				document.documentElement.setAttribute(`data-dsh-bg-${slot.slot}`, on ? "on" : "off");
			}
		}
	}

	/** The merged canvas geometry: bounding box of the member rectangles,
	 * and per member the slice offsets (negative, so the shared image lines
	 * up across members). Null for non-group surfaces. */
	private groupGeometryOf(surface: SurfaceId): Map<string, { w: number; h: number; dx: number; dy: number }> | null {
		if (!surface.startsWith("group:")) return null;
		// The vscode-sidebar bottom panel overlays the bottom of the center
		// column: members it covers must not contribute their hidden strip to
		// the canvas, or the picture reads as misaligned between surfaces.
		let bottomTop: number | null = null;
		const bottomPanel = this.sidebarPanelHost("bottom");
		if (bottomPanel !== null) {
			const r = bottomPanel.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) bottomTop = r.top;
		}
		const entries: Array<{ slot: string; rect: DOMRect }> = [];
		for (const slot of this.surfaceSlots(surface)) {
			if (slot.host === null) continue;
			// Closed vscode-sidebar panels stay mounted but hidden via
			// visibility + transform: they still report a (translated) rect —
			// including them would stretch the canvas off-screen.
			if (getComputedStyle(slot.host).visibility === "hidden") continue;
			const rect = slot.host.getBoundingClientRect();
			// Hidden members (display:none tabs) report an all-zero rect —
			// including them would pollute the canvas bounding box.
			if (rect.width === 0 && rect.height === 0) continue;
			if (bottomTop !== null && rect.top < bottomTop && rect.bottom > bottomTop && rect.left < (bottomPanel?.getBoundingClientRect().right ?? 0) && rect.right > (bottomPanel?.getBoundingClientRect().left ?? 0)) {
				// NOTE: DOMRect properties live on the prototype — spreading
				// `{ ...rect }` would produce an empty object. Build the
				// clipped rect field by field.
				entries.push({
					slot: slot.slot,
					rect: {
						left: rect.left,
						top: rect.top,
						right: rect.right,
						bottom: bottomTop,
						width: rect.width,
						height: Math.max(0, bottomTop - rect.top),
						x: rect.left,
						y: rect.top,
						toJSON: () => ({})
					} as DOMRect
				});
			} else {
				entries.push({ slot: slot.slot, rect });
			}
		}
		if (entries.length === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const { rect } of entries) {
			minX = Math.min(minX, rect.left);
			minY = Math.min(minY, rect.top);
			maxX = Math.max(maxX, rect.right);
			maxY = Math.max(maxY, rect.bottom);
		}
		if (!Number.isFinite(minX)) return null;
		const out = new Map<string, { w: number; h: number; dx: number; dy: number }>();
		for (const { slot, rect } of entries) {
			out.set(slot, { w: maxX - minX, h: maxY - minY, dx: -(rect.left - minX), dy: -(rect.top - minY) });
		}
		return out;
	}

	/** True when every layer pair of the surface exists and has been
	 * projected at least once. */
	private layerPairsHealthy(surface: SurfaceId): boolean {
		for (const slot of this.surfaceSlots(surface)) {
			for (const which of [0, 1] as const) {
				const el = document.getElementById(this.layerId(surface, slot.slot, which));
				if (el === null || !this.projectedLayers.has(el)) return false;
			}
		}
		return true;
	}

	/** Identity key of a media config. Configs are replaced immutably on
	 * every tweak, so object identity cannot tell whether the media changed
	 * while an async paint was in flight. */
	private mediaKeyOf(img: ImageConfig | undefined): string {
		return img !== undefined ? `${img.media}\u0000${img.url}\u0000${img.fileId}` : "";
	}

	/** Cancel a layer's running fade animation (if any). */
	private cancelLayerFade(layerId: string): void {
		const anim = this.layerAnims.get(layerId) ?? null;
		if (anim != null) {
			anim.cancel();
			this.layerAnims.set(layerId, null);
		}
	}

	/** Keep a layer's muted video in step with its visibility: visible
	 * layers play, hidden ones pause (no decoding cost while hidden). */
	private syncVideoPlayState(el: HTMLElement, visible: boolean): void {
		const media = el.firstElementChild;
		if (media === null || media.tagName !== "VIDEO") return;
		const video = media as HTMLVideoElement;
		if (visible) {
			void video.play().catch(() => {
				// Autoplay refused (should not happen: muted + playsinline) —
				// the frame still renders; a later repaint retries play.
			});
		} else {
			video.pause();
		}
	}

	/** A layer's current VISUAL opacity: computed style reflects a running
	 * animation's interpolated value (inline style does not). */
	private currentLayerOpacity(surface: SurfaceId, slot: string, which: LayerIndex): number {
		const el = document.getElementById(this.layerId(surface, slot, which));
		if (el === null) return 0;
		const raw = Number(getComputedStyle(el).opacity);
		return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
	}

	/** Paint every slot at once (same media, per-slot canvas slice). */
	private paintSlots(surface: SurfaceId, which: LayerIndex, url: string, img: ImageConfig | undefined, fade: number): void {
		const geometry = this.groupGeometryOf(surface);
		// Cache BOTH states: "no members visible" is a stable geometry too.
		this.lastGeometry.set(surface, geometry !== null ? new Map(geometry) : null);
		for (const slot of this.surfaceSlots(surface)) {
			this.paintLayer(surface, slot.slot, which, url, img, fade, geometry?.get(slot.slot));
		}
	}

	/** Fade every slot's layer at once. */
	private fadeSlots(surface: SurfaceId, which: LayerIndex, to: number, from?: number): void {
		for (const slot of this.surfaceSlots(surface)) {
			this.fadeLayer(surface, slot.slot, which, to, from);
		}
	}

	/** Drive one layer's opacity to `to` with a WAAPI animation. The start
	 * value is the layer's current visual opacity (or an explicit `from`
	 * pinned by the caller before re-staging) so a retarget mid-fade
	 * continues exactly where the previous animation left off; on finish
	 * the inline opacity is pinned to the target and the animation dropped. */
	private fadeLayer(surface: SurfaceId, slot: string, which: LayerIndex, to: number, from?: number): void {
		const id = this.layerId(surface, slot, which);
		const el = document.getElementById(id);
		if (el === null) return;
		this.projectedLayers.add(el);
		const raw = from !== undefined ? from : Number(getComputedStyle(el).opacity);
		this.cancelLayerFade(id);
		const target = clamp(to, 0, 1);
		const start = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
		if (start === target || typeof el.animate !== "function") {
			// No movement needed, or the Web Animations API is unavailable
			// (ancient engine): pin the inline value directly.
			el.style.opacity = String(target);
			this.syncVideoPlayState(el, target > 0);
			return;
		}
		const anim = el.animate(
			[{ opacity: String(start) }, { opacity: String(target) }],
			{ duration: FADE_MS, easing: "ease", fill: "forwards" }
		);
		this.layerAnims.set(id, anim);
		anim.onfinish = () => {
			el.style.opacity = String(target);
			anim.cancel(); // drop the forwards fill — inline now holds the value
			if (this.layerAnims.get(id) === anim) this.layerAnims.set(id, null);
			this.syncVideoPlayState(el, target > 0);
		};
		// Visible layers play immediately (hidden ones pause at the finish).
		this.syncVideoPlayState(el, target > 0);
	}

	/** Refresh the currently visible layers' media/render in place (same
	 * media — opacity/blur tweaks or moved members, no animation) and keep
	 * the OTHER layers hidden: after a session/view switch re-creates the
	 * layer pairs, the fresh siblings must be pinned to fade 0 or they cover
	 * the active layers. */
	private refreshActiveLayer(surface: SurfaceId): void {
		const active = this.activeLayer[surface];
		const img = this.currentImage(surface);
		const mediaKey = this.mediaKeyOf(img);
		this.fadeSlots(surface, active === 0 ? 1 : 0, 0);
		void this.displayUrlOf(img ?? ({ source: "url", url: "", media: "image" } as ImageConfig)).then((url) => {
			const current = this.currentImage(surface);
			// A crossfade started meanwhile (it owns the layer pairs), or the
			// media changed (a newer applyArea owns the paint) — stand down.
			if (this.fadeTimers[surface] !== undefined || this.mediaKeyOf(current) !== mediaKey) return;
			this.paintSlots(surface, active, url, current, 1);
		});
	}

	/** Paint one layer: render vars + fade, and the media child (an image
	 * div or a muted looping video). Videos pause at fade 0. `slice` carries
	 * the merged-canvas geometry for group members (explicit px canvas size
	 * + negative offsets so the shared image lines up across members). */
	private paintLayer(surface: SurfaceId, slot: string, which: LayerIndex, url: string, img: ImageConfig | undefined, fade: number, slice?: { w: number; h: number; dx: number; dy: number }): void {
		const el = document.getElementById(this.layerId(surface, slot, which));
		if (el === null) return;
		this.projectedLayers.add(el);
		this.cancelLayerFade(this.layerId(surface, slot, which)); // direct write supersedes any running fade
		const opacity = img !== undefined ? clamp(img.opacity, 0, 1) : 0;
		const display = img !== undefined ? resolveDisplay(img) : { size: "cover", position: "center", repeat: "no-repeat", rotate: "0deg", radius: "0px" };
		el.style.opacity = String(clamp(fade, 0, 1) * opacity);
		el.style.filter = `blur(${img !== undefined ? clamp(Math.round(img.blur * 10) / 10, 0, 24) : 0}px)`;
		el.style.transform = `rotate(${display.rotate})`;
		el.style.borderRadius = display.radius;

		// Media child: ensure the element kind matches the media type.
		const isVideo = img !== undefined && img.media === "video";
		let media = el.firstElementChild as HTMLElement | null;
		if (media !== null && media.tagName !== (isVideo ? "VIDEO" : "DIV")) {
			media.remove();
			media = null;
		}
		if (media === null) {
			media = document.createElement(isVideo ? "video" : "div");
			media.className = "dshbg-media";
			if (isVideo) {
				const video = media as HTMLVideoElement;
				video.setAttribute("muted", "");
				video.setAttribute("loop", "");
				video.setAttribute("playsinline", "");
				video.setAttribute("preload", "auto");
				video.volume = 0; // belt and braces: never any sound
			}
			el.appendChild(media);
		}

		if (img === undefined || url === "") {
			if (media.tagName === "VIDEO") {
				const video = media as HTMLVideoElement;
				video.pause();
				video.removeAttribute("src");
			} else {
				(media as HTMLElement).style.backgroundImage = "none";
			}
			return;
		}

		if (slice !== undefined) {
			// Merged canvas slice: explicit canvas size + negative offsets.
			if (media.tagName === "VIDEO") {
				const video = media as HTMLVideoElement;
				if (video.getAttribute("src") !== url) video.src = url;
				video.style.width = `${slice.w}px`;
				video.style.height = `${slice.h}px`;
				video.style.left = `${slice.dx}px`;
				video.style.top = `${slice.dy}px`;
				video.style.objectFit = "fill";
				video.style.objectPosition = "0% 0%";
				if (fade > 0) {
					void video.play().catch(() => {});
				} else {
					video.pause();
				}
			} else {
				const div = media as HTMLElement;
				div.style.backgroundImage = `url("${escapeCssString(url)}")`;
				div.style.backgroundSize = `${slice.w}px ${slice.h}px`;
				div.style.backgroundPosition = `${slice.dx}px ${slice.dy}px`;
				div.style.backgroundRepeat = "no-repeat";
			}
			return;
		}

		if (media.tagName === "VIDEO") {
			const video = media as HTMLVideoElement;
			if (video.getAttribute("src") !== url) video.src = url;
			video.style.width = "";
			video.style.height = "";
			video.style.left = "";
			video.style.top = "";
			video.style.objectFit = videoFitOf(img.mode);
			video.style.objectPosition = `${img.posX} ${img.posY}`;
			if (fade > 0) {
				void video.play().catch(() => {
					// Autoplay refused (should not happen: muted + playsinline) —
					// the frame still renders; a later repaint retries play.
				});
			} else {
				video.pause();
			}
		} else {
			const div = media as HTMLElement;
			div.style.backgroundImage = `url("${escapeCssString(url)}")`;
			div.style.backgroundSize = display.size;
			div.style.backgroundPosition = display.position;
			div.style.backgroundRepeat = display.repeat;
		}
	}

	private setLayerFade(surface: SurfaceId, slot: string, which: LayerIndex, fade: number): void {
		const el = document.getElementById(this.layerId(surface, slot, which));
		if (el === null) return;
		this.projectedLayers.add(el);
		this.cancelLayerFade(this.layerId(surface, slot, which)); // direct write supersedes any running fade
		const img = this.currentImage(surface);
		const opacity = img !== undefined ? clamp(img.opacity, 0, 1) : 0;
		el.style.opacity = String(clamp(fade, 0, 1) * opacity);
		// Keep the video playing state in step with its fade.
		this.syncVideoPlayState(el, fade > 0);
	}

	/** Drop every slot's layer of one side (after its fade-out completed). */
	private cleanupSlots(surface: SurfaceId, which: LayerIndex): void {
		for (const slot of this.surfaceSlots(surface)) {
			const el = document.getElementById(this.layerId(surface, slot.slot, which));
			if (el === null) continue;
			this.cancelLayerFade(this.layerId(surface, slot.slot, which));
			el.style.opacity = "0";
			const media = el.firstElementChild;
			if (media !== null) {
				if (media.tagName === "VIDEO") {
					const video = media as HTMLVideoElement;
					video.pause();
					video.removeAttribute("src");
				} else {
					(media as HTMLElement).style.backgroundImage = "none";
				}
			}
		}
	}

	/** Ensure the active layers are fully visible and the others hidden. */
	private ensureActiveFade(surface: SurfaceId): void {
		const active = this.activeLayer[surface];
		this.fadeSlots(surface, active, 1);
		this.fadeSlots(surface, active === 0 ? 1 : 0, 0);
	}

	//#endregion
}
