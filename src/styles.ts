/**
 * src/styles.ts — injected CSS: per-area layer pairs (crossfade) + shell
 * transparency + the plugin config card / settings UI.
 *
 * Every area owns TWO stacked layer elements (a/b) so media switches can
 * crossfade: the incoming layer fades in while the outgoing one fades out.
 * Each layer hosts one media child (`.dshbg-media`) — a background-image div
 * for images/GIFs or a muted looping <video> for videos. Opacity / filter /
 * transform / radius are driven inline by the service; the fade transition
 * lives here.
 */

/** Layer + section styles, injected once at bundle load. */
export const CSS = [
		/* ---- per-area layer pairs (a = active candidate, b = alternate) ----
	 * Layers default to opacity 0 (the service drives opacity inline) and
	 * carry NO background: transparent media pixels fall through to the
	 * shell's own theme surface, so light/dark themes need no special case. */
	/* generic fallback: EVERY layer element shares the same chrome. The
	 * specific rules below stay for readability; merged-group layers
	 * (dsh-bg-layer-group:<n>-<member>-<a|b>) rely on THIS rule — without
	 * it they are static block divs and the group background never shows. */
	"div[id^=\"dsh-bg-layer-\"]{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	"#dsh-bg-layer-sidebar-a,#dsh-bg-layer-sidebar-b{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	/* conversation: absolute layer pairs inside the conversation surface root
	 * (the scroll container stays transparent so the layer shows through) */
	"#dsh-bg-layer-conversation-a,#dsh-bg-layer-conversation-b{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	/* trajectory: absolute layer pairs inside the trajectory view root */
	"#dsh-bg-layer-trajectory-a,#dsh-bg-layer-trajectory-b{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	/* settings: absolute layer pairs inside the settings dialog panel */
	"#dsh-bg-layer-settings-a,#dsh-bg-layer-settings-b{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	/* vscode-sidebar tab surfaces: one layer pair per tab, absolutely
	 * positioned inside the tagged paneTab content div */
	"div[id^=\"dsh-bg-layer-tab-\"]{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .45s ease,filter .3s ease}",
	/* paneTab is NOT positioned by vscode-sidebar — anchor our tab/group
	 * layers to the tab div itself (otherwise they stretch across the whole
	 * pane and slices misalign) */
	"[data-dshbg-tab-surface]{position:relative!important}",
	/* media child: fills the layer; images paint via background-image, videos
	 * via object-fit (both sized/positioned inline by the service) */
	".dshbg-media{position:absolute;inset:0;width:100%;height:100%;background-repeat:no-repeat}",
	/* merged-group slices clip to their member (the canvas may overflow) */
	".dshbg-slice{overflow:hidden}",
	"video.dshbg-media{object-fit:cover;object-position:center}",
	/* ---- transparency + content lift per area ---- */
		/* sidebar: the service marks the column with data-dshbg-sidebar-host
	 * (slot wrappers make structural selectors off by one). Content gets
	 * position:relative ONLY — a z-index here would trap the settings dialog
	 * (fixed overlay inside the wrapper) under the center column. The layers
	 * lead the column, so tree order keeps content above the wallpaper. */
	"html[data-dsh-bg-sidebar=on] [data-dshbg-sidebar-host]{background:transparent!important;position:relative}",
	"html[data-dsh-bg-sidebar=on] [data-dshbg-sidebar-host] > *:not([id^=\"dsh-bg-layer\"]){position:relative;background:transparent!important}",
	/* conversation: the surface root (parent of [data-conversation-scroll])
	 * goes transparent and its children rise above the layers */
	"html[data-dsh-bg-conversation=on] div:has(> [data-conversation-scroll]){background:transparent!important;position:relative}",
	"html[data-dsh-bg-conversation=on] div:has(> [data-conversation-scroll]) > *:not([id^=\"dsh-bg-layer\"]){position:relative;z-index:1}",
	"html[data-dsh-bg-conversation=on] [data-conversation-scroll]{background:transparent!important}",
	/* composer: the seat paints a 36px fade band (transcript fading under the
	 * input) that reads as a black bar over a custom background — drop it */
	"html[data-dsh-bg-conversation=on] [data-composer-seat]{background:transparent!important}",
	/* trajectory: the view root and its inner surfaces (toolbar / timeline /
	 * table paint opaque bg-layer-1 fills) go transparent so the layer shows */
	"html[data-dsh-bg-trajectory=on] [data-conversation-composer-overlay]{background:transparent!important;position:relative}",
	"html[data-dsh-bg-trajectory=on] [data-conversation-composer-overlay] > *:not([id^=\"dsh-bg-layer\"]){position:relative;z-index:1}",
	"html[data-dsh-bg-trajectory=on] [data-conversation-composer-overlay] *:not([id^=\"dsh-bg-layer\"]){background-color:transparent!important}",
	/* settings: the dialog panel (already positioned) goes transparent, its
	 * nav/content surfaces follow, and its children rise above the layers */
	"html[data-dsh-bg-settings=on] [role=\"dialog\"][aria-modal=\"true\"][aria-labelledby]{background:transparent!important}",
	"html[data-dsh-bg-settings=on] [role=\"dialog\"][aria-modal=\"true\"][aria-labelledby] > *:not([id^=\"dsh-bg-layer\"]){position:relative;z-index:1}",
	"html[data-dsh-bg-settings=on] [role=\"dialog\"][aria-modal=\"true\"][aria-labelledby] *:not([id^=\"dsh-bg-layer\"]){background-color:transparent!important}",
	/* vscode-sidebar tab surfaces: the tagged paneTab content div (marked by
	 * the service with data-dshbg-tab-surface; data-dshbg-tab-on marks the
	 * enabled ones) goes transparent and its content rises above the layers */
	"[data-dshbg-tab-surface][data-dshbg-tab-on]{background:transparent!important}",
	"[data-dshbg-tab-surface][data-dshbg-tab-on] > *:not([id^=\"dsh-bg-layer\"]){position:relative;z-index:1}",
	"[data-dshbg-tab-surface][data-dshbg-tab-on] *:not([id^=\"dsh-bg-layer\"]){background-color:transparent!important}",
	/* whole vscode-sidebar panel surfaces: the entire panel (whatever tab is
	 * inside) goes transparent and its content rises above the layers */
	"[data-dshbg-panel-on]{background:transparent!important}",
	"[data-dshbg-panel-on] > *:not([id^=\"dsh-bg-layer\"]){position:relative;z-index:1}",
	"[data-dshbg-panel-on] *:not([id^=\"dsh-bg-layer\"]){background-color:transparent!important}",
	/* ---- settings UI ---- */
	".dshbg-root{flex-direction:column;gap:18px;display:flex}",
	".dshbg-head{flex-direction:column;gap:4px;display:flex}",
	".dshbg-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}",
	".dshbg-sub{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}",
	/* plugin config card chrome (Settings -> Plugins; mirrors the built-in PluginCard tokens) */
	".dshbg-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}",
	".dshbg-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
	".dshbg-card.dshbg-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
	".dshbg-cardHeader{width:100%;appearance:none;border:0;background:0 0;font:inherit;color:inherit;text-align:left;cursor:pointer;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;display:flex}",
	".dshbg-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
	".dshbg-cardHeadText{flex:1;min-width:0;flex-direction:column;gap:4px;display:flex}",
	".dshbg-cardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
	".dshbg-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
	".dshbg-cardChevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}",
	".dshbg-cardChevron.dshbg-chevronOpen{transform:rotate(180deg)}",
	".dshbg-cardBody{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;margin:0 16px;padding:12px 0 8px;display:flex}",
	/* surface list (unified selection model) */
	".dshbg-surfaces{border:1px solid var(--dsw-alias-border-l2);flex-direction:column;border-radius:12px;background:var(--dsw-alias-bg-module-platform);overflow:hidden}",
	".dshbg-surfaceGroup{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);padding:6px 12px;font-size:11px;font-weight:600;line-height:16px}",
	".dshbg-surfaceRow{width:100%;border:0;background:0 0;color:inherit;text-align:left;align-items:center;gap:10px;padding:8px 12px;font:inherit;display:flex;cursor:pointer}",
	".dshbg-surfaceRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
	".dshbg-surfaceRow.dshbg-focused{background:var(--dsw-alias-interactive-bg-hover-accent)}",
	".dshbg-surfaceRow.dshbg-unavailable{opacity:.5}",
	".dshbg-surfaceRow.dshbg-dropTarget{border-radius:8px;outline:2px dashed var(--dsw-static-deepseek-400);outline-offset:-2px}",
	".dshbg-surfaceRow.dshbg-groupRow{flex-wrap:wrap;gap:6px 10px}",
	".dshbg-surfaces.dshbg-dragOut{border-radius:12px;outline:2px dashed var(--dsw-alias-label-dimmed);outline-offset:2px}",
	".dshbg-chips{flex:1;min-width:0;align-items:center;gap:4px;display:flex;flex-wrap:wrap}",
	".dshbg-chipX{box-sizing:border-box;cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:8px;align-items:center;justify-content:center;padding:0;font-size:11px;line-height:11px;display:inline-flex}",
	".dshbg-chipX:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-mask-2)}",
	".dshbg-detailHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}",
	".dshbg-detailName{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dshbg-surfaceRow.dshbg-indent{padding-left:34px}",
	".dshbg-surfaceCheck{flex:none;margin:0;accent-color:var(--dsw-static-deepseek-400)}",
	".dshbg-surfaceName{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dshbg-surfaceCount{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}",
	".dshbg-surfaceDot{width:6px;height:6px;flex:none;background:var(--dsw-alias-label-tertiary);border-radius:50%}",
	".dshbg-surfaceDot[data-active=true]{background:var(--dsw-static-deepseek-400)}",
	".dshbg-surfaceRow.dshbg-ingroup{opacity:.65}",
	".dshbg-surfaceBadge{flex:none;box-sizing:border-box;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:10px;line-height:16px;white-space:nowrap}",
	".dshbg-chip{box-sizing:border-box;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:1px 8px;font-size:11px;line-height:16px;white-space:nowrap}",
	".dshbg-surfaceHint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}",
	/* image strip */
	".dshbg-strip{flex:none;gap:8px;width:100%;display:flex;overflow-x:auto}",
	".dshbg-thumb{box-sizing:border-box;cursor:pointer;flex:none;width:84px;border:2px solid transparent;background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:4px;position:relative;display:block}",
	".dshbg-thumb:hover{border-color:var(--dsw-alias-border-l3)}",
	".dshbg-thumb.dshbg-selected{border-color:var(--dsw-static-deepseek-400)}",
	".dshbg-thumbImg{width:72px;height:48px;display:block;background:repeating-linear-gradient(45deg,rgba(127,127,127,.15) 0 6px,transparent 6px 12px);border-radius:8px;object-fit:cover;pointer-events:none}",
	".dshbg-thumbName{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;width:72px;padding:4px 2px 0;font-size:11px;line-height:14px;overflow:hidden;pointer-events:none}",
	".dshbg-thumbDel{box-sizing:border-box;cursor:pointer;width:18px;height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-overlay);border:none;border-radius:9px;align-items:center;justify-content:center;padding:0;font-size:12px;line-height:12px;display:flex;position:absolute;top:2px;right:2px}",
	".dshbg-thumbDel:hover{color:var(--dsw-alias-state-error-primary)}",
	".dshbg-thumbTag{box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-mask-2);backdrop-filter:blur(4px);border-radius:5px;padding:0 4px;font-size:9px;line-height:14px;position:absolute;left:8px;bottom:16px;pointer-events:none}",
	".dshbg-thumbTag.dshbg-tagVideo{bottom:32px}",
	".dshbg-empty{color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:16px;font-size:12px;line-height:18px;text-align:center}",
	/* add row */
	".dshbg-addRow{flex-wrap:wrap;gap:8px;display:flex}",
	".dshbg-addInput{flex:1;min-width:200px}",
	/* editor panel */
	".dshbg-editor{border:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:12px;padding:14px;background:var(--dsw-alias-bg-module-platform);border-radius:14px;display:flex}",
	".dshbg-editorHead{justify-content:space-between;align-items:center;gap:8px;display:flex}",
	".dshbg-editorTitleRow{min-width:0;align-items:center;gap:8px;display:flex}",
	".dshbg-editorTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dshbg-mediaTag{flex:none;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-mask-2);border-radius:5px;padding:0 6px;font-size:10px;line-height:16px}",
	".dshbg-modeRow{flex-wrap:wrap;gap:6px;display:flex}",
	".dshbg-modeBtn{box-sizing:border-box;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;line-height:18px}",
	".dshbg-modeBtn:hover:not(.dshbg-selected){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
	".dshbg-modeBtn.dshbg-selected{color:var(--dsw-alias-label-primary);border-color:var(--dsw-static-deepseek-400);background:var(--dsw-alias-interactive-bg-hover-accent)}",
	".dshbg-modeBtn:disabled{cursor:default;opacity:.4;pointer-events:none}",
	".dshbg-detailGrid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;display:grid}",
	".dshbg-detailField{flex-direction:column;gap:4px;display:flex}",
	".dshbg-detailLabel{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}",
	".dshbg-detailInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);height:28px;padding:0 8px;font:inherit;font-size:12px;line-height:18px;width:100%;min-width:0}",
	".dshbg-sliderRow{align-items:center;gap:10px;display:flex}",
	".dshbg-sliderLabel{width:64px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
	".dshbg-slider{flex:1;min-width:0;accent-color:var(--dsw-static-deepseek-500)}",
	".dshbg-sliderValue{width:44px;flex:none;color:var(--dsw-alias-label-caption);text-align:right;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
	/* playback */
	".dshbg-playRow{flex-wrap:wrap;gap:8px;align-items:center;display:flex}",
	".dshbg-intervalInput{width:72px;flex:none}",
	".dshbg-intervalLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none}",
	".dshbg-position{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;flex:none;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}",
	/* errors */
	".dshbg-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}"
].join("");
