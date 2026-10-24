/**
 * 香港環境渲染：天空、日月星辰、雲霧、晝夜四季光照、六種天氣視覺、地名標籤。
 *
 * - 天空：跟隨鏡頭的巨大天球 + ShaderMaterial（漸層、日／月盤與光暈、程序化雲層、
 *   閃爍星空、閃電）；香港濕熱多雲、光害令夜空偏橙。
 * - 光照：Hemisphere + 環境光 + 跟隨鏡頭的 DirectionalLight（投影）；夜間以兩盞
 *   暖色點光模擬維港兩岸霓虹／樓宇燈火，另加霓虹光暈 Sprite。
 * - 天氣：
 *     晴   —— 藍天白雲、星空月亮；
 *     陰   —— 灰雲、光線柔和；
 *     雨   —— 雨絲（GPU 線段）、地面薄霧、水面漣漪（水面 shader 自動配合）；
 *     颱風 —— 狂風暴雨、鉛灰紫天空、密集斜雨、閃電、海霧、能見度低；
 *     霧   —— 大霧鎖港，濃霧貼地、遠景消失、視距極短；
 *     雪   —— 寒潮飄雪、天空慘白、山頂結霜（地形負責）。
 * - 地名標籤：維港／山脈／離島／各區名字以單一 billboard mesh 繪製（1 draw call），
 *   拉遠時浮現、貼近時淡出，颱風大霧時降低可見度。
 *
 * 介面（不可變）：createEnvironmentView(scene, state) → { update(state, dt, camera), dispose() }
 */

import * as THREE from 'three';
import type { GameState, Season, Weather } from '../core/types';
import { hash2d, mulberry32 } from '../core/rng';
import { HK_PLACES } from '../world/worldgen';
import { createCloudTexture, createGlowTexture, createLabelAtlas } from './world-geometry';
import {
  computeMoonDir,
  computeSun,
  createSkyPalette,
  createSunState,
  fogRange,
  sampleSkyPalette,
  mapViewScale,
  tileTopY,
  weatherLightFactor,
  windStrength,
  type SkyPalette,
  type SunState,
} from './world-utils';

export interface EnvironmentView {
  update(state: GameState, dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

// ─────────────────────────── 天空 Shader ───────────────────────────

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonColor;
  uniform vec3 uCloudColor;
  uniform float uDaylight;
  uniform float uNight;
  uniform float uCloudiness;
  uniform float uTime;
  uniform float uCloudDrift;
  uniform float uStarFade;
  uniform float uFlash;
  uniform float uHazeWarm;
  varying vec3 vDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.07 + vec2(3.1, 7.7);
      a *= 0.5;
    }
    return v;
  }
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.27, 0.39));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = clamp(h, 0.0, 1.0);
    float t = pow(up, 0.62);
    vec3 col = mix(uHorizon, uZenith, t);
    // 地平線以下：模擬遠海深海色（避免俯瞰時地圖以外一片死白）
    vec3 deepSea = vec3(0.015, 0.06, 0.09) + uHorizon * 0.05;
    col = mix(col, deepSea, smoothstep(0.015, -0.16, h));

    // 太陽盤與光暈
    vec3 sd = normalize(uSunDir);
    float sunDot = max(dot(d, sd), 0.0);
    float sunDisc = pow(sunDot, 1600.0) * 3.4;
    float sunHalo = pow(sunDot, 7.0) * 0.2;
    col += uSunColor * (sunDisc + sunHalo) * (0.35 + uDaylight);

    // 月亮
    vec3 md = normalize(uMoonDir);
    float moonDot = max(dot(d, md), 0.0);
    float moonDisc = pow(moonDot, 3200.0) * 2.4;
    float moonHalo = pow(moonDot, 42.0) * 0.08;
    col += uMoonColor * (moonDisc + moonHalo) * uNight * 1.4;

    // 星空：把方向切成小格，每格至多一顆圓點星，兩層密度 + 閃爍
    if (uStarFade > 0.01 && h > -0.02) {
      float starMask = smoothstep(-0.02, 0.2, h) * uStarFade;
      float twinkle = 0.7 + 0.3 * sin(uTime * 2.1 + h * 30.0);
      vec3 q1 = d * 190.0;
      vec3 c1 = floor(q1);
      vec3 f1 = fract(q1);
      float h1 = hash31(c1);
      if (h1 > 0.9935) {
        vec3 r1 = vec3(hash31(c1 + 1.7), hash31(c1 + 4.3), hash31(c1 + 9.1));
        float dist1 = length(f1 - r1);
        col += vec3(0.86, 0.92, 1.0) * smoothstep(0.34, 0.02, dist1) * twinkle * starMask * 1.5;
      }
      vec3 q2 = d * 330.0 + vec3(7.0, 3.0, 5.0);
      vec3 c2 = floor(q2);
      vec3 f2 = fract(q2);
      float h2 = hash31(c2);
      if (h2 > 0.9965) {
        vec3 r2 = vec3(hash31(c2 + 2.3), hash31(c2 + 6.1), hash31(c2 + 8.7));
        float dist2 = length(f2 - r2);
        col += vec3(0.78, 0.84, 0.96) * smoothstep(0.3, 0.02, dist2) * starMask * 0.8;
      }
    }

    // 程序化雲層（投影到高空平面，緩慢漂移；颱風時厚雲翻滾）
    if (uCloudiness > 0.01 && h > 0.03) {
      vec2 cuv = d.xz / max(h, 0.18);
      cuv = clamp(cuv, vec2(-34.0), vec2(34.0));
      cuv = cuv * 0.55 + vec2(uCloudDrift, uCloudDrift * 0.37);
      float cl = fbm2(cuv + vec2(sin(uTime * 0.07) * 0.3, cos(uTime * 0.05) * 0.3));
      float cover = smoothstep(0.62 - uCloudiness * 0.4, 0.98, cl);
      cover *= smoothstep(0.16, 0.5, h);
      cover *= 1.0 - smoothstep(0.5, 1.0, h) * 0.25;
      col = mix(col, uCloudColor, cover * (0.35 + uCloudiness * 0.65));
    }

    // 城市光害：夜晚地平線附近的暖橙薄霞
    float horizonGlow = smoothstep(0.25, 0.0, abs(h - 0.02));
    col += vec3(0.32, 0.16, 0.07) * horizonGlow * uNight * uHazeWarm * 0.65;

    // 閃電：整片天空短暫泛白
    col += vec3(0.72, 0.78, 0.92) * uFlash * (0.35 + 0.4 * smoothstep(-0.1, 0.4, h));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ─────────────────────────── 粒子 Shader ───────────────────────────

