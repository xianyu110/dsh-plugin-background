/**
 * src/ui.ts — the Background settings section (own nav entry in Settings):
 * per-area segmented control, image strip, per-image editor (display mode,
 * detailed parameters, per-image opacity/blur), playback controls, and local
 * file/folder picking.
 */
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Button, IconChevronDownOutline14, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { MODES, REPEATS, parseImageList, imageOfUrl } from "./constants";
import { importPickedFiles, pickFiles } from "./files";
import type { AddImagesResult } from "./service";
import type { PickerAccept } from "./files";
import type { ImageConfig, SurfaceGroup, SurfaceId } from "./types";
import type { BackgroundRowState } from "./store";

/** Drag payload travelling inside HTML5 drag & drop. The payload lives in
 * `dataTransfer` (the only place readable at drop time in every browser) —
 * React state is only a visual fallback, never the source of truth. */
interface DragPayload {
	kind: "surface" | "member";
	/** Surface being dragged (kind "surface"), or the member (kind "member"). */
	id: SurfaceId;
	/** Group the member belongs to (kind "member" only). */
	groupId?: SurfaceId;
}

/** Custom MIME marking a background-surface drag (readable via `types` even
 * in `dragover`, where `getData` is blocked in protected mode). */
const DSHBG_MIME = "application/x-dshbg";

/** True when the drag carries a background-surface payload. Safe to call in
 * `dragover`/`dragenter` (types are readable; getData is not). */
export function hasDshbgPayload(event: DragEvent): boolean {
	const types = event.dataTransfer?.types;
	if (types === undefined || types === null) return false;
	return Array.from(types).includes(DSHBG_MIME);
}

/** Parse the drag payload from `dataTransfer` (works in `drop` everywhere). */
export function readDragPayload(event: DragEvent): DragPayload | null {
	try {
		const raw = event.dataTransfer?.getData(DSHBG_MIME);
		if (raw === undefined || raw === "") return null;
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if ((record.kind !== "surface" && record.kind !== "member") || typeof record.id !== "string") return null;
		return { kind: record.kind, id: record.id, groupId: typeof record.groupId === "string" ? record.groupId : undefined } as DragPayload;
	} catch {
		return null;
	}
}

/** Composed slot props handed to the section component. */
export interface BackgroundSectionProps {
	t: (key: string) => string;
	useStore: <T>(selector: (state: BackgroundRowState) => T) => T;
	/** Add images/videos to a surface. Groups are single-kind: a mixed batch
	 * is filtered and the skipped part reported via the result. */
	addImages: (surface: SurfaceId, images: ImageConfig[]) => AddImagesResult;
	removeImage: (surface: SurfaceId, index: number) => void;
	updateImage: (surface: SurfaceId, index: number, patch: Partial<ImageConfig>) => void;
	setEnabled: (surface: SurfaceId, enabled: boolean) => void;
	setIntervalSec: (surface: SurfaceId, seconds: number) => void;
	setRandom: (surface: SurfaceId, random: boolean) => void;
	next: (surface: SurfaceId) => void;
	/** Show a specific image (selecting a strip thumbnail previews it). */
	showImage: (surface: SurfaceId, index: number) => void;
	/** Merge several standalone surfaces into one continuous-canvas group. */
	mergeSurfaces: (members: SurfaceId[]) => SurfaceId | null;
	/** Dissolve a merged group (its media lands on every member). */
	unmerge: (groupId: SurfaceId) => void;
	/** Add a standalone surface into an existing group (drag onto a group row). */
	addMemberToGroup: (groupId: SurfaceId, member: SurfaceId) => void;
	/** Pull a member out of its group (chip × or drag-out). */
	removeMemberFromGroup: (groupId: SurfaceId, member: SurfaceId) => void;
	/** Clear a surface's media entirely. */
	clearSurface: (surface: SurfaceId) => void;
	/** Resolve a display URL for an image (local files via IndexedDB). */
	resolvePreview: (img: ImageConfig) => Promise<string>;
}

