import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidGlassEffect } from '../effects/liquid_glass.js';

// ---- shared window_group capture (render once per frame, not once per widget) ----
// Each liquid glass widget used to clone `global.window_group` directly. With
// several widgets live at once (panel+dock+popups) the MetaWindowActors got
// painted N times per frame, corrupting mutter's compositing of the REAL
// windows (shadows / offset projections / preview ghosts on the windows).
// Fix: ONE shared Clone of window_group inside a plain wrapper actor, redirected
// offscreen so its paint is cached; every widget clones THIS, so window_group
// renders once per frame (into the cache) and widgets sample the cached texture.
// NOTE: redirect must be on the wrapper (a real actor), NOT on the Clone itself
// (redirect-on-Clone empties it → wallpaper-only).
let _WG_CAPTURE = null;

function get_wg_capture() {
    if (_WG_CAPTURE)
        return _WG_CAPTURE;
    // clip_to_allocation: without it, a window dragged past the LEFT screen
    // edge (window_actor.x < 0) gets painted at negative coords inside the
    // offscreen FBO, and Cogl REPEAT-wraps those samples in from the opposite
    // side — so the panel/dock glass showed the off-screen window portion
    // bleeding in from the right ("left-drag overflow"). Up/down/right drags
    // never produce negative coords, which is why only left was affected.
    // Clipping the capture's paint to its [0,screen] allocation drops the
    // negative-coord content before it can wrap.
    _WG_CAPTURE = new Clutter.Actor({ reactive: false, clip_to_allocation: true });
    try {
        let maxX = 0, maxY = 0;
        for (const mon of Main.layoutManager.monitors) {
            maxX = Math.max(maxX, mon.x + mon.width);
            maxY = Math.max(maxY, mon.y + mon.height);
        }
        _WG_CAPTURE.set_size(maxX || 1920, maxY || 1080);
        _WG_CAPTURE.set_position(0, 0);
        // Clone the WHOLE window_group (not its children individually): a
        // per-child Clone of MetaWindowActor doesn't bind its texture, so the
        // glass wouldn't show windows.
        //
        // TRADE-OFF (accepted): applications-blur's blur_actor lives inside
        // window_actor (BMS native BACKGROUND), and window_actor is in
        // window_group — so whole-Clone(window_group) includes the blur_actor,
        // which itself samples _backgroundGroup (→ waywallen's renderer, also
        // in window_group). That is a mild render loop. mutter gives no way to
        // have "glass sees windows" (needs whole-clone) AND "applications blur
        // not captured" without moving waywallen out of window_group. We accept
        // the loop: its only visible symptom is a slight offset on blurred
        // windows. See DYNAMIC_LIQUID_GLASS_PROPOSAL.md + upstream Issue.
        _WG_CAPTURE.add_child(new Clutter.Clone({ source: global.window_group }));
        _WG_CAPTURE.opacity = 0;            // painted (populates the cache) but invisible
        Main.uiGroup.add_child(_WG_CAPTURE);
        _WG_CAPTURE.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;
    } catch (_e) { }
    return _WG_CAPTURE;
}

// Tear down the shared capture. Called from extension.disable() so a disabled
// extension stops re-rendering window_group into an offscreen texture every
// frame (GPU leak while the extension is off). The next get_wg_capture()
// rebuilds it lazily.
export function destroy_wg_capture() {
    if (_WG_CAPTURE) {
        try { _WG_CAPTURE.destroy(); } catch (_e) { }
        _WG_CAPTURE = null;
    }
}

/// A dynamic liquid-glass pipeline, shaped like `DummyPipeline` but using the
/// clone-based 透底 architecture (Clutter.Clone of _backgroundGroup + a shared
/// window_group capture → real-time desktop refracted through the
/// LiquidGlassEffect shader) instead of Shell.BlurEffect(mode=BACKGROUND).
export class LiquidGlassPipeline {
    constructor(effects_manager, _settings, actor = null, options = {}) {
        this.effects_manager = effects_manager;
        this.opacity_factor = 1;
        this.effect = null;
        this.actor = null;
        this._cloneBg = null;
        this._cloneWg = null;
        this._repaintId = null;
        this._mappedId = null;
        this._actorDestroyId = null;
        this._corner_radius_getter = options.corner_radius_getter ?? null;
        // Pluggable effect + optional window_group clone so this pipeline can also
        // back applications-blur (GaussianBlurEffect, no wg clone -> can't loop
        // into the liquid-glass capture). Defaults keep liquid-glass behavior.
        this._effect_factory = options.effect_factory ?? null;
        this._clone_wg = options.clone_wg ?? true;
        this.attach_effect_to_actor(actor);
    }

    create_background_with_effect(background_group, widget_name) {
        this.actor = new St.Widget({ name: widget_name, clip_to_allocation: true });
        this.attach_effect_to_actor(this.actor);

        let bg_manager = new Clutter.Actor();
        bg_manager.backgroundActor = this.actor;
        bg_manager._bms_pipeline = this;

        background_group.insert_child_at_index(this.actor, 0);
        return [this.actor, bg_manager];
    }

    /// Align both clones so the widget samples exactly what is behind it on stage.
    reposition_clones() {
        if (!this.actor || !this._cloneBg)
            return;
        const pos = this.actor.get_transformed_position();
        const tx = pos ? pos[0] : 0;
        const ty = pos ? pos[1] : 0;
        // guard against NaN transforms (mid-animation) — keep the last position
        if (!Number.isFinite(tx) || !Number.isFinite(ty))
            return;
        this._cloneBg.set_position(-tx, -ty);
        this._cloneWg?.set_position(-tx, -ty);
    }

