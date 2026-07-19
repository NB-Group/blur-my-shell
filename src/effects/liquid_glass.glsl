// Liquid Glass shader — single-pass port of the reference lib's container glass
// shader (apple-inspired-glass-effects-library), adapted for the clone-based
// 透底 backdrop (tex IS the live desktop cloned into the widget).
// Refraction is REVERSED inward (textureCoord -=) because our tex is the
// widget's own region, not a full-page backdrop — outward would hit blank clamp.

uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float corner_radius;
uniform float blur_radius;
uniform float warp;
uniform float edge_intensity;
uniform float rim_intensity;
uniform float base_intensity;
uniform float edge_distance;
uniform float rim_distance;
uniform float base_distance;
uniform float corner_boost;
uniform float ripple;
uniform float tint_opacity;
uniform float refraction_scale;

// Signed distance to a rounded rectangle (negative inside, positive outside).
// coord is [0,1] local UV; size is the rect pixel size; radius is px.
float roundedRectDistance(vec2 coord, vec2 size, float radius) {
    vec2 center = size * 0.5;
    vec2 pixelCoord = coord * size;
    vec2 toCorner = abs(pixelCoord - center) - (center - radius);
    float outsideCorner = length(max(toCorner, 0.0));
    float insideCorner = min(max(toCorner.x, toCorner.y), 0.0);
    return outsideCorner + insideCorner - radius;
}