/** One strip thumbnail. Local-file previews resolve asynchronously. */
function StripItem(props: {
	t: (key: string) => string;
	img: ImageConfig;
	index: number;
	selected: boolean;
	onSelect: (index: number) => void;
	onRemove: (index: number) => void;
	resolvePreview: (img: ImageConfig) => Promise<string>;
}) {
	const { t, img, index, selected, onSelect, onRemove, resolvePreview } = props;
	const [preview, setPreview] = useState("");
	useEffect(() => {
		let cancelled = false;
		void resolvePreview(img).then((url) => {
			if (!cancelled && url !== "") setPreview(url);
		});
		return () => {
			cancelled = true;
		};
	}, [img, resolvePreview]);
	const src = img.source === "url" ? img.url : preview;
	return jsx("button", {
		type: "button",
		className: `dshbg-thumb${selected ? " dshbg-selected" : ""}`,
		"aria-pressed": selected,
		onClick: () => onSelect(index),
		children: jsxs(Fragment, {
			children: [
				img.media === "video"
					? jsx("video", {
						className: "dshbg-thumbImg",
						muted: true,
						preload: "metadata",
						playsInline: true,
						src
					})
					: jsx("img", { className: "dshbg-thumbImg", src, alt: "" }),
				jsx("span", { className: "dshbg-thumbName", children: img.source === "file" && img.name !== "" ? img.name : img.url }),
				jsx(Fragment, {
					children: [
						img.source === "file" ? jsx("span", { className: "dshbg-thumbTag", children: t("list.local") }) : null,
						img.media === "video" ? jsx("span", { className: "dshbg-thumbTag dshbg-tagVideo", children: t("tag.video") }) : null
					]
				}),
				jsx("button", {
					type: "button",
					className: "dshbg-thumbDel",
					"aria-label": t("img.remove"),
					onClick: (event: MouseEvent) => {
						event.stopPropagation();
						onRemove(index);
					},
					children: "×"
				})
			]
		})
	});
}

/** Detailed-parameter text field (draft + commit on blur / Enter). */
function DetailField(props: {
	t: (key: string) => string;
	labelKey: string;
	value: string;
	placeholder?: string;
	onCommit: (value: string) => void;
}) {
	const { t, labelKey, value, placeholder, onCommit } = props;
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return jsxs("label", {
		className: "dshbg-detailField",
		children: [
			jsx("span", { className: "dshbg-detailLabel", children: t(labelKey) }),
			jsx("input", {
				className: "dshbg-detailInput",
				placeholder,
				value: draft,
				onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
				onBlur: () => onCommit(draft),
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
				}
			})
		]
	});
}

/** Number field with numeric commit. */
function NumberField(props: {
	t: (key: string) => string;
	labelKey: string;
	value: number;
	min: number;
	max: number;
	onCommit: (value: number) => void;
}) {
	const { t, labelKey, value, min, max, onCommit } = props;
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return jsxs("label", {
		className: "dshbg-detailField",
		children: [
			jsx("span", { className: "dshbg-detailLabel", children: t(labelKey) }),
			jsx("input", {
				className: "dshbg-detailInput",
				type: "number",
				min,
				max,
				value: draft,
				onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
				onBlur: () => onCommit(Number(draft)),
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
				}
			})
		]
	});
}

/** Slider row (per-image opacity / blur). */
function SliderRow(props: {
	t: (key: string) => string;
	labelKey: string;
	value: number;
	min: number;
	max: number;
	step: number;
	suffix: string;
	onCommit: (value: number) => void;
}) {
	const { t, labelKey, value, min, max, step, suffix, onCommit } = props;
	return jsxs("div", {
		className: "dshbg-sliderRow",
		children: [
			jsx("span", { className: "dshbg-sliderLabel", children: t(labelKey) }),
			jsx("input", {
				type: "range",
				className: "dshbg-slider",
				min,
				max,
				step,
				value,
				onChange: (event: { target: { value: string } }) => onCommit(Number(event.target.value))
			}),
			jsx("span", { className: "dshbg-sliderValue", children: `${value}${suffix}` })
		]
	});
}