    attach_effect_to_actor(actor) {
        if (actor)
            this.actor = actor;
        else {
            this.remove_pipeline_from_actor();
            return;
        }

        this.actor.clip_to_allocation = true;

        if (!this._cloneBg) {
            this._cloneBg = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
            this.actor.insert_child_at_index(this._cloneBg, 0);
            if (this._clone_wg) {
                this._cloneWg = new Clutter.Clone({ source: get_wg_capture() });
                this.actor.insert_child_at_index(this._cloneWg, 1);
            }
        }

        this.build_effect();

        this._actorDestroyId = this.actor.connect(
            'destroy', () => this.remove_pipeline_from_actor());

        if (this.actor) {
            this.actor.add_effect(this.effect);
            // Run the redraw loop ONLY while mapped+visible. BMS reuses a popup's
            // blur_actor (hides it instead of destroying it when the menu closes);
            // if our loop kept running on every hidden popup, the pipelines (and
            // their signal connections) accumulated and eventually crashed gnome-shell
            // ("call back into JSAPI during the sweeping phase of GC"). Stopping the
            // loop on unmap + restarting on re-map keeps lingering popups inert.
            this._mappedId = this.actor.connect('notify::mapped', () => {
                if (this.actor && this.actor.mapped)
                    this._startRedrawLoop();
            });
            if (this.actor.mapped)
                this._startRedrawLoop();
            this.reposition_clones();
        } else {
            console.warn('[liquid-glass] could not add effect, actor gone');
        }
    }

    build_effect() {
        if (this._effect_factory) {
            this.effect = this._effect_factory();
        } else {
            this.effect = new LiquidGlassEffect();
            this.effect._corner_radius_getter = this._corner_radius_getter ?? null;
        }
    }

    // If GNOME replaced/destroyed a clone source (monitor change, background
    // reload), a Clone whose source is gone renders nothing. Re-create clones
    // bound to the live sources. No-op when sources are stable.
    _rebind_clones() {
        const fix = (getClone, setClone, sourceActor, idx) => {
            const c = getClone();
            if (c && c.source === sourceActor)
                return;
            try { c?.destroy(); } catch (_e) { }
            if (!sourceActor || !this.actor)
                return;
            const nc = new Clutter.Clone({ source: sourceActor });
            this.actor.insert_child_at_index(nc, idx);
            setClone(nc);
        };
        fix(() => this._cloneBg, v => { this._cloneBg = v; },
            Main.layoutManager._backgroundGroup, 0);
        if (this._clone_wg)
            fix(() => this._cloneWg, v => { this._cloneWg = v; },
                get_wg_capture(), 1);
    }

    // real-time glass: re-sample every frame while mapped+visible
    _startRedrawLoop() {
        if (this._repaintId)
            return;
        this._repaintId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const a = this.actor;
            if (!a) {
                this._repaintId = null;
                return GLib.SOURCE_REMOVE;
            }
            // stop the loop while unmapped/hidden. Clear _repaintId first so
            // notify::mapped can restart it — otherwise the loop dies on the
            // first unmap (overview/dock-autohide/popup-close) and the glass +
            // shared capture stop refreshing → the background twitches.
            if (!a.mapped || !a.visible) {
                this._repaintId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._rebind_clones();
            // Keep the shared window_group capture's offscreen texture fresh.
            // Without this, switching workspaces leaves the capture stuck on
            // waywallen's purple placeholder. Yes, this re-feeds the (accepted)
            // applications-blur loop documented above — that's the cost of the
            // glass seeing live windows. Only when this pipeline actually uses
            // the wg clone.
            if (this._clone_wg)
                get_wg_capture()?.queue_redraw?.();
            if (a.width > 0 && a.height > 0) {
                // Nudge the widget + effect each frame. Clone-based glass does NOT
                // refresh on its own for the dock branch: its PaintSignals fire on
                // paint, but the dock widget sits in needs-allocation while
                // autohide-sliding and doesn't paint — so without this nudge the
                // dock renders fully transparent. (Verified the hard way: dropping
                // these two lines made the dock go transparent.)
                a.queue_redraw();
                this.effect?.queue_repaint?.();
                this.reposition_clones();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRedrawLoop() {
        if (this._repaintId) {
            GLib.source_remove(this._repaintId);
            this._repaintId = null;
        }
    }

    set_opacity_factor(opacity_factor) {
        this.opacity_factor = Math.max(0, Math.min(1, opacity_factor));
    }

    update_effect() { /* uniforms are read from LIVE each frame in the effect */ }

    repaint_effect() {
        this.actor?.queue_redraw();
    }

    remove_pipeline_from_actor() {
        this.remove_effect();
        this._stopRedrawLoop();
        if (this.actor) {
            if (this._mappedId)
                this.actor.disconnect(this._mappedId);
            if (this._actorDestroyId)
                this.actor.disconnect(this._actorDestroyId);
        }
        this._mappedId = null;
        this._actorDestroyId = null;
        this.actor = null;
    }

    remove_effect() {
        if (this.effect) {
            try { this.actor?.remove_effect(this.effect); } catch (_e) { }
            this.effect = null;
        }
    }

    change_pipeline_to() { return; }

    destroy() {
        this._stopRedrawLoop();
        this.remove_effect();
        if (this._cloneBg) { this._cloneBg.destroy(); this._cloneBg = null; }
        if (this._cloneWg) { this._cloneWg.destroy(); this._cloneWg = null; }
        this.remove_pipeline_from_actor();
    }
}
