# Dynamic Liquid Glass — Issue & PR content

> 定位：**震撼首发 + 实验性**。效果惊艳（实时折射动态桌面 + 三方共存），但坦白列 mutter 限制下的妥协。Issue 为主（讨论入口），PR 引用 Issue。

---

## 🔔 ISSUE（aunetx/blur-my-shell）

**Title:** `[Feature] Dynamic Liquid Glass — real-time desktop refraction (Apple-quality, clone-based)`

**Labels:** `enhancement`, `experimental`（如果有）

**Body:**

### tl;dr

Real-time, **Apple-quality liquid glass** for the **panel, dash-to-dock and popups** — refracting the **live desktop** (wallpaper **and** windows, dynamic or static) through a clone-based backdrop + single-pass GLSL shader. Plus **three-way coexistence** with applications blur and dynamic wallpapers (e.g. [waywallen](https://github.com/.../waywallen)).

🎬 **Demo:** <video placeholder — panel + dock glass over a dynamic wallpaper, plus a blurred app window>

This is **not** BMS's existing "Liquid Glass" (`refraction.glsl`, which blurs a *static wallpaper snapshot*). That one can't follow windows or dynamic wallpapers. This is a new, clone-based pipeline that samples the **actual live stage** behind the widget, every frame.

### What it does

- **Live refraction**: the glass shows what's *actually behind it* right now — drag a window under the panel, switch workspaces, run a video wallpaper — it all refracts through the glass in real time.
- **Single-pass shader**: gaussian blur + refraction bands + top-bright/bottom-dark sheen + rounded-rect mask (port of the [apple-inspired-glass-effects-library](https://github.com/.../apple-inspired-glass-effects-library)).
- **Three-way coexistence** (the genuinely hard part): liquid-glass panel/dock/popup **+** applications blur **+** dynamic wallpaper — all at once, with windows showing through the glass.

### How (technical)

- New `conveniences/liquid_glass_pipeline.js` (clone-based 透底 architecture): each glass widget clones `_backgroundGroup` + a shared `window_group` capture, then runs the `LiquidGlassEffect` shader on the widget.
- **Shared `window_group` capture** (one offscreen-cached clone of `window_group` in `uiGroup`): N glass widgets sample one cached texture, so the desktop is composored once per frame, not N times (avoids the mutter multi-clone pollution / window-shadow corruption you'd get from each widget cloning `window_group` directly).
- **applications blur coexistence**: applications keep BMS's native `Shell.BlurEffect(BACKGROUND)` inside `window_actor`. The whole-`window_group` capture includes that blur_actor → a **mild render loop**, deliberately accepted.

### Known limitations (this is the "experimental" part)

Mutter/Clutter impose real constraints here. We worked around most, but two remain:

1. **Applications blur actor desyncs during motion** — when a window is dragged or the workspace snaps (3-finger swipe), the applications-blur `blur_actor` (native `Shell.BlurEffect(BACKGROUND)` inside `window_actor`) outruns the window and briefly disappears, exposing the solid wallpaper layer behind it for a beat ("purple veil"). Root cause is the accepted render loop (the whole-`window_group` capture includes the blur_actor, which itself samples `_backgroundGroup`) plus mutter's blur position sampling during motion. BMS-side fix is blocked: the capture can't exclude the blur_actor without losing window see-through, and GNOME 50's gesture snap doesn't emit the standard `workspace_manager::workspace-switched` signal so a freeze/hide hook can't reliably catch the moment. Small, motion-only; static at rest.
2. **Performance** — single-pass 21×21 (441-tap) gaussian per widget per frame, tuned to avoid grain on high-frequency window content. Fine on discrete GPUs; heavy on low-end / integrated. A separable 2-pass blur would cut this ~4× at the same quality (future work).
3. **GNOME version** — developed & tested on **GNOME 50.3, NVIDIA, Wayland**. Older versions untested.
4. **Rounded corners** — shader mask reads the host's corner radius (panel = rect, dock = dash-to-dock's dash-background radius, popup = menu radius); AA tuned, may need per-theme tweaks.

We also document (in code comments) the dead-ends that *don't* work under mutter, so the next person doesn't re-walk them: clone-based ShaderEffects don't apply below `window_group`; per-child `Clone(MetaWindowActor)` doesn't bind its texture; `GaussianBlurEffect`'s chained FBO can't render a clone backdrop; etc.

### Try it

Fork: **`NB-Group/blur-my-shell`**, branch `feature/dynamic-liquid-glass`.

Per-component **"Liquid glass"** toggle (dynamic mode). The **Other** page exposes three hero params: **blur / tint / refraction**.

### Discussion

This deliberately pushes against mutter's compositing model. It works and (imo) looks genuinely great — but the applications-blur coexistence leans on an accepted render loop. Flagging for community discussion:

- Is this direction welcome upstream?
- Any cleaner way to break the applications-blur / glass-sees-windows loop without changing waywallen?

---

## 🔖 PR（NB-Group/blur-my-shell → aunetx/blur-my-shell）

**Title:** `feat(liquid-glass): dynamic clone-based glass for panel/dash/popup + applications coexistence`

**Body:**

> Implements **Dynamic Liquid Glass** (real-time desktop refraction) for panel / dash-to-dock / popups, plus three-way coexistence with applications blur and dynamic wallpapers.
>
> Full proposal, demo, technical write-up and known limitations: **#XXX** (issue).
>
> **Experimental** — relies on an accepted mild render loop for applications-blur coexistence; see issue for the mutter-limit trade-offs. Tested on GNOME 50.3 / NVIDIA / Wayland.
>
> New files: `effects/liquid_glass.{js,glsl}`, `conveniences/liquid_glass_pipeline.js`. Integration is surgical (per-component `LIQUID_GLASS` toggle + gschema keys + Other-page params).

---

## 下一步（等文案确认后）

1. 同步 `~/.local` 当前改动 → fork 工作树（`~/项目/blur-my-shell`）
2. fork 内逻辑分多个 commit（liquid-glass effect / pipeline / panel-dock-popup 集成 / applications 三方共存 / 圆角 AA）
3. push fork
4. 录演示视频
5. 开 Issue（贴视频）+ 开 PR（引用 Issue）
