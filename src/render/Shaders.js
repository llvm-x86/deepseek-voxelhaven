/**
 * Shaders.js — every GLSL program in Voxelhaven.
 *
 * Three programs cover the whole game:
 *   VOXEL  — chunks, dropped items, mobs, particles and the held item. They all
 *            share the chunk vertex layout, so one program and one texture
 *            atlas draw everything with per-vertex lighting.
 *   SKY    — a full-screen pass that reconstructs a view ray per pixel and
 *            paints the gradient, sun, moon, stars and clouds.
 *   LINE   — flat coloured lines for the block selection outline.
 */

/**
 * Vertex layout shared by the VOXEL program (see MeshBuilder.VERTEX_FLOATS).
 *  location 0: vec3 position
 *  location 1: vec2 tile-space coordinate
 *  location 2: vec2 atlas cell origin
 *  location 3: vec2 (skylight, block light) normalised
 *  location 4: vec2 (ao*shade, flags)
 */
export const VOXEL_ATTRIBUTES = [
  { location: 0, size: 3, offsetFloats: 0 },
  { location: 1, size: 2, offsetFloats: 3 },
  { location: 2, size: 2, offsetFloats: 5 },
  { location: 3, size: 2, offsetFloats: 7 },
  { location: 4, size: 2, offsetFloats: 9 }
];
export const VOXEL_STRIDE_FLOATS = 11;

export const VOXEL_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aTile;
layout(location = 2) in vec2 aTileBase;
layout(location = 3) in vec2 aLight;
layout(location = 4) in vec2 aMisc; // x = baked ao * face shade, y = flags

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uTime;

out vec2 vTile;
out vec2 vTileBase;
out vec2 vLight;
out float vShade;
out float vFogDepth;
out float vFlags;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 clip = uViewProj * world;

  // Flag bit 0 marks an animated liquid surface: nudge the texture coordinates
  // so water appears to drift without touching the geometry.
  float liquid = step(0.5, aMisc.y);
  vec2 wobble = vec2(sin(uTime * 0.9 + world.x * 0.7 + world.z * 0.3),
                     cos(uTime * 0.7 + world.z * 0.6 - world.x * 0.2)) * 0.05;

  vTile = aTile + wobble * liquid;
  vTileBase = aTileBase;
  vLight = aLight;
  vShade = aMisc.x;
  vFlags = aMisc.y;
  // clip.w is the view-space depth for a standard perspective projection.
  vFogDepth = clip.w;
  gl_Position = clip;
}
`;

export const VOXEL_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vTile;
in vec2 vTileBase;
in vec2 vLight;
in float vShade;
in float vFogDepth;
in float vFlags;

uniform sampler2D uAtlas;
uniform float uCell;        // 1 / atlas grid dimension
uniform float uInset;       // half-texel inset inside a cell, in tile units
uniform float uDayBrightness;
uniform vec3 uSkyColor;
uniform vec3 uBlockColor;
uniform float uMinAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlphaCutoff;
uniform vec3 uTint;
uniform float uTintAmount;

out vec4 fragColor;

void main() {
  // Wrap the tile coordinate, then clamp half a texel inside the cell so
  // linear filtering can never sample a neighbouring tile in the atlas.
  vec2 local = fract(vTile);
  local = clamp(local, vec2(uInset), vec2(1.0 - uInset));
  vec2 uv = vTileBase + local * uCell;

  vec4 texel = texture(uAtlas, uv);
  if (texel.a < uAlphaCutoff) discard;

  float sky = vLight.x * uDayBrightness;
  float block = vLight.y;
  // Taking the maximum (rather than a sum) keeps doubly-lit surfaces from
  // blowing out, and means a lantern adds nothing in full daylight.
  vec3 light = max(uSkyColor * sky, uBlockColor * block);
  light = max(light, vec3(uMinAmbient));

  vec3 albedo = mix(texel.rgb, texel.rgb * uTint, uTintAmount);
  // Flag bit 1 marks a surface as "just damaged": tint it red.
  float flash = step(1.5, mod(vFlags, 4.0));
  albedo = mix(albedo, vec3(0.92, 0.14, 0.12), flash * 0.72);

  vec3 color = albedo * light * vShade;

  float fog = clamp((vFogDepth - uFogNear) / max(0.001, uFogFar - uFogNear), 0.0, 1.0);
  color = mix(color, uFogColor, fog);

  fragColor = vec4(color, texel.a);
}
`;