void main() {
    vec2 coord = cogl_tex_coord_in[0].xy;
    vec2 resolution = vec2(width, height);
    vec2 textureCoord = coord;   // tex is already the backdrop behind the widget

    // --- shape distance + outward normal (rounded rect) ---
    float distFromEdgeShape = max(-roundedRectDistance(coord, resolution, corner_radius), 0.0);
    vec2 center = vec2(0.5, 0.5);
    vec2 fromCenter = coord - center;
    vec2 shapeNormal = length(fromCenter) > 0.0001 ? normalize(fromCenter) : vec2(0.0, 1.0);

    float distFromLeft = coord.x;
    float distFromRight = 1.0 - coord.x;
    float distFromTop = coord.y;
    float distFromBottom = 1.0 - coord.y;
    float minRes = min(resolution.x, resolution.y);
    float distFromEdge = distFromEdgeShape / minRes;

    // --- refraction intensity (edge / rim / base exp bands) ---
    float normalizedDistance = distFromEdge * minRes;
    float baseInt = 1.0 - exp(-normalizedDistance * base_distance);
    float edgeInt = exp(-normalizedDistance * edge_distance);
    float rimInt = exp(-normalizedDistance * rim_distance);
    float baseComponent = warp > 0.5 ? baseInt * base_intensity : 0.0;
    float totalIntensity = baseComponent + edgeInt * edge_intensity + rimInt * rim_intensity;
    vec2 baseRefraction = shapeNormal * totalIntensity;

    // --- corner boost ---
    float cornerProximityX = min(distFromLeft, distFromRight);
    float cornerProximityY = min(distFromTop, distFromBottom);
    float cornerDistance = max(cornerProximityX, cornerProximityY);
    float cornerNormalized = cornerDistance * minRes;
    float cornerBoostVal = exp(-cornerNormalized * 0.3) * corner_boost;
    vec2 cornerRefraction = shapeNormal * cornerBoostVal;

    // --- edge ripple (perpendicular to the normal) ---
    vec2 perpendicular = vec2(-shapeNormal.y, shapeNormal.x);
    float rippleVal = sin(distFromEdge * 25.0) * ripple * rimInt;
    vec2 textureRefraction = perpendicular * rippleVal;

    vec2 totalRefraction = baseRefraction + cornerRefraction + textureRefraction;
    // Reference lib samples a full-page backdrop so outward (+=) hits real
    // content; our tex is the widget's own region so outward hits blank clamp.
    // Reverse inward (-=) and scale to bridge local-UV vs page-UV gap.
    textureCoord -= totalRefraction * refraction_scale;

    // --- single-pass gaussian blur, dense 1px sampling. The old kernel stepped
    // by sigma (~2.5px), which under-sampled high-frequency window content
    // (text / UI edges) and read as fine "grain" over windows. Now: fixed 1px
    // step, sigma in pixels = blur_radius, 21x21 circular kernel (radius 10 ~
    // 2-sigma for blur_radius=5, so the gaussian tail is captured not cut).
    // 441 taps/widget/frame — fine on discrete GPUs; that cost is the price of
    // killing the grain without a 2-pass separable rewrite.
    vec4 color = vec4(0.0);
    vec2 texelSize = 1.0 / resolution;
    float sigma = max(1.0, blur_radius);
    const float RADIUS = 10.0;
    float totalWeight = 0.0;
    for (float i = -RADIUS; i <= RADIUS; i += 1.0) {
        for (float j = -RADIUS; j <= RADIUS; j += 1.0) {
            float dpx = length(vec2(i, j));
            if (dpx <= RADIUS) {
                float weight = exp(-(dpx * dpx) / (2.0 * sigma * sigma));
                vec2 offset = vec2(i, j) * texelSize;
                // clamp to edge: refraction can push textureCoord past [0,1] at
                // the widget edge, and Cogl's offscreen texture wraps by default
                // (REPEAT). CLAMP_TO_EDGE emulation so out-of-range samples stick
                // to the edge pixel instead of wrapping in from the opposite side.
                vec2 sampleUV = clamp(textureCoord + offset, vec2(0.0), vec2(1.0));
                color += texture2D(tex, sampleUV) * weight;
                totalWeight += weight;
            }
        }
    }
    color /= totalWeight;

    // --- top-bright / bottom-dark sheen (the glass body feel) ---
    float gradientPosition = coord.y;
    vec3 topTint = vec3(1.0, 1.0, 1.0);
    vec3 bottomTint = vec3(0.7, 0.7, 0.7);
    vec3 gradientTint = mix(topTint, bottomTint, gradientPosition);
    vec3 tintedColor = mix(color.rgb, gradientTint, tint_opacity);
    color = vec4(tintedColor, color.a);

    // --- environment-sampled gradient (3 vertical bands of the backdrop) ---
    vec3 topColor = vec3(0.0);
    vec3 midColor = vec3(0.0);
    vec3 bottomColor = vec3(0.0);
    for (int xi = 0; xi < 4; xi++) {
        float x = 0.125 + 0.25 * float(xi);
        topColor += texture2D(tex, vec2(x, 0.1)).rgb;
        midColor += texture2D(tex, vec2(x, 0.5)).rgb;
        bottomColor += texture2D(tex, vec2(x, 0.9)).rgb;
    }
    topColor /= 4.0;
    midColor /= 4.0;
    bottomColor /= 4.0;

    vec3 sampledGradient;
    if (gradientPosition < 0.1) {
        sampledGradient = topColor;
    } else if (gradientPosition > 0.9) {
        sampledGradient = bottomColor;
    } else {
        float transitionPos = (gradientPosition - 0.1) / 0.8;
        if (transitionPos < 0.5) {
            sampledGradient = mix(topColor, midColor, transitionPos * 2.0);
        } else {
            sampledGradient = mix(midColor, bottomColor, (transitionPos - 0.5) * 2.0);
        }
    }
    vec3 finalTinted = mix(color.rgb, sampledGradient, tint_opacity * 0.3);
    color = vec4(finalTinted, color.a);

    // --- rounded-rect mask + premultiplied alpha out ---
    float maskDistance = roundedRectDistance(coord, resolution, corner_radius);
    // AA band: was smoothstep(-1,1) — too crisp, looked "cut". Widen to ±1.5
    // for a softer 3px anti-aliased edge.
    float mask = 1.0 - smoothstep(-1.5, 1.5, maskDistance);
    cogl_color_out = vec4(color.rgb * mask, mask);
}
