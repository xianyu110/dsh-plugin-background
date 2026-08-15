/**
 * src/entry.ts — cordis plugin face + loader registration assembly.
 * Bundled by esbuild (build.mjs) into the single-file module-loader format;
 * the build banner provides the outer `module` / `exports` variables.
 */
import { BackgroundService } from "./service";
import { createBackgroundStore } from "./store";
import { restoreState } from "./persistence";
import { BackgroundCard } from "./ui";
import { zh, en } from "./locales";
import { AREAS, DEFAULT_STATE, STORAGE_KEY } from "./constants";
import { CSS } from "./styles";
import type { BackgroundSnapshot, ImageConfig, SurfaceId } from "./types";

/** Variables injected by the build banner (see build.mjs). */
declare const module: { exports: Record<string, unknown> };
declare const exports: Record<string, unknown>;
declare const require: (spec: string) => unknown;

/** Cordis context subset the plugin face needs. */
interface PluginCtx {
	provide(key: string, value: unknown): void;
	effect(callback: () => void | (() => void), label?: string): () => void;
	emit(event: string, payload?: unknown): void;
	on(event: string, handler: (payload: any) => void): () => void;
	locale: {
		register(ns: string, dicts: Record<string, Record<string, string>>): void;
		bind(ns: string): (key: string) => string;
	};
	slots: {
		register(options: Record<string, unknown>, component: unknown): () => void;
		inject(key: string, callback: () => unknown): void;
	};
}

/** Inject the plugin CSS once at bundle load. */
const TAG_ID = "dsh-plugin-background/styles.css";
if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-plugin-background";
	tag.dataset.pluginCss = TAG_ID;
	tag.textContent = CSS;
	document.head.appendChild(tag);
}

/** Namespace owning this feature's settings-section copy. */
export const SETTINGS_NS = "settings.background";
/** Required services: slots + locale (the feature registers its own settings section). */
export const inject = ["slots", "locale"];
/** Stable cordis plugin name. */
export const name = "background";

/**
 * Client plugin body: provide the background service (boot-time DOM painting
 * + slideshow) and register the feature-owned config card into the settings
 * Plugins page (the card body is the full Background editor).
 */
export function apply(ctx: PluginCtx): void {
	const background = new BackgroundService(ctx);
	ctx.provide("background", background);
	ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "background: settings section dictionaries");
	const t = ctx.locale.bind(SETTINGS_NS);
	const store = createBackgroundStore();
	let bound: { sync(state: BackgroundSnapshot, revision: number): void } | undefined;
	const sync = (snapshot: BackgroundSnapshot) => {
		bound?.sync(snapshot, snapshot.revision);
	};
	ctx.on("background/change", sync);
	const injected = (actions: { sync(state: BackgroundSnapshot, revision: number): void }) => {
		bound = actions;
		sync(background.getState());
		return {
			addImages: (surface: SurfaceId, images: ImageConfig[]) => background.addImages(surface, images),
			removeImage: (surface: SurfaceId, index: number) => background.removeImage(surface, index),
			updateImage: (surface: SurfaceId, index: number, patch: Partial<ImageConfig>) => background.updateImage(surface, index, patch),
			setEnabled: (surface: SurfaceId, enabled: boolean) => background.setEnabled(surface, enabled),
			setIntervalSec: (surface: SurfaceId, seconds: number) => background.setIntervalSec(surface, seconds),
			setRandom: (surface: SurfaceId, random: boolean) => background.setRandom(surface, random),
			next: (surface: SurfaceId) => background.next(surface),
			showImage: (surface: SurfaceId, index: number) => background.showImage(surface, index),
			resolvePreview: (img: ImageConfig) => background.displayUrlOf(img),
			mergeSurfaces: (members: SurfaceId[]) => background.mergeSurfaces(members),
			unmerge: (groupId: SurfaceId) => background.unmerge(groupId),
			addMemberToGroup: (groupId: SurfaceId, member: SurfaceId) => background.addMemberToGroup(groupId, member),
			removeMemberFromGroup: (groupId: SurfaceId, member: SurfaceId) => background.removeMemberFromGroup(groupId, member),
			clearSurface: (surface: SurfaceId) => background.clearSurface(surface)
		};
	};
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		id: "background",
		order: 0,
		locale: SETTINGS_NS,
		store,
		inject: injected
	}, BackgroundCard));
}

/** Assemble the module-loader exports (the loader mounts the object plugin). */
Object.assign(exports, {
	AREAS,
	DEFAULT_STATE,
	SETTINGS_NS,
	STORAGE_KEY,
	BackgroundService,
	restoreState,
	apply,
	inject,
	name
});
void module;
