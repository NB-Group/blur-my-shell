import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as utils from '../conveniences/utils.js';
import * as uniforms from '../conveniences/shader_uniforms.js';

const St = await utils.import_in_shell_only('gi://St');
const Shell = await utils.import_in_shell_only('gi://Shell');
const Clutter = await utils.import_in_shell_only('gi://Clutter');

const SHADER_FILENAME = 'liquid_glass.glsl';
const MAX_BLUR_RADIUS = 48.0;

// Panel/dash-adapted defaults. A panel is a long thin strip (~1920x32), so
// minRes = min(w,h) = h ~= 32 and the exp refraction bands (which use
// distFromEdge*minRes in pixels) become geometrically much tighter than on the
// PoC 380x260 card — hence the wider *_distance and smaller refraction_scale.
// blur / tint / refraction are user-tunable via the BMS settings (Other page);
// the rest are fixed defaults.
const DEFAULT_PARAMS = {
    corner_radius: 30,
    blur_radius: 5.0,
    warp: 0,
    edge_intensity: 0.04,
    rim_intensity: 0.10,
    base_intensity: 0.01,
    edge_distance: 0.08,
    rim_distance: 0.25,
    base_distance: 0.25,
    corner_boost: 0.08,
    ripple: 0.1,
    tint_opacity: 0.1,
    refraction_scale: 2.0,
};

export const LiquidGlassEffect = utils.IS_IN_PREFERENCES
    ? { default_params: DEFAULT_PARAMS }
    : new GObject.registerClass({
        GTypeName: "LiquidGlassEffect",
    }, class LiquidGlassEffect extends Clutter.ShaderEffect {
        _init(params = {}) {
            super._init(params);

            this._source = utils.get_shader_source(Shell, SHADER_FILENAME, import.meta.url);
            if (this._source)
                this.set_shader_source(this._source);

            // re-paint on scale-factor changes
            const theme_context = St.ThemeContext.get_for_stage(global.stage);
            theme_context.connectObject('notify::scale-factor',
                () => this.queue_repaint(), this);
        }

        // Called by BMS's PaintSignals HACK (HACKS_LEVEL=1): the panel/dash
        // refresh dynamic blur by calling effect.queue_repaint() each time the
        // blur actor paints. Without this method the hook no-oped for liquid
        // glass, leaving it dependent on the pipeline's redraw loop — which
        // goes stale (transparent) after layout events until a stage-wide
        // redraw (dock sliding out, etc.) revives it.
        queue_repaint() {
            try { this.get_actor()?.queue_redraw(); } catch (_e) { }
        }

        static get default_params() {
            return DEFAULT_PARAMS;
        }

        vfunc_paint_target(paint_node, paint_context) {
            const actor = this.get_actor();
            const w = Math.max(1, actor ? actor.width : 1);
            const h = Math.max(1, actor ? actor.height : 1);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

            // nudge -1e-6 so Cogl reads the value as a float. blur/tint/refraction
            // come from the BMS settings (Other page); the rest are fixed defaults.
            // NOTE: deliberately NOT routing through BMS uniforms.set_uniform() — that
            // calls queue_repaint() per uniform (13×/frame = repaint storm) which broke
            // popup open/close transitions. Direct set_uniform_value.
            const setu = (k, v) => this.set_uniform_value(k, parseFloat(v - 1e-6));
            const s = global.blur_my_shell?._settings;
            const P = DEFAULT_PARAMS;
            // +3px padding so the rounded-rect mask's 3px AA band (smoothstep
            // ±1.5) lands inside the texture instead of being clipped at the
            // widget edge — without it the glass gets a hard cut on the border.
            setu('width', w + 3.0);
            setu('height', h + 3.0);
            const maxEdge = Math.max(1, Math.min(w, h) / 2);
            // corner radius: prefer the component's own getter (popup's per-menu
            // radius, panel's 0); no getter → pill (maxEdge) so a pill-shaped host
            // like dash-to-dock matches without a hardcoded pixel value.
            const _cr = this._corner_radius_getter ? this._corner_radius_getter() : maxEdge;
            setu('corner_radius', Math.min(_cr * scale, maxEdge));
            setu('blur_radius', Math.min(s?.LIQUID_GLASS_BLUR ?? P.blur_radius, MAX_BLUR_RADIUS) * scale);
            setu('warp', P.warp);
            setu('edge_intensity', P.edge_intensity);
            setu('rim_intensity', P.rim_intensity);
            setu('base_intensity', P.base_intensity);
            setu('edge_distance', P.edge_distance);
            setu('rim_distance', P.rim_distance);
            setu('base_distance', P.base_distance);
            setu('corner_boost', P.corner_boost);
            setu('ripple', P.ripple);
            setu('tint_opacity', s?.LIQUID_GLASS_TINT ?? P.tint_opacity);
            setu('refraction_scale', s?.LIQUID_GLASS_REFRACTION ?? P.refraction_scale);

            super.vfunc_paint_target(paint_node, paint_context);
        }
    });