/** Full-screen triangle for the sky pass. */
export const SKY_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos; // clip-space corner

uniform mat4 uInvViewProj;

out vec3 vRay;

void main() {
  // Place the vertex on the far plane so vRay is the world-space direction
  // from the camera through this pixel.
  vec4 far = uInvViewProj * vec4(aPos, 1.0, 1.0);
  vRay = far.xyz / far.w;
  gl_Position = vec4(aPos, 0.999999, 1.0);
}
`;

export const SKY_FRAG = `#version 300 es
precision highp float;

in vec3 vRay;

uniform vec3 uCameraPos;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCloudColor;
uniform float uDayBrightness;
uniform float uStarAmount;
uniform float uTime;
uniform float uCloudHeight;
uniform float uFogFar;

out vec4 fragColor;

/** Cheap 2D value noise built from a hash; good enough for clouds. */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float cloudField(vec2 p) {
  float n = valueNoise(p) * 0.6;
  n += valueNoise(p * 2.13) * 0.28;
  n += valueNoise(p * 4.7) * 0.12;
  return n;
}

void main() {
  vec3 dir = normalize(vRay);
  float up = dir.y;

  // Vertical gradient from horizon to zenith.
  float t = pow(clamp(up, 0.0, 1.0), 0.55);
  vec3 color = mix(uSkyHorizon, uSkyTop, t);
  // Looking down towards the ground darkens towards a muted horizon tone.
  color = mix(color, uSkyHorizon * 0.42, clamp(-up * 3.5, 0.0, 1.0));

  // Sun disc plus a broad glow.
  float sunDot = dot(dir, uSunDir);
  float sunDisc = smoothstep(0.9986, 0.9995, sunDot);
  float sunGlow = pow(max(sunDot, 0.0), 260.0) * 0.7 + pow(max(sunDot, 0.0), 10.0) * 0.12;
  color += uSunColor * (sunDisc * 1.5 + sunGlow) * max(uDayBrightness, 0.05);

  // Moon opposite the sun, only visible once the sky darkens.
  float moonDot = dot(dir, -uSunDir);
  float moonDisc = smoothstep(0.9988, 0.9996, moonDot);
  float night = 1.0 - uDayBrightness;
  color += vec3(0.86, 0.89, 0.98) * moonDisc * night * 1.3;

  // Stars fade in as the sky darkens; a stable hash grid keeps them fixed.
  if (uStarAmount > 0.001 && up > -0.05) {
    vec3 cell = floor(dir * 260.0);
    float h = hash21(cell.xy + cell.z * 7.13);
    float star = step(0.9972, h) * uStarAmount;
    // Twinkle very slightly so the sky is not completely static.
    star *= 0.75 + 0.25 * sin(uTime * 2.0 + h * 40.0);
    color += vec3(star) * clamp(up * 3.0, 0.0, 1.0);
  }

  // Cloud layer: intersect the view ray with a horizontal plane.
  if (up > 0.015) {
    float distanceToPlane = (uCloudHeight - uCameraPos.y) / up;
    if (distanceToPlane > 0.0) {
      vec2 cloudPos = (uCameraPos.xz + dir.xz * distanceToPlane) * 0.0055;
      cloudPos += vec2(uTime * 0.0035, uTime * 0.0012);
      float n = cloudField(cloudPos);
      float cover = smoothstep(0.54, 0.80, n);
      // Fade the layer out at the horizon so it does not form a hard line.
      float fade = smoothstep(0.015, 0.20, up) * (1.0 - smoothstep(0.55, 1.0, up) * 0.35);
      color = mix(color, uCloudColor, cover * fade * 0.82);
    }
  }

  // Distant terrain fades into the horizon colour; keep the sky consistent
  // with the fog by dimming the lowest band slightly.
  fragColor = vec4(color, 1.0);
}
`;

/** Flat coloured lines (block selection outline). */
export const LINE_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4 uViewProj;
uniform mat4 uModel;

void main() {
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}
`;

export const LINE_FRAG = `#version 300 es
precision highp float;

uniform vec4 uColor;

out vec4 fragColor;

void main() {
  fragColor = uColor;
}
`;