/** Editor panel for the selected image: mode, details, per-image render. */
function EditorPanel(props: {
	t: (key: string) => string;
	img: ImageConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<ImageConfig>) => void;
	onRemove: (index: number) => void;
}) {
	const { t, img, index, onUpdate, onRemove } = props;
	const label = img.source === "file" && img.name !== "" ? img.name : img.url;
	const isVideo = img.media === "video";
	return jsxs("div", {
		className: "dshbg-editor",
		children: [
			jsxs("div", {
				className: "dshbg-editorHead",
				children: [
					jsxs("div", {
						className: "dshbg-editorTitleRow",
						children: [
							jsx("div", { className: "dshbg-editorTitle", children: label }),
							jsx("span", { className: "dshbg-mediaTag", children: t(isVideo ? "media.video" : "media.image") })
						]
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => onRemove(index),
						children: t("img.remove")
					})
				]
			}),
			jsx("div", {
				className: "dshbg-modeRow",
				children: MODES.map((mode) => jsx("button", {
					type: "button",
					className: `dshbg-modeBtn${img.mode === mode ? " dshbg-selected" : ""}`,
					"aria-pressed": img.mode === mode,
					disabled: isVideo && mode === "repeat",
					title: isVideo && mode === "repeat" ? t("video.repeatDisabled") : undefined,
					onClick: () => onUpdate(index, { mode }),
					children: t(`mode.${mode}`)
				}, mode))
			}),
			img.mode === "custom" ? jsx("div", {
				className: "dshbg-detailGrid",
				children: [
					jsx(DetailField, { t, labelKey: "detail.posX", value: img.posX, onCommit: (v: string) => onUpdate(index, { posX: v }) }),
					jsx(DetailField, { t, labelKey: "detail.posY", value: img.posY, onCommit: (v: string) => onUpdate(index, { posY: v }) }),
					// Videos size through object-fit (cover/contain/fill) — the
					// image-only scale/width/height fields would silently no-op.
					!isVideo ? jsx(NumberField, { t, labelKey: "detail.scale", value: img.scale, min: 10, max: 500, onCommit: (v: number) => onUpdate(index, { scale: v }) }) : null,
					!isVideo ? jsx(DetailField, { t, labelKey: "detail.width", value: img.width, placeholder: "auto / 800px / 120%", onCommit: (v: string) => onUpdate(index, { width: v }) }) : null,
					!isVideo ? jsx(DetailField, { t, labelKey: "detail.height", value: img.height, placeholder: "auto / 600px / 100%", onCommit: (v: string) => onUpdate(index, { height: v }) }) : null,
					!isVideo ? jsxs("label", {
						className: "dshbg-detailField",
						children: [
							jsx("span", { className: "dshbg-detailLabel", children: t("detail.repeat") }),
							jsx("select", {
								className: "dshbg-detailInput",
								value: img.repeat,
								onChange: (event: { target: { value: string } }) => onUpdate(index, { repeat: event.target.value as ImageConfig["repeat"] }),
								children: REPEATS.map((repeat) => jsx("option", { value: repeat, children: t(`repeat.${repeat}`) }, repeat))
							})
						]
					}) : null,
					jsx(NumberField, { t, labelKey: "detail.rotate", value: img.rotate, min: -180, max: 180, onCommit: (v: number) => onUpdate(index, { rotate: v }) }),
					jsx(NumberField, { t, labelKey: "detail.radius", value: img.radius, min: 0, max: 200, onCommit: (v: number) => onUpdate(index, { radius: v }) })
				]
			}) : null,
			jsx(SliderRow, {
				t, labelKey: "render.opacity",
				value: Math.round(img.opacity * 100), min: 0, max: 100, step: 1, suffix: "%",
				onCommit: (v: number) => onUpdate(index, { opacity: v / 100 })
			}),
			jsx(SliderRow, {
				t, labelKey: "render.blur",
				value: Math.round(img.blur), min: 0, max: 24, step: 1, suffix: "px",
				onCommit: (v: number) => onUpdate(index, { blur: v })
			})
		]
	});
}

/**
 * The Background settings UI: a unified surface list replaces the old
 * "one area at a time" segmented control plus the overlapping "apply to"
 * chips. Every surface (the four built-in areas and every open
 * dsh-better-sidebar tab) is a row:
 * - the CHECKBOX marks add targets (a batch lands on every checked row);
 * - clicking the row FOCUSES it (the detail editor below edits that
 * surface); with nothing checked, adds fall back to the focused row.
 * Panel tabs are grouped under their panel and discovered live.
 */