const PRECIP_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec2 uWind;
  uniform float uFall;
  uniform float uHeight;
  attribute float aRand;
  attribute float aTip;
  varying float vFade;
  void main() {
    float speed = uFall * (0.8 + aRand * 0.5);
    float y = mod(position.y - uTime * speed, uHeight);
    vec3 p = vec3(
      position.x + uWind.x * (uHeight - y) * 0.4,
      y,
      position.z + uWind.y * (uHeight - y) * 0.4
    );
    p += vec3(uWind.x * 0.35, -0.85, uWind.y * 0.35) * aTip;
    p.x += uCenter.x;
    p.z += uCenter.z;
    vFade = smoothstep(0.0, 2.5, y) * (1.0 - smoothstep(uHeight * 0.7, uHeight, y));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const PRECIP_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SNOW_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec2 uWind;
  uniform float uFall;
  uniform float uHeight;
  uniform float uSize;
  attribute float aRand;
  varying float vFade;
  void main() {
    float speed = uFall * (0.55 + aRand * 0.5);
    float y = mod(position.y - uTime * speed, uHeight);
    float sway = sin(uTime * 0.9 + aRand * 6.283) * 1.1 + sin(uTime * 2.1 + aRand * 12.0) * 0.4;
    vec3 p = vec3(
      position.x + sway + uWind.x * (uHeight - y) * 0.25,
      y,
      position.z + sway * 0.7 + uWind.y * (uHeight - y) * 0.25
    );
    p.x += uCenter.x;
    p.z += uCenter.z;
    vFade = smoothstep(0.0, 2.0, y) * (1.0 - smoothstep(uHeight * 0.75, uHeight, y));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (940.0 / max(1.0, -mv.z)) * (0.7 + aRand * 0.7), 1.0, 8.0);
  }
`;

const SNOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.12, d);
    gl_FragColor = vec4(uColor, uOpacity * vFade * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const FIREFLY_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uSize;
  attribute float aPhase;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    p.x += cos(uTime * 0.6 + aPhase * 6.283) * 0.6;
    p.y += sin(uTime * 1.1 + aPhase * 6.283) * 0.25;
    p.z += sin(uTime * 0.8 + aPhase * 6.283) * 0.6;
    vAlpha = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 3.4 + aPhase * 30.0))) * uOpacity;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (940.0 / max(1.0, -mv.z)), 1.0, 7.0);
  }
`;

const FIREFLY_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, vAlpha * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ─────────────────────────── 地名標籤 Shader ───────────────────────────

const LABEL_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aOffset;
  attribute vec2 aUv;
  attribute float aMajor;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform float uSizeScale;
  varying vec2 vUv;
  varying float vDist;
  varying float vMajor;
  void main() {
    // 螢幕空間固定大小：offset 隨相機距離放大，令 480 大地圖 zoom out 時
    // 地名標籤仍然清楚，又唔會近景變巨型文字。
    vec4 centerMv = viewMatrix * vec4(aCenter, 1.0);
    float dist = max(length(centerMv.xyz), 1.0);
    float s = dist * uSizeScale;
    vec3 world = aCenter + uCamRight * aOffset.x * s + uCamUp * aOffset.y * s;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vUv = aUv;
    vDist = dist;
    vMajor = aMajor;
    gl_Position = projectionMatrix * mv;
  }