export function BackgroundSection(props: BackgroundSectionProps) {
	const { t, useStore, addImages, removeImage, updateImage, setEnabled, setIntervalSec, setRandom, next, showImage, resolvePreview, mergeSurfaces, unmerge, addMemberToGroup, removeMemberFromGroup, clearSurface } = props;
	const s = useStore((state) => state);
	const [focus, setFocus] = useState<SurfaceId>("conversation");
	const [checked, setChecked] = useState<SurfaceId[]>([]);
	const [urlDraft, setUrlDraft] = useState("");
	const [selected, setSelected] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [readError, setReadError] = useState(false);
	const [mixError, setMixError] = useState<AddImagesResult | null>(null);
	/** Drag payload (visual fallback only — the drop path reads dataTransfer). */
	const [drag, setDrag] = useState<DragPayload | null>(null);
	/** Row currently hovered as a drop target. */
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	/** Surfaces in display order. */
	const surfaces = Object.keys(s.areas).filter((id) => s.meta[id] !== undefined);
	const availableSurfaces = surfaces.filter((id) => s.meta[id].available);
	/** The surface being edited. Grayed rows (closed tabs) stay focusable so
	 * their config can still be edited or cleared; falls back when the
	 * focused surface vanished entirely. */
	const focusSurface: SurfaceId = surfaces.includes(focus) ? focus : (availableSurfaces[0] ?? "conversation");
	const cfg = s.areas[focusSurface] ?? { enabled: false, images: [] as ImageConfig[], intervalSec: 15, random: false, index: 0 };
	const selectedImg = selected !== null ? cfg.images[selected] : undefined;
	/** Add targets: checked rows win; with none checked, the focused row. */
	const targets: SurfaceId[] = checked.filter((id) => availableSurfaces.includes(id));
	const effectiveTargets = targets.length > 0 ? targets : [focusSurface];

	useEffect(() => {
		setSelected(null);
		setMixError(null);
	}, [focusSurface]);

	/** Add a batch to every target surface (independent copies). */
	const applyAdd = (configs: ImageConfig[]) => {
		let skipped = 0;
		let skippedKind: AddImagesResult["skippedKind"];
		for (const target of effectiveTargets) {
			const result = addImages(target, configs.map((img) => ({ ...img })));
			skipped += result.skipped;
			if (result.skippedKind !== undefined) skippedKind = result.skippedKind;
		}
		setMixError(skipped > 0 ? { added: configs.length * effectiveTargets.length - skipped, skipped, skippedKind } : null);
	};

	const toggleChecked = (id: SurfaceId) => {
		setChecked((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
	};

	const handleFiles = async (files: FileList, accept: PickerAccept, directory: boolean) => {
		setBusy(true);
		try {
			const configs = await importPickedFiles(files, accept, directory);
			if (configs.length > 0) {
				applyAdd(configs);
				setReadError(false);
			} else {
				setReadError(true);
			}
		} finally {
			setBusy(false);
		}
	};

	const onRemove = (index: number) => {
		removeImage(focusSurface, index);
		setSelected((current) => (current === null ? null : current >= cfg.images.length - 1 ? Math.max(0, cfg.images.length - 2) : current));
	};

	const surfaceLabel = (id: SurfaceId): string => {
		const meta = s.meta[id];
		if (meta === undefined) return id;
		if (meta.group === "group") return `${t("group.name")}${meta.members !== undefined && meta.members.length > 0 ? `（${meta.members.length}）` : ""}`;
		return meta.group === "builtin" ? t(`area.${id}`) : meta.label;
	};

	const memberLabel = (id: SurfaceId): string => {
		const meta = s.meta[id];
		if (meta === undefined) return id;
		return meta.group === "builtin" ? t(`area.${id}`) : meta.label;
	};

	const groupOf = (id: SurfaceId): SurfaceGroup => s.meta[id]?.group ?? "builtin";
	const groups: SurfaceGroup[] = ["group", "builtin", "panel-right", "panel-bottom"];
	const rowsByGroup = (group: SurfaceGroup): SurfaceId[] => surfaces.filter((id) => groupOf(id) === group);

	/** Drop handling: a surface onto a row merges (or joins a group); a
	 * member dropped anywhere detaches from its group. The payload comes from
	 * `dataTransfer` — never from React state (whose closure can be stale). */
	const handleDropOn = (targetId: SurfaceId, payload: DragPayload | null): void => {
		setDropTarget(null);
		const effective = payload ?? drag;
		setDrag(null);
		if (effective === null) return;
		if (effective.kind === "member") {
			// Dropping a member onto ANOTHER group's row (or member row) moves
			// it there; onto its own group (or a non-group row) detaches it.
			const targetMeta = s.meta[targetId];
			const targetGroup = targetMeta?.group === "group" ? targetId : targetMeta?.memberOf;
			if (targetGroup !== undefined && targetGroup !== effective.groupId) {
				removeMemberFromGroup(effective.groupId ?? "", effective.id);
				addMemberToGroup(targetGroup, effective.id);
			} else {
				removeMemberFromGroup(effective.groupId ?? "", effective.id);
			}
			return;
		}
		if (effective.id === targetId) return;
		const targetMeta = s.meta[targetId];
		// A member row represents its group: dropping onto it joins that group
		// (dropping onto the group row itself does the same).
		const groupIdOf = targetMeta?.group === "group" ? targetId : targetMeta?.memberOf;
		if (groupIdOf !== undefined) {
			addMemberToGroup(groupIdOf, effective.id);
			return;
		}
		const result = mergeSurfaces([effective.id, targetId]);
		if (result !== null) {
			setChecked([]);
			setFocus(result);
		}
	};

	const handleDropOutside = (payload: DragPayload | null): void => {
		const effective = payload ?? drag;
		setDrag(null);
		if (effective === null) {
			setDropTarget(null);
			return;
		}
		if (effective.kind === "member") {
			setDropTarget(null);
			removeMemberFromGroup(effective.groupId ?? "", effective.id);
			return;
		}
		// A surface released on a gap/header while a row was highlighted:
		// honor the highlighted row (the mouse only missed it by a pixel).
		if (dropTarget !== null) {
			handleDropOn(dropTarget, effective);
			return;
		}
		setDropTarget(null);
	};

	const clearChecked = () => {
		for (const target of effectiveTargets) clearSurface(target);
	};

	return jsxs("div", {
		className: "dshbg-root",
		children: [
			jsxs("div", {
				className: "dshbg-head",
				children: [
					jsx("div", { className: "dshbg-title", children: t("title") }),
					jsx("div", { className: "dshbg-sub", children: t("subtitle") })
				]
			}),
			/* ---- action bar (checkboxes select, buttons act) ---- */
			jsxs("div", {
				className: "dshbg-addRow",
				children: [
					jsx(Input, {
						className: "dshbg-addInput",
						placeholder: t("add.placeholder"),
						value: urlDraft,
						onChange: (event: { target: { value: string } }) => setUrlDraft(event.target.value),
						onKeyDown: (event: KeyboardEvent) => {
							if (event.key === "Enter") {
								applyAdd(parseImageList(urlDraft).map(imageOfUrl));
								setUrlDraft("");
							}
						}
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						onClick: () => {
							applyAdd(parseImageList(urlDraft).map(imageOfUrl));
							setUrlDraft("");
						},
						children: t("add.button")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("image", false, (files) => void handleFiles(files, "image", false)),
						children: t("add.files")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("video", false, (files) => void handleFiles(files, "video", false)),
						children: t("add.videos")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("any", true, (files) => void handleFiles(files, "any", true)),
						children: t("add.folder")
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => setChecked(checked.length === availableSurfaces.length ? [] : [...availableSurfaces]),
						children: checked.length === availableSurfaces.length ? t("apply.none") : t("apply.all")
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						title: t("surface.clear"),
						onClick: clearChecked,
						children: t("surface.clear")
					})
				]
			}),
			/* ---- surface list ---- */
			jsx("div", {
				className: `dshbg-surfaces${drag?.kind === "member" ? " dshbg-dragOut" : ""}`,
				onDragOver: (event: DragEvent) => {
					if (hasDshbgPayload(event)) event.preventDefault();
				},
				onDrop: (event: DragEvent) => {
					event.preventDefault();
					handleDropOutside(readDragPayload(event));
				},
				children: groups.map((group) => {
					const rows = rowsByGroup(group);
					if (rows.length === 0) return null;
					return jsxs(Fragment, {
						children: [
							jsx("div", { className: "dshbg-surfaceGroup", children: t(group === "group" ? "group.name" : group === "builtin" ? "group.builtin" : group === "panel-right" ? "group.panel-right" : "group.panel-bottom") }),
							rows.map((id) => {
								const rowCfg = s.areas[id];
								const meta = s.meta[id];
								const count = rowCfg?.images.length ?? 0;
								const active = (rowCfg?.enabled ?? false) && count > 0;
								const isTab = group === "panel-right" || group === "panel-bottom";
								const isGroup = meta?.group === "group";
								const inGroup = meta?.memberOf !== undefined;
								const draggable = !isGroup; // surfaces drag; members drag out; groups only receive
								const isDropTargetRow = dropTarget === id;
								return jsx("div", {
									role: "button",
									tabIndex: 0,
									draggable,
									className: `dshbg-surfaceRow${isTab ? " dshbg-indent" : ""}${id === focusSurface ? " dshbg-focused" : ""}${meta?.available === false ? " dshbg-unavailable" : ""}${inGroup ? " dshbg-ingroup" : ""}${isDropTargetRow ? " dshbg-dropTarget" : ""}${isGroup ? " dshbg-groupRow" : ""}`,
									onClick: () => setFocus(id),
									onKeyDown: (event: KeyboardEvent) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											setFocus(id);
										}
									},
									onDragStart: (event: DragEvent) => {
										if (isGroup) return;
										const payload: DragPayload = inGroup
											? { kind: "member", groupId: meta?.memberOf ?? "", id }
											: { kind: "surface", id };
										setDrag(payload);
										const transfer = event.dataTransfer;
										if (transfer !== null && transfer !== undefined) {
											// Custom MIME carries the payload; text/plain keeps
											// Firefox happy (it requires setData to start).
											transfer.setData(DSHBG_MIME, JSON.stringify(payload));
											transfer.setData("text/plain", id);
											transfer.effectAllowed = "move";
										}
									},
									onDragEnd: () => {
										setDrag(null);
										setDropTarget(null);
									},
									onDragOver: (event: DragEvent) => {
										if (!hasDshbgPayload(event)) return;
										// Never allow dropping a row onto itself (best-effort:
										// dataTransfer cannot be read during dragover in
										// Chrome; the drop handler re-checks anyway).
										if (drag?.kind === "surface" && !isGroup && drag.id === id) return;
										event.preventDefault();
										if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = "move";
										setDropTarget(id);
									},
									// No onDragLeave: moving between a row and its own
									// children must not clear the highlighted target, or
									// a drop released at a child boundary loses the row.
									onDrop: (event: DragEvent) => {
										event.preventDefault();
										// Keep the container's handleDropOutside from also
										// running on this bubbled drop.
										event.stopPropagation();
										handleDropOn(id, readDragPayload(event));
									},
									children: jsxs(Fragment, {
										children: [
											jsx("input", {
												type: "checkbox",
												className: "dshbg-surfaceCheck",
												checked: checked.includes(id),
												disabled: inGroup,
												onChange: () => toggleChecked(id),
												onClick: (event: MouseEvent) => event.stopPropagation()
											}),
											jsx("span", { className: "dshbg-surfaceDot", "data-active": active }),
											jsx("span", { className: "dshbg-surfaceName", title: surfaceLabel(id), children: surfaceLabel(id) }),
											isGroup ? jsxs("span", {
												className: "dshbg-chips",
												children: [
													...(meta?.members ?? []).map((member) => jsxs("span", {
														className: "dshbg-chip",
														children: [
															memberLabel(member),
															jsx("button", {
																type: "button",
																className: "dshbg-chipX",
																"aria-label": t("group.removeMember"),
																title: t("group.removeMember"),
																onClick: (event: MouseEvent) => {
																	event.stopPropagation();
																	removeMemberFromGroup(id, member);
																},
																children: "×"
															})
														]
													}, `chip-${id}-${member}`)),
													jsx("button", {
														type: "button",
														className: "dshbg-chipX dshbg-dissolve",
														"aria-label": t("group.unmerge"),
														title: t("group.unmerge"),
														onClick: (event: MouseEvent) => {
															event.stopPropagation();
															unmerge(id);
														},
														children: "×"
													})
												]
											}) : inGroup ? jsx("span", { className: "dshbg-surfaceBadge", children: t("group.memberBadge") }) : null,
											jsx("span", { className: "dshbg-surfaceCount", children: count > 0 ? String(count) : "" })
										]
									})
								}, `row-${id}`);
							})
						]
					}, `group-${group}`);
				})
			}),
			jsx("div", { className: "dshbg-surfaceHint", children: t("surface.dragHint") }),
			/* ---- focused surface detail ---- */
			jsxs("div", {
				className: "dshbg-detailHead",
				children: [
					jsx("span", { className: "dshbg-detailName", children: surfaceLabel(focusSurface) }),
					jsx(Button, {
						variant: cfg.enabled ? "outline" : "ghost",
						size: "sm",
						onClick: () => setEnabled(focusSurface, !cfg.enabled),
						children: cfg.enabled ? t("disable") : t("enable")
					})
				]
			}),
			cfg.images.length > 0 ? jsx("div", {
				className: "dshbg-strip",
				children: cfg.images.map((img, index) => jsx(StripItem, {
					t,
					img,
					index,
					selected: selected === index,
					onSelect: (i: number) => {
						setSelected(i);
						showImage(focusSurface, i);
					},
					onRemove,
					resolvePreview
				}, `${focusSurface}-${index}`))
			}) : jsx("div", { className: "dshbg-empty", children: t("list.empty") }),
			selectedImg !== undefined ? jsx(EditorPanel, {
				t,
				img: selectedImg,
				index: selected as number,
				onUpdate: (index: number, patch: Partial<ImageConfig>) => updateImage(focusSurface, index, patch),
				onRemove
			}) : null,
			jsxs("div", {
				className: "dshbg-playRow",
				children: [
					jsx("span", { className: "dshbg-intervalLabel", children: t("play.interval") }),
					jsx(Input, {
						className: "dshbg-intervalInput",
						type: "number",
						min: 0,
						max: 3600,
						value: cfg.intervalSec,
						onChange: (event: { target: { value: string } }) => setIntervalSec(focusSurface, Number(event.target.value))
					}),
					jsx(Button, {
						variant: cfg.random ? "outline" : "ghost",
						size: "sm",
						onClick: () => setRandom(focusSurface, !cfg.random),
						children: cfg.random ? t("play.random") : t("play.order")
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						disabled: cfg.images.length < 2,
						onClick: () => next(focusSurface),
						children: t("play.next")
					}),
					jsx("span", {
						className: "dshbg-position",
						children: cfg.images.length > 0 ? `${cfg.index + 1}/${cfg.images.length}` : "0/0"
					})
				]
			}),
			s.lastError !== null ? jsx("div", { className: "dshbg-error", role: "alert", children: t(`error.${s.lastError}`) }) : null,
			mixError !== null ? jsx("div", { className: "dshbg-error", role: "alert", children: t("error.mix") }) : null,
			readError ? jsx("div", { className: "dshbg-error", role: "alert", children: t("error.read") }) : null
		]
	});
}

export function BackgroundCard(props: BackgroundSectionProps) {
	const { t } = props;
	// Collapsed by default, matching the built-in plugin cards.
	const [open, setOpen] = useState(false);
	return jsxs("li", {
		className: `dshbg-card${open ? " dshbg-open" : ""}`,
		children: [
			jsx("button", {
				type: "button",
				className: "dshbg-cardHeader",
				"aria-expanded": open,
				"aria-label": `${open ? t("card.collapse") : t("card.expand")}: ${t("card.name")}`,
				onClick: () => setOpen(!open),
				children: jsxs(Fragment, {
					children: [
						jsxs("span", {
							className: "dshbg-cardHeadText",
							children: [
								jsx("span", { className: "dshbg-cardName", children: t("card.name") }),
								jsx("span", { className: "dshbg-cardDesc", children: t("card.description") })
							]
						}),
						jsx(IconChevronDownOutline14, {
							className: `dshbg-cardChevron${open ? " dshbg-chevronOpen" : ""}`,
							size: 14
						})
					]
				})
			}),
			open ? jsx("div", {
				className: "dshbg-cardBody",
				children: jsx(BackgroundSection, props)
			}) : null
		]
	});
}