`;

const LABEL_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uFadeNearA;
  uniform float uFadeNearB;
  uniform float uFadeFarA;
  uniform float uFadeFarB;
  uniform float uMinorFadeA;
  uniform float uMinorFadeB;
  uniform float uMidFadeA;
  uniform float uMidFadeB;
  varying vec2 vUv;
  varying float vDist;
  varying float vMajor;
  void main() {
    vec4 tex = texture2D(uMap, vUv);
    if (tex.a < 0.02) discard;
    // 遠處淡出，避免與霧混在一起
    float fade = smoothstep(uFadeNearA, uFadeNearB, vDist) * (1.0 - smoothstep(uFadeFarA, uFadeFarB, vDist) * 0.55);
    // 三層 LOD：0 = 近景才顯示；1 = 中景；2 = overview 都顯示
    float fadeMinor = 1.0 - smoothstep(uMinorFadeA, uMinorFadeB, vDist);
    float fadeMid = 1.0 - smoothstep(uMidFadeA, uMidFadeB, vDist);
    float lodFade = mix(fadeMinor, fadeMid, step(0.5, vMajor));
    lodFade = mix(lodFade, 1.0, step(1.5, vMajor));
    fade *= lodFade;
    gl_FragColor = vec4(tex.rgb, tex.a * uOpacity * fade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ─────────────────────────── 主體 ───────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function createEnvironmentView(scene: THREE.Scene, _state: GameState): EnvironmentView {
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const sun: SunState = createSunState();
  const palette: SkyPalette = createSkyPalette();
  const moonDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const cameraDir = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const shadowDir = new THREE.Vector3();
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();
  /**
   * 地圖視覺尺度：96 地圖 = 1、304 地圖 ≈ 3.1667。
   * 天空球、雲、霧、雨雪範圍、螢火／飛鳥、城市燈光、地名標籤尺寸全部跟隨放大，
   * 令 304 大地圖 zoom out 到全圖時仍然被天空包住、不會穿模或被霧遮。
   */
  const VIEW_SCALE = mapViewScale(_state.width, _state.height);
  /** 地圖世界全長（304×2 = 608；96×2 = 192） */
  const MAP_SPAN = Math.max(_state.width, _state.height) * 2;
  /** 最頂層地名：overview 全圖都顯示（約 16 個，避免白色一團） */
  const TOP_LABELS = new Set([
    '中環', '尖沙咀', '旺角', '觀塘', '荃灣', '沙田', '屯門', '元朗', '大埔', '將軍澳',
    '東涌', '維多利亞港', '大帽山', '太平山', '獅子山', '赤鱲角',
  ]);
  /** 主要地名：中景（camera 較近）才顯示；其餘次要地名只在中近景顯示 */
  const MAJOR_LABELS = new Set([
    '中環', '銅鑼灣', '尖沙咀', '旺角', '觀塘', '荃灣', '沙田', '屯門', '元朗', '大埔',
    '上水', '將軍澳', '東涌', '香港仔', '赤鱲角',
    '維多利亞港', '吐露港', '城門河', '大潭水塘', '船灣淡水湖', '萬宜水庫', '香港仔避風塘',
    '大帽山', '鳳凰山', '太平山', '獅子山', '大老山', '青山',
    '長洲', '南丫島', '坪洲', '香港國際機場', '米埔',
  ]);
  /** 海上地名標籤浮空高度（世界 y） */
  const WATER_LABEL_Y = 2.4;
  /** 天球半徑：需大於「鏡頭最遠距離 + 地圖半對角線」，同時小於相機 far plane */
  const SKY_RADIUS = Math.max(1400, MAP_SPAN * 2.6);

  // 背景色（天球未覆蓋處的備援）與霧
  scene.background = new THREE.Color(0x9ec8e8);
  const fog = new THREE.Fog(0xb8d4e8, 90, 300);
  scene.fog = fog;

  // ── 天球 ──
  const skyGeo = track(new THREE.SphereGeometry(1, 32, 20));
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x6fb0d8) },
    uHorizon: { value: new THREE.Color(0xd6e6dc) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uMoonDir: { value: new THREE.Vector3(-0.4, 0.6, -0.3) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uMoonColor: { value: new THREE.Color(0xd4e0ff) },
    uCloudColor: { value: new THREE.Color(0xf0f5fa) },
    uDaylight: { value: 1 },
    uNight: { value: 0 },
    uCloudiness: { value: 0.2 },
    uTime: { value: 0 },
    uCloudDrift: { value: 0 },
    uStarFade: { value: 0 },
    uFlash: { value: 0 },
    uHazeWarm: { value: 1 },
  };
  const skyMat = track(
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky-dome';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  track(sky);
  scene.add(sky);

  // ── 光照 ──
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x5d6b4a, 0.75);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x9fb0c0, 0.35);
  scene.add(ambient);

  const sunLight = new THREE.DirectionalLight(0xffe7b8, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const shadowSize = 95;
  sunLight.shadow.camera.left = -shadowSize;
  sunLight.shadow.camera.right = shadowSize;
  sunLight.shadow.camera.top = shadowSize;
  sunLight.shadow.camera.bottom = -shadowSize;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 420;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.03;
  sunLight.shadow.camera.updateProjectionMatrix();
  scene.add(sunLight);
  scene.add(sunLight.target);

  // ── 城市燈火：維港兩岸各一盞暖色點光（九龍／港島），模擬萬家燈火 ──
  const kowloonGlow = new THREE.PointLight(0xffa45c, 0, 95 * VIEW_SCALE, 1.3);
  const islandGlow = new THREE.PointLight(0xff8a6a, 0, 95 * VIEW_SCALE, 1.3);
  scene.add(kowloonGlow, islandGlow);
  const kowloonTarget = new THREE.Vector3();
  const islandTarget = new THREE.Vector3();
  let glowTimer = 0;
  let glowHasCity = false;

  // ── 遠景雲朵（Sprite） ──
  const cloudTex = createCloudTexture(91);
  const cloudMat = track(
    new THREE.SpriteMaterial({
      map: cloudTex ?? undefined,
      color: 0xf4f8fc,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    }),
  );
  const cloudSprites: THREE.Sprite[] = [];
  {
    const rng = mulberry32(0x51c0de);
    for (let i = 0; i < 9; i++) {
      const sprite = new THREE.Sprite(cloudMat);
      const a = (i / 9) * Math.PI * 2 + rng() * 0.35;
      const radius = (400 + rng() * 120) * VIEW_SCALE;
      sprite.position.set(Math.cos(a) * radius, (120 + rng() * 120) * VIEW_SCALE, Math.sin(a) * radius);
      const s = (100 + rng() * 110) * VIEW_SCALE;
      sprite.scale.set(s, s * (0.3 + rng() * 0.14), 1);
      sprite.renderOrder = -900;
      scene.add(sprite);
      cloudSprites.push(sprite);
    }
  }

  // ── 地面薄霧／海霧（晨昏／雨天／大霧／颱風） ──
  const mistTex = createCloudTexture(37);
  const mistMat = track(
    new THREE.MeshBasicMaterial({
      map: mistTex ?? undefined,
      color: 0xdde8ee,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    }),
  );
  const mistGeo = track(new THREE.PlaneGeometry(1, 1));
  mistGeo.rotateX(-Math.PI / 2);
  const mists: { mesh: THREE.Mesh; baseX: number; baseZ: number; phase: number }[] = [];
  {
    const rng = mulberry32(0x9a5e11);
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(mistGeo, mistMat);
      const baseX = (rng() - 0.5) * 130 * VIEW_SCALE;
      const baseZ = (rng() - 0.5) * 130 * VIEW_SCALE;
      mesh.position.set(baseX, 1.5 + rng() * 1.8, baseZ);
      const s = (30 + rng() * 40) * VIEW_SCALE;
      mesh.scale.set(s, 1, s * 0.8);
      mesh.rotation.y = rng() * Math.PI;
      mesh.renderOrder = -800;
      scene.add(mesh);
      mists.push({ mesh, baseX, baseZ, phase: rng() * 6.28 });
    }
  }

  // ── 霓虹光暈（夜間維港兩岸的粉色／青色光霧） ──
  const glowTex = createGlowTexture();
  const neonMats: THREE.SpriteMaterial[] = [];
  const neons: THREE.Sprite[] = [];
  {
    const specs: [number, number, number, number][] = [
      [0xff3d7f, -14, 5.5, 60], // 中環方向
      [0x24e0ff, 8, 5.0, 55], // 尖沙咀方向
      [0xffd166, -3, 6.0, 46], // 銅鑼灣方向
    ];
    for (const [hex, x, y, size] of specs) {
      const mat = track(
        new THREE.SpriteMaterial({
          map: glowTex ?? undefined,
          color: hex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(x * VIEW_SCALE, y, size * 0.55 * VIEW_SCALE);
      sprite.scale.set(size * VIEW_SCALE, size * 0.4 * VIEW_SCALE, 1);
      sprite.renderOrder = 400;
      sprite.visible = false;
      scene.add(sprite);
      neonMats.push(mat);
      neons.push(sprite);
    }
  }

  // ── 雨（LineSegments） ──
  const RAIN_COUNT = 3200;
  const rainGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x2a1f);
    const pos = new Float32Array(RAIN_COUNT * 2 * 3);
    const rnd = new Float32Array(RAIN_COUNT * 2);
    const tip = new Float32Array(RAIN_COUNT * 2);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (rng() - 0.5) * 82 * VIEW_SCALE;
      const y = rng() * 36 * Math.min(VIEW_SCALE, 2.2);
      const z = (rng() - 0.5) * 82 * VIEW_SCALE;
      const r = rng();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
        rnd[i * 2 + k] = r;
        tip[i * 2 + k] = k;
      }
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rainGeo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    rainGeo.setAttribute('aTip', new THREE.BufferAttribute(tip, 1));
  }
  const rainUniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(0.3, 0.1) },
    uFall: { value: 26 * Math.min(VIEW_SCALE, 1.6) },
    uHeight: { value: 36 * Math.min(VIEW_SCALE, 2.2) },
    uColor: { value: new THREE.Color(0xcfe0ee) },
    uOpacity: { value: 0.55 },
  };
  const rainMat = track(
    new THREE.ShaderMaterial({
      uniforms: rainUniforms,
      vertexShader: PRECIP_VERT,
      fragmentShader: PRECIP_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.name = 'rain';
  rain.frustumCulled = false;
  rain.visible = false;
  track(rain);
  scene.add(rain);

  // ── 雪（Points） ──
  const SNOW_COUNT = 2000;
  const snowGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x77aa);
    const pos = new Float32Array(SNOW_COUNT * 3);
    const rand = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      pos[i * 3] = (rng() - 0.5) * 82 * VIEW_SCALE;
      pos[i * 3 + 1] = rng() * 32 * Math.min(VIEW_SCALE, 2);
      pos[i * 3 + 2] = (rng() - 0.5) * 82 * VIEW_SCALE;
      rand[i] = rng();
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snowGeo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  }
  const snowUniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(0.3, 0.1) },
    uFall: { value: 4.5 * Math.min(VIEW_SCALE, 1.5) },
    uHeight: { value: 32 * Math.min(VIEW_SCALE, 2) },
    uSize: { value: 0.085 * Math.min(VIEW_SCALE, 2) },
    uColor: { value: new THREE.Color(0xffffff) },
    uOpacity: { value: 0.9 },
  };
  const snowMat = track(
    new THREE.ShaderMaterial({
      uniforms: snowUniforms,
      vertexShader: SNOW_VERT,
      fragmentShader: SNOW_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.name = 'snow';
  snow.frustumCulled = false;
  snow.visible = false;
  track(snow);
  scene.add(snow);

  // ── 螢火（春夏季郊野公園夜晚） ──
  const FIREFLY_COUNT = 110;
  const fireflyGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x3f19);
    const pos = new Float32Array(FIREFLY_COUNT * 3);
    const phase = new Float32Array(FIREFLY_COUNT);
    for (let i = 0; i < FIREFLY_COUNT; i++) {
      // 郊野公園（新界／大嶼山／港島南）
      const side = rng();
      let x: number;
      let z: number;
      if (side < 0.4) {
        x = -60 + rng() * 50;
        z = 10 + rng() * 30;
      } else if (side < 0.7) {
        x = 20 + rng() * 40;
        z = -60 + rng() * 35;
      } else {
        x = -10 + rng() * 40;
        z = 20 + rng() * 35;
      }
      pos[i * 3] = x * VIEW_SCALE;
      pos[i * 3 + 1] = 0.9 + rng() * 2.2;
      pos[i * 3 + 2] = z * VIEW_SCALE;
      phase[i] = rng();
    }
    fireflyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fireflyGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  }
  const fireflyUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uSize: { value: 0.15 },
    uColor: { value: new THREE.Color(0xffdd7a) },
  };
  const fireflyMat = track(
    new THREE.ShaderMaterial({
      uniforms: fireflyUniforms,
      vertexShader: FIREFLY_VERT,
      fragmentShader: FIREFLY_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
  fireflies.name = 'fireflies';
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  track(fireflies);
  scene.add(fireflies);

  // ── 飛鳥（麻鷹在維港上空盤旋） ──
  const BIRD_COUNT = 12;
  const birdGeo = track(new THREE.BufferGeometry());
  {
    const verts = new Float32Array([
      -0.62, 0, 0.05, 0, 0.04, 0, 0, 0.04, -0.2, 0.62, 0, 0.05, 0, 0.04, 0, 0, 0.04, -0.2,
    ]);
    birdGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    birdGeo.computeVertexNormals();
  }
  const birdMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x33342f,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      fog: false,
    }),
  );
  const birds = new THREE.InstancedMesh(birdGeo, birdMat, BIRD_COUNT);
  birds.name = 'birds';
  birds.frustumCulled = false;
  birds.visible = false;
  track(birds);
  scene.add(birds);
  const birdPhases: number[] = [];
  {
    const rng = mulberry32(0x6b1d);
    for (let i = 0; i < BIRD_COUNT; i++) birdPhases.push(rng() * Math.PI * 2);
  }

  // ── 閃電白光（貼在鏡頭前的 Sprite） ──
  const flashMat = track(
    new THREE.SpriteMaterial({
      map: glowTex ?? undefined,
      color: 0xe8f0ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  const flashSprite = new THREE.Sprite(flashMat);
  flashSprite.scale.set(260 * VIEW_SCALE, 260 * VIEW_SCALE, 1);
  flashSprite.renderOrder = 990;
  flashSprite.visible = false;
  scene.add(flashSprite);

  // ── 地名標籤（單一 billboard mesh） ──
  let labelMesh: THREE.Mesh | null = null;
  let labelMat: THREE.ShaderMaterial | null = null;
  {
    const names = HK_PLACES.map((p) => p.name);
    const atlas = createLabelAtlas(names);
    if (atlas) {
      track(atlas.texture);
      const verts = HK_PLACES.length * 4;
      const centers = new Float32Array(verts * 3);
      const offsets = new Float32Array(verts * 2);
      const uvs = new Float32Array(verts * 2);
      const majors = new Float32Array(verts);
      const indices: number[] = [];
      const kx = _state.width / 96;
      const ky = _state.height / 96;
      const TILE = 2;
      HK_PLACES.forEach((p, i) => {
        const x = (p.x * kx + 0.5) * TILE - (_state.width * TILE) / 2;
        const z = (p.y * ky + 0.5) * TILE - (_state.height * TILE) / 2;
        // 依地形高度決定標籤浮空高度
        const tx = Math.max(0, Math.min(_state.width - 1, Math.round(p.x * kx)));
        const ty = Math.max(0, Math.min(_state.height - 1, Math.round(p.y * ky)));
        const tile = _state.tiles[ty * _state.width + tx];
        // 標籤高度基準：貼近該格地形頂面（billboard 世界尺寸由 shader 按距離縮放）
        let baseY = tileTopY(tile) + 2.4;
        let height = 1.5;
        if (p.kind === 'mountain') {
          baseY = tileTopY(tile) + 2.6;
          height = 2.0;
        } else if (p.kind === 'water') {
          baseY = WATER_LABEL_Y;
          height = 1.7;
        } else if (p.kind === 'island') {
          baseY = tileTopY(tile) + 2.2;
          height = 1.45;
        } else if (p.kind === 'landmark') {
          baseY = tileTopY(tile) + 2.8;
          height = 1.05;
        } else if (p.kind === 'reservoir') {
          baseY = tileTopY(tile) + 2.2;
          height = 1.0;
        }
        const rect = atlas.rects[i];
        const w = height * rect.aspect;
        // UV 對應：CanvasTexture 預設 flipY=true，v=0 對應畫布底部、v=1 對應畫布頂部。
        // createLabelAtlas 回傳 v0 = 文字底部（較細）、v1 = 文字頂部（較大），
        // 因此 quad 底部要用 v0、頂部要用 v1，否則中文會上下倒轉／鏡像。
        const corners: [number, number, number, number][] = [
          [-w / 2, -height / 2, rect.u0, rect.v0],
          [w / 2, -height / 2, rect.u1, rect.v0],
          [w / 2, height / 2, rect.u1, rect.v1],
          [-w / 2, height / 2, rect.u0, rect.v1],
        ];
        const isMajor = TOP_LABELS.has(p.name) ? 2 : MAJOR_LABELS.has(p.name) ? 1 : 0;
        for (let k = 0; k < 4; k++) {
          const v = i * 4 + k;
          centers[v * 3] = x;
          centers[v * 3 + 1] = baseY;
          centers[v * 3 + 2] = z;
          offsets[v * 2] = corners[k][0];
          offsets[v * 2 + 1] = corners[k][1];
          uvs[v * 2] = corners[k][2];
          uvs[v * 2 + 1] = corners[k][3];
          majors[v] = isMajor;
        }
        const b = i * 4;
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      });
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(centers, 3));
      geo.setAttribute('aCenter', new THREE.BufferAttribute(centers, 3));
      geo.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 2));
      geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('aMajor', new THREE.BufferAttribute(majors, 1));
      geo.setIndex(indices);
      labelMat = track(
        new THREE.ShaderMaterial({
          uniforms: {
            uMap: { value: atlas.texture },
            uOpacity: { value: 1 },
            uCamRight: { value: new THREE.Vector3(1, 0, 0) },
            uCamUp: { value: new THREE.Vector3(0, 1, 0) },
            // 螢幕空間固定大小（offset 乘 dist * uSizeScale）
            uSizeScale: { value: 0.016 },
            // 近景／遠景淡入淡出（世界距離）
            uFadeNearA: { value: 25 },
            uFadeNearB: { value: 60 },
            uFadeFarA: { value: 2400 },
            uFadeFarB: { value: 3300 },
            // 次要地名在 overview 隱藏，中近景才顯示
            uMinorFadeA: { value: 650 },
            uMinorFadeB: { value: 950 },
            // 中層地名：中景才顯示（overview ~1250+ 距離會隱藏）
            uMidFadeA: { value: 700 },
            uMidFadeB: { value: 1000 },
          },
          vertexShader: LABEL_VERT,
          fragmentShader: LABEL_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          fog: false,
        }),
      );
      labelMesh = new THREE.Mesh(geo, labelMat);
      labelMesh.name = 'hk-map-labels';
      labelMesh.frustumCulled = false;
      labelMesh.renderOrder = 500;
      track(labelMesh);
      scene.add(labelMesh);
    }
  }

  // ── 每幀暫存 ──
  let time = 0;
  const dummy = new THREE.Object3D();
  let flash = 0;
  let nextFlash = 2 + Math.random() * 4;

  const weatherCloudiness: Record<Weather, number> = {
    clear: 0.14,
    cloudy: 0.62,
    rain: 0.86,
    storm: 1,
    fog: 0.5,
    snow: 0.72,
  };

  const updateCloudColor = (season: Season, weather: Weather, daylight: number): void => {
    switch (weather) {
      case 'cloudy':
        cloudMat.color.setHex(0xdfe5ea);
        skyUniforms.uCloudColor.value.setHex(0xe4e9ee);
        break;
      case 'rain':
        cloudMat.color.setHex(0x8d99a4);
        skyUniforms.uCloudColor.value.setHex(0x8f9aa4);
        break;
      case 'storm':
        cloudMat.color.setHex(0x5a5a70);
        skyUniforms.uCloudColor.value.setHex(0x565670);
        break;
      case 'fog':
        cloudMat.color.setHex(0xd8dee2);
        skyUniforms.uCloudColor.value.setHex(0xd8dee2);
        break;
      case 'snow':
        cloudMat.color.setHex(0xd4dde4);
        skyUniforms.uCloudColor.value.setHex(0xd8e0e6);
        break;
      default:
        cloudMat.color.setHex(0xf4f8fc);
        skyUniforms.uCloudColor.value.setHex(0xf0f5fa);
        break;
    }
    const golden = clamp01(1 - Math.abs(daylight - 0.16) / 0.22);
    if (golden > 0.01) {
      _c.setHex(0xf2b27a);
      cloudMat.color.lerp(_c, golden * 0.5);
      skyUniforms.uCloudColor.value.lerp(_c, golden * 0.35);
    }
    _c.setHex(0x1c2430);
    cloudMat.color.lerp(_c, (1 - daylight) * 0.55);
    skyUniforms.uCloudColor.value.lerp(_c, (1 - daylight) * 0.5);
    void season;
  };

  return {
    update(state: GameState, dt: number, camera: THREE.Camera): void {
      time += dt;
      if (state.ui.mode === 'interior') {
        // 室內模式：城市場景不渲染，跳過所有更新
        flashSprite.visible = false;
        return;
      }
      const { clock } = state;
      // empty 模式未有任何建築時，不應出現城市霓虹／兩岸燈火（由零開始完全空地）
      const cityAmbience = _state.gameMode !== 'empty' || state.buildings.length > 0;

      // ── 太陽／月亮／色彩 ──
      computeSun(clock.hour, clock.minute, clock.season, sun);
      computeMoonDir(clock.hour, clock.minute, clock.season, moonDir);
      sampleSkyPalette(clock.season, clock.weather, sun.daylight, palette);
      const weatherLight = weatherLightFactor(clock.weather);
      const daylight = sun.daylight;
      const night = 1 - clamp01(daylight * 1.25);
      updateCloudColor(clock.season, clock.weather, daylight);

      // ── 閃電（颱風） ──
      const storm = clock.weather === 'storm';
      if (storm) {
        nextFlash -= dt;
        if (nextFlash <= 0) {
          flash = 1;
          nextFlash = 1.4 + Math.random() * 4.2;
        }
      }
      flash = Math.max(0, flash - dt * 5.5);

      // ── 天空 ──
      const su = skyUniforms;
      (su.uZenith.value as THREE.Color).copy(palette.zenith);
      (su.uHorizon.value as THREE.Color).copy(palette.horizon).lerp(palette.fog, 0.55);
      (su.uSunDir.value as THREE.Vector3).copy(sun.dir);
      (su.uMoonDir.value as THREE.Vector3).copy(moonDir);
      (su.uSunColor.value as THREE.Color).copy(palette.sun);
      (su.uMoonColor.value as THREE.Color).copy(palette.moon);
      su.uDaylight.value = daylight;
      su.uNight.value = night;
      su.uCloudiness.value = weatherCloudiness[clock.weather];
      su.uTime.value = time;
      const wind = windStrength(clock.weather, clock.weatherIntensity);
      su.uCloudDrift.value = time * (storm ? 0.03 : 0.004) + wind * 0.01;
      su.uStarFade.value = clamp01((night - 0.25) / 0.75) * (clock.weather === 'clear' ? 1 : 0);
      su.uFlash.value = flash;
      su.uHazeWarm.value = clock.season === 'winter' ? 0.7 : 1;
      sky.position.copy(camera.position);
      {
        const camFar = (camera as THREE.PerspectiveCamera).far || 600;
        const skyRadius = Math.min(camFar * 0.9, SKY_RADIUS);
        sky.scale.setScalar(Math.max(MAP_SPAN * 1.15, skyRadius));
      }
      // 背景色：天空半球未覆蓋到的地平線以下區域顯示深海色
      (scene.background as THREE.Color).setRGB(
        0.05 + palette.horizon.r * 0.16,
        0.11 + palette.horizon.g * 0.16,
        0.15 + palette.horizon.b * 0.16,
      );

      // ── 霧 ──
      const fogDist = fogRange(clock.weather, daylight, VIEW_SCALE);
      fog.color.copy(palette.fog);
      fog.near = fogDist.near;
      fog.far = fogDist.far;

      // ── 光照 ──
      const isNight = sun.elevation < 0.015;
      const dir = isNight ? moonDir : sun.dir;
      lightDir.copy(dir);
      shadowDir.set(lightDir.x, Math.max(0.16, lightDir.y), lightDir.z).normalize();

      camera.getWorldDirection(cameraDir);
      let focusDist = 70;
      if (cameraDir.y < -0.05) focusDist = Math.min(240, Math.max(20, camera.position.y / -cameraDir.y));
      focus.copy(camera.position).addScaledVector(cameraDir, focusDist);
      const halfW = (state.width * 2) / 2 + 4;
      const halfH = (state.height * 2) / 2 + 4;
      focus.x = THREE.MathUtils.clamp(focus.x, -halfW, halfW);
      focus.z = THREE.MathUtils.clamp(focus.z, -halfH, halfH);
      focus.y = 0;
      sunLight.position.copy(focus).addScaledVector(shadowDir, 150);
      sunLight.target.position.copy(focus);
      sunLight.target.updateMatrixWorld();

      if (isNight) {
        (sunLight.color as THREE.Color).copy(palette.moon);
        sunLight.intensity = (0.38 + (1 - weatherLight) * 0.08) * clamp01(1 - daylight * 2);
        // 閃電時月光略亮
        sunLight.intensity += flash * 0.9;
      } else {
        (sunLight.color as THREE.Color).copy(palette.sun);
        sunLight.intensity = (0.42 + daylight * 0.95) * weatherLight;
      }
      (hemi.color as THREE.Color).copy(palette.hemiSky);
      (hemi.groundColor as THREE.Color).copy(palette.hemiGround);
      hemi.intensity = (0.22 + daylight * 0.4) * (0.72 + weatherLight * 0.28) + night * 0.14;
      (ambient.color as THREE.Color).copy(palette.ambient);
      ambient.intensity = 0.1 + daylight * 0.09 + night * 0.2;
      // 閃電照亮全場
      if (flash > 0.01) {
        ambient.intensity += flash * 0.4;
        hemi.intensity += flash * 0.28;
      }

      // ── 夜間暖色氛圍 + 兩岸城市燈火 ──
      if (night > 0.02 && cityAmbience) {
        (hemi.groundColor as THREE.Color).lerp(_c.setHex(0x76502a), night * 0.5);
        (ambient.color as THREE.Color).lerp(_c.setHex(0x9a7a52), night * 0.22);
        glowTimer += dt;
        if (glowTimer > 0.5) {
          glowTimer = 0;
          let sx = 0;
          let sz = 0;
          let n = 0;
          let kx = 0;
          let kz = 0;
          let kn = 0;
          for (const b of state.buildings) {
            const wx = (b.x + b.w / 2) * 2 - (state.width * 2) / 2;
            const wz = (b.y + b.h / 2) * 2 - (state.height * 2) / 2;
            sx += wx;
            sz += wz;
            n++;
            if (wz > 0) {
              kx += wx;
              kz += wz;
              kn++;
            }
          }
          if (n > 0) {
            // 港島（z>0）與九龍（z<0）分開平均，各一盞
            kowloonTarget.set(n > 0 ? sx / n : 0, 4.2, n > 0 ? sz / n : 0);
            islandTarget.set(kn > 0 ? kx / kn : 0, 4.2, kn > 0 ? kz / kn : 4);
            glowHasCity = true;
          } else {
            glowHasCity = false;
            // 未建城時：預設照亮中環與尖沙咀（維港兩岸天際線）
            kowloonTarget.set(8 * VIEW_SCALE, 5, -14 * VIEW_SCALE);
            islandTarget.set(-14 * VIEW_SCALE, 5, 12 * VIEW_SCALE);
          }
        }
        kowloonGlow.position.lerp(kowloonTarget, 0.08);
        islandGlow.position.lerp(islandTarget, 0.08);
        const base = night * Math.min(1, 0.3 + state.buildings.length * 0.015) * (glowHasCity ? 55 : 38);
        const stormDim = storm ? 0.55 : 1;
        kowloonGlow.intensity += (base * stormDim - kowloonGlow.intensity) * 0.08;
        islandGlow.intensity += (base * 0.9 * stormDim - islandGlow.intensity) * 0.08;
      } else {
        kowloonGlow.intensity += (0 - kowloonGlow.intensity) * 0.15;
        islandGlow.intensity += (0 - islandGlow.intensity) * 0.15;
      }

      // 霓虹光暈
      const neonOn = night > 0.25 && clock.weather !== 'snow' && cityAmbience;
      for (let i = 0; i < neons.length; i++) {
        neons[i].visible = neonOn;
        if (neonOn) {
          neonMats[i].opacity = 0.1 + night * 0.12 + flash * 0.1;
          neons[i].position.x += Math.sin(time * 0.05 + i) * 0.001;
        }
      }

      // ── 雲與霧 ──
      const cloudiness = weatherCloudiness[clock.weather];
      cloudMat.opacity = 0.18 + cloudiness * 0.5;
      for (let i = 0; i < cloudSprites.length; i++) {
        const sprite = cloudSprites[i];
        const a = time * (storm ? 0.02 : 0.0035) + i * 0.7;
        const radius = (405 + ((i * 53) % 110)) * VIEW_SCALE;
        const baseAngle = (i / cloudSprites.length) * Math.PI * 2;
        sprite.position.x = Math.cos(baseAngle + a) * radius;
        sprite.position.z = Math.sin(baseAngle + a) * radius;
        sprite.position.y = (120 + Math.sin(time * 0.02 + i) * 5 + i * 9) * VIEW_SCALE;
      }
      // 地面薄霧：晨昏、陰雨、大霧、颱風
      const hour = clock.hour + clock.minute / 60;
      const dawn = clamp01(1 - Math.abs(hour - 6.2) / 2.4);
      const dusk = clamp01(1 - Math.abs(hour - 18.0) / 2.2);
      const wet =
        clock.weather === 'rain'
          ? 0.65
          : clock.weather === 'storm'
            ? 1
            : clock.weather === 'fog'
              ? 1.15
              : clock.weather === 'snow'
                ? 0.45
                : clock.weather === 'cloudy'
                  ? 0.3
                  : 0;
      const mistAmount = Math.max(dawn * 0.42, dusk * 0.3, wet) * (0.35 + night * 0.2);
      mistMat.opacity = clamp01(mistAmount) * (clock.weather === 'fog' ? 0.72 : 0.4);
      mistMat.color.copy(palette.fog).lerp(_c2.setHex(0xf2f6f8), clock.weather === 'fog' ? 0.5 : 0.35);
      const mistVisible = mistMat.opacity > 0.01;
      for (const m of mists) {
        m.mesh.visible = mistVisible;
        if (mistVisible) {
          m.mesh.position.x = m.baseX + Math.sin(time * 0.03 + m.phase) * (storm ? 8 : 2.5);
          m.mesh.position.z = m.baseZ + Math.cos(time * 0.025 + m.phase) * (storm ? 6 : 2);
          m.mesh.rotation.y += dt * (storm ? 0.05 : 0.004);
        }
      }

      // ── 降水粒子 ──
      const kind = clock.weather === 'rain' || clock.weather === 'storm' ? 'rain' : clock.weather === 'snow' ? 'snow' : null;
      const intensity = clamp01(0.35 + clock.weatherIntensity * 0.65);
      rain.visible = kind === 'rain';
      snow.visible = kind === 'snow';
      const windAngle = 0.6 + (storm ? 0.4 : 0);
      if (kind === 'rain') {
        rainUniforms.uTime.value = time;
        rainUniforms.uCenter.value.set(camera.position.x, 0, camera.position.z);
        const windX = Math.cos(windAngle) * (storm ? 1.6 : 0.5) * wind;
        const windZ = Math.sin(windAngle) * (storm ? 0.9 : 0.5) * wind;
        (rainUniforms.uWind.value as THREE.Vector2).set(windX, windZ);
        rainUniforms.uFall.value = storm ? 46 + intensity * 26 : 24 + intensity * 12;
        rainUniforms.uOpacity.value = storm ? 0.4 + intensity * 0.4 : 0.32 + intensity * 0.35;
        (rainUniforms.uColor.value as THREE.Color)
          .setHex(storm ? 0xa8c0d4 : 0xbcd2e4)
          .multiplyScalar(0.45 + daylight * 0.7);
        const amount = storm ? 0.85 + intensity * 0.15 : 0.45 + intensity * 0.55;
        rainGeo.setDrawRange(0, Math.floor(RAIN_COUNT * 2 * clamp01(amount)));
      } else if (kind === 'snow') {
        snowUniforms.uTime.value = time;
        snowUniforms.uCenter.value.set(camera.position.x, 0, camera.position.z);
        (snowUniforms.uWind.value as THREE.Vector2).set(Math.cos(windAngle) * 0.35 * wind, Math.sin(windAngle) * 0.35 * wind);
        snowUniforms.uFall.value = 4 + intensity * 2.5;
        snowUniforms.uOpacity.value = 0.55 + intensity * 0.35;
        (snowUniforms.uColor.value as THREE.Color).setHex(0xffffff).multiplyScalar(0.55 + daylight * 0.6);
        snowGeo.setDrawRange(0, Math.floor(SNOW_COUNT * (0.4 + intensity * 0.6)));
      }

      // 閃電白光 Sprite（貼近鏡頭）
      flashSprite.visible = flash > 0.02;
      if (flashSprite.visible) {
        flashMat.opacity = flash * 0.22;
        camera.getWorldDirection(cameraDir);
        flashSprite.position.copy(camera.position).addScaledVector(cameraDir, 8);
      }

      // ── 螢火（春夏季郊野公園夜晚、晴天） ──
      const fireflySeason = clock.season === 'spring' || clock.season === 'summer';
      const fireflyOn =
        fireflySeason && night > 0.5 && clock.weather === 'clear';
      fireflies.visible = fireflyOn;
      if (fireflyOn) {
        fireflyUniforms.uTime.value = time;
        fireflyUniforms.uOpacity.value = clamp01((night - 0.4) * 2) * 0.9;
      }

      // ── 飛鳥（白天、非雨雪颱風） ──
      const birdsOn =
        daylight > 0.45 && clock.weather !== 'rain' && clock.weather !== 'storm' && clock.weather !== 'snow';
      birds.visible = birdsOn;
      if (birdsOn) {
        for (let i = 0; i < BIRD_COUNT; i++) {
          const ph = birdPhases[i];
          const radius = (24 + ((i * 37) % 44)) * VIEW_SCALE;
          const speed = 0.1 + (i % 5) * 0.012;
          const a = time * speed + ph;
          dummy.position.set(Math.cos(a) * radius - 4 * VIEW_SCALE, 20 + ((i * 13) % 14) + Math.sin(time * 0.7 + ph) * 1.5, Math.sin(a) * radius * 0.7 + 4 * VIEW_SCALE);
          dummy.rotation.set(0, -a + Math.PI / 2, Math.sin(time * 0.6 + ph) * 0.15);
          const flap = 0.55 + Math.abs(Math.sin(time * 7 + ph * 3)) * 0.75;
          dummy.scale.set(0.8 + (i % 3) * 0.12, flap, 0.8);
          dummy.updateMatrix();
          birds.setMatrixAt(i, dummy.matrix);
        }
        birds.instanceMatrix.needsUpdate = true;
      }

      // ── 地名標籤 ──
      if (labelMesh && labelMat) {
        const camDist = camera.position.length();
        const baseY = camera.position.y;
        // 拉遠才顯示，貼近地面時淡出
        const reveal = clamp01((baseY - 12) / 26) * clamp01((camDist + 10) / 60);
        const fogDim = clock.weather === 'fog' ? 0.25 : clock.weather === 'storm' ? 0.5 : 1;
        labelMat.uniforms.uOpacity.value = reveal * fogDim;
        labelMesh.visible = reveal > 0.02;
        // billboard 方向由鏡頭矩陣取得
        const e = camera.matrixWorld.elements;
        (labelMat.uniforms.uCamRight.value as THREE.Vector3).set(e[0], e[1], e[2]).normalize();
        (labelMat.uniforms.uCamUp.value as THREE.Vector3).set(e[4], e[5], e[6]).normalize();
        labelMat.uniforms.uCamRight.value.multiplyScalar(1);
      }

      // 標籤可見性
      void hash2d;
    },
    dispose(): void {
      scene.remove(
        sky,
        hemi,
        ambient,
        sunLight,
        sunLight.target,
        kowloonGlow,
        islandGlow,
        rain,
        snow,
        fireflies,
        birds,
        flashSprite,
      );
      for (const sprite of cloudSprites) scene.remove(sprite);
      for (const m of mists) scene.remove(m.mesh);
      for (const n of neons) scene.remove(n);
      if (labelMesh) scene.remove(labelMesh);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      if (scene.fog === fog) scene.fog = null;
    },
  };
}
