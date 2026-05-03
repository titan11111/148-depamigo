let DATA = null;
try {
  const req = new XMLHttpRequest();
  req.open("GET", "./scenario.json", false);
  req.send(null);
  if (req.status >= 200 && req.status < 300) {
    DATA = JSON.parse(req.responseText);
  } else {
    throw new Error("Failed to load scenario.json: " + req.status);
  }
} catch (e) {
  alert("scenario.json の読み込みに失敗しました。HTTPサーバー経由で開いてください。\n" + e.message);
  throw e;
}

const GAME_VERSION = "2.3.0";

let state = { courage: 0, observe: 0, anxiety: 0 };
let flag  = {};
let sceneMap = {};
DATA.scenes.forEach(s => sceneMap[s.id] = s);
let currentSceneId = null;
let typingTimer = null;
let isTyping = false;
let titleMenuIndex = 0;
let textPages = [];
let textPageIndex = 0;
let textDoneCallback = null;
let currentPageSpan = null;
let currentPageFullText = "";
let waitForClickAdvance = false;
let currentBgTheme = "bg-title";
let bgTick = 0;
let bgmTheme = "title";
let visitedFloors = new Set();

/** 終了時に scenario の endings.id へ直結（priority 判定は使わない） */
let pendingEndingId = null;

/** BAD END「屋上のピエロ」：暗闇からイラストが浮かび上がる（requestAnimationFrame と連動） */
let badEndRoofClownRevealStart = null;

const BAD_END_CLOWN_IMG_PATH = "./images/end-roof-clown.png";
const badEndClownImg = new Image();
badEndClownImg.src = BAD_END_CLOWN_IMG_PATH;

/** エンディング中の bg-end ムード（ハッピー時は暖色・粒子）。showEnding で設定 */
let endingBgMood = null;

/** シーン進行のタイマー／演出をまとめて中断（AbortController） */
let sceneFlowAbort = null;

/** 書記素単位タイプライター用（Intl.Segmenter） */
let graphemeSegmenter = null;

const KANJI_TUTORIAL_KEY = "depamaigo_kanji_tutorial_v21";
const REDUCED_MOTION_USER_KEY = "depamaigo_reduced_motion_user";

/** エンディング後にのみ漢字イベントを挟む（物語中は挿入しない） */
const IMPORTANT_KANJI_SCENES = new Set([]);

/** シーンごとの写真背景（WebP。キャンバスより軽量に運用） */
const BG_ASSET_BASE = "./assets/bg/";
/** 明示のみ。ルート a〜f は fallbackBackdropForRoute で補完 */
const SCENE_BACKGROUND_FILE = {
  s1_entrance: "scene_cosmetics_1f.webp",
  s2_branch: "scene_elevator_hall.webp",
  s2_hot: "scene_elevator_hall.webp",
  s2_cool: "scene_elevator_hall.webp",
  s2_split: "scene_elevator_hall.webp",
  s2_staff: "scene_elevator_hall.webp",
  s2_elevator: "scene_elevator_hall.webp",
  m1: "scene_cosmetics_1f.webp",
  m2: "scene_elevator_hall.webp",
  m3: "scene_cosmetics_1f.webp",
  m4: "scene_cosmetics_1f.webp"
};

function fallbackBackdropForRoute(sceneId) {
  const m = /^([a-f])(\d+)$/.exec(sceneId || "");
  if (!m) return null;
  const r = m[1];
  const n = parseInt(m[2], 10);
  if (r === "a") return n >= 3 ? "scene_rooftop.webp" : "scene_elevator_hall.webp";
  if (r === "b") return n <= 2 ? "scene_elevator_hall.webp" : (n <= 4 ? "scene_toy_4f.webp" : "scene_elevator_hall.webp");
  if (r === "c") return "scene_food_depachika.webp";
  if (r === "d") return n <= 2 ? "scene_elevator_hall.webp" : "scene_cosmetics_1f.webp";
  if (r === "e") return n <= 4 ? "scene_stationery_5f.webp" : "scene_cosmetics_1f.webp";
  if (r === "f") return "scene_stationery_5f.webp";
  return null;
}
let photoBackdropActive = false;

function setPhotoBackdrop(url) {
  photoBackdropActive = !!url;
  const bg = document.getElementById("bg");
  const screen = document.getElementById("screen");
  if (!bg || !screen) return;
  if (url) {
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.add("scene-photo");
    screen.classList.add("photo-backdrop");
  } else {
    bg.style.backgroundImage = "";
    bg.classList.remove("scene-photo");
    screen.classList.remove("photo-backdrop");
  }
}

function setPhotoBackdropFromScene(sceneId) {
  let file = SCENE_BACKGROUND_FILE[sceneId];
  if (!file) file = fallbackBackdropForRoute(sceneId);
  setPhotoBackdrop(file ? BG_ASSET_BASE + file : null);
}

/** 選択結果トースト用手がかりラベル */
const FLAG_NOTEBOOK_LABELS = {
  mother_hint_book: "文具売場付近の証言（警備の話）",
  mother_hint_logo: "紙袋のロゴ",
  mother_hint_announce: "館内放送の呼び出し",
  helped: "屋上係のヘルプ（無線）",
  mirror: "鏡の異変（トイレ）"
};

let statToastTimer = null;

function formatChoiceEffectFeedback(effect) {
  if (!effect) return "";
  const parts = [];
  for (const k in effect) {
    if (k === "courage" || k === "observe" || k === "anxiety") {
      const v = effect[k];
      if (!v) continue;
      const label = k === "courage" ? "勇気 ★" : k === "observe" ? "観察 ◆" : "不安 ▼";
      parts.push(`${label}${v > 0 ? "+" : ""}${v}`);
    } else if (effect[k]) {
      const hintLabel = FLAG_NOTEBOOK_LABELS[k];
      if (hintLabel) parts.push(`手がかり「${hintLabel}」`);
    }
  }
  return parts.join("　／　");
}

function showStatToast(effect) {
  const text = formatChoiceEffectFeedback(effect);
  const el = document.getElementById("stat-toast");
  if (!el || !text) return;
  el.textContent = text;
  el.classList.add("show");
  if (statToastTimer) clearTimeout(statToastTimer);
  statToastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/** prefers-reduced-motion またはユーザー設定 */
function prefersReducedMotion() {
  try {
    if (localStorage.getItem(REDUCED_MOTION_USER_KEY) === "1") return true;
  } catch (_) {}
  try {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

function cancelSpeech() {
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}
}

function abortSceneFlow() {
  if (sceneFlowAbort) {
    try { sceneFlowAbort.abort(); } catch (_) {}
    sceneFlowAbort = null;
  }
  cancelSpeech();
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  isTyping = false;
}

function beginSceneFlow() {
  abortSceneFlow();
  sceneFlowAbort = new AbortController();
  return sceneFlowAbort.signal;
}

function armTimeout(signal, ms, fn) {
  const id = setTimeout(() => {
    if (signal && signal.aborted) return;
    fn();
  }, ms);
  if (signal) signal.addEventListener("abort", () => clearTimeout(id), { once: true });
  return id;
}

function segmentStringToGraphemes(str) {
  const s = String(str);
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    if (!graphemeSegmenter) graphemeSegmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    return Array.from(graphemeSegmenter.segment(s), (seg) => seg.segment);
  }
  return [...s];
}

function computeQuestGoalLine() {
  const id = currentSceneId || "";
  if (/^m\d+$/.test(id)) return "母さんの午後";
  if (id === "s1_entrance") return "母さんを探す／まずは館内の方針を決める";
  if (id === "s2_branch") return "いまの気持ちの向きを、三つから選ぶ";
  if (id === "s2_hot") return "動きの強いルート（屋上／赤い服／レストラン）からひとつ";
  if (id === "s2_cool") return "エレベーターで行き先のフロア（3F・5F・7F）を選ぶ";
  if (id === "s2_split") return "迷ったときの三つ（合流あり）";
  if (id === "s2_staff") return "エレベーターで窓口・推理・本屋のフロアへ";
  const m = /^([a-f])(\d+)$/.exec(id);
  if (m) {
    const r = m[1];
    const n = parseInt(m[2], 10);
    const goals = {
      a: "屋上へ向かう噂を追う（終盤はホラー寄り）",
      b: "赤いカーディガンの人を追う",
      c: "レストラン街のにおいの方へ",
      d: "3Fの迷子相談へ向かう",
      e: "5Fで手がかりをたどる",
      f: "7Fの書籍売り場で待つ"
    };
    const base = goals[r] || "母さんを探す";
    return n >= 5 ? `${base} … いまは終盤` : base;
  }
  return "母さんを探す";
}

function updateQuestLine() {
  const el = document.getElementById("quest-line");
  if (el) el.textContent = computeQuestGoalLine();
}

async function animateFlashLayers(opts = {}) {
  const el = document.getElementById("flash");
  if (!el) return;
  const soft = prefersReducedMotion() || opts.soft;
  if (!el.animate) {
    el.style.opacity = soft ? "0.35" : "1";
    setTimeout(() => { el.style.opacity = "0"; }, soft ? 70 : 140);
    return;
  }
  const anim = el.animate(
    [{ opacity: 0 }, { opacity: soft ? 0.38 : 1 }, { opacity: 0 }],
    { duration: soft ? 120 : 240, easing: "ease-out", fill: "both" }
  );
  try { await anim.finished; } catch (_) {}
}

async function animateScreenAlertShake() {
  const screen = document.getElementById("screen");
  if (!screen) return;
  if (prefersReducedMotion()) {
    screen.classList.add("alert-soft");
    setTimeout(() => screen.classList.remove("alert-soft"), 900);
    return;
  }
  if (screen.animate) {
    try {
      await screen.animate(
        [
          { transform: "translate(0,0)" },
          { transform: "translate(-5px,4px)" },
          { transform: "translate(5px,-4px)" },
          { transform: "translate(0,0)" }
        ],
        { duration: 420, iterations: 3, easing: "ease-in-out" }
      ).finished;
    } catch (_) {}
  } else {
    screen.classList.add("alert");
    setTimeout(() => screen.classList.remove("alert"), 1200);
  }
}

function animateTextboxReveal() {
  const box = document.getElementById("textbox");
  if (!box || !box.animate) return;
  const dur = prefersReducedMotion() ? 80 : 220;
  box.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: dur, easing: "ease-out", fill: "both" });
}

function refreshMediaSession(sceneId) {
  if (!("mediaSession" in navigator)) return;
  const sc = sceneId && sceneMap[sceneId];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: sc ? `迷子デパート — ${sc.floor || sceneId}` : document.title.replace(/\s*\[.*?\]\s*$/, ""),
      artist: "迷子デパート",
      album: sc ? String(sceneId) : "タイトル"
    });
  } catch (_) {}
}

function refreshTtsUi() {
  const btn = document.getElementById("btn-tts");
  const lbl = document.getElementById("label-auto-tts");
  if (!btn || !lbl || !window.speechSynthesis) return;
  const voices = speechSynthesis.getVoices().filter((v) => /ja/i.test(v.lang));
  const ok = voices.length > 0;
  btn.hidden = !ok;
  lbl.hidden = !ok;
}

function speakCurrentTypingPage() {
  cancelSpeech();
  if (!window.speechSynthesis) return;
  const voices = speechSynthesis.getVoices().filter((v) => /ja/i.test(v.lang));
  if (!voices.length || !currentPageFullText.trim()) return;
  const u = new SpeechSynthesisUtterance(currentPageFullText);
  u.lang = "ja-JP";
  u.voice = voices[0];
  speechSynthesis.speak(u);
}

function maybeAutoSpeakPage() {
  const chk = document.getElementById("chk-auto-tts");
  if (chk && chk.checked && currentPageFullText.trim()) speakCurrentTypingPage();
}

const bgCanvas = document.getElementById("bgCanvas");
const bgCtx = bgCanvas.getContext("2d");

/* ===== サウンド（WebAudio：グラフ + SEバッファ + BGMクロスフェード） ===== */
const SE_FILES = {
  type: "type.wav",
  select: "select.wav",
  move: "move.wav",
  step: "step.wav",
  good: "good.wav",
  bad: "bad.wav",
  alert: "alert.wav",
  floor: "floor.wav",
  door: "door.wav",
  broadcast: "broadcast.wav"
};
const SE_BASE_PATH = "./assets/se/";
let ac = null;
let masterGain = null;
let bgmGain = null;
let bgmFilter = null;
let seGain = null;
let bgmIntervalTimer = null;
let bgmFadeArmTimer = null;
let bgmStep = 0;
let bgmCrossfadeMs = 980;
let audioBuffers = {};
let __seBuffersLoaded = false;

async function loadAudioBuffersOnce() {
  if (__seBuffersLoaded || !ac) return;
  const todo = Object.entries(SE_FILES);
  for (const [name, file] of todo) {
    try {
      const res = await fetch(SE_BASE_PATH + file);
      if (!res.ok) throw new Error(String(res.status));
      const raw = await res.arrayBuffer();
      audioBuffers[name] = await ac.decodeAudioData(raw);
    } catch (_) {
      audioBuffers[name] = null;
    }
  }
  __seBuffersLoaded = true;
}

function ensureAudioGraph() {
  if (!ac) return false;
  if (masterGain) return true;
  masterGain = ac.createGain();
  masterGain.gain.value = 0.42;
  bgmFilter = ac.createBiquadFilter();
  bgmFilter.type = "lowpass";
  bgmFilter.frequency.value = 2800;
  bgmFilter.Q.value = 0.85;
  bgmGain = ac.createGain();
  bgmGain.gain.value = 0;
  seGain = ac.createGain();
  seGain.gain.value = 0.92;
  bgmGain.connect(bgmFilter);
  bgmFilter.connect(masterGain);
  seGain.connect(masterGain);
  masterGain.connect(ac.destination);
  return true;
}

async function ensureAudioReady() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
  }
  ensureAudioGraph();
  if (ac.state === "suspended") {
    try { await ac.resume(); } catch (_) {}
  }
  await loadAudioBuffersOnce();
  applyBgmTheme(bgmTheme, currentSceneId);
  return ac;
}

/** beep は BGM／フォールバック兼用。dest を省略すると SE 用バスへ */
function beep(freq, dur = 0.06, type = "square", gain = 0.05, destNode = null) {
  if (!ac || !ensureAudioGraph()) return;
  const sink = destNode || seGain;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  o.connect(g).connect(sink);
  o.start();
  o.stop(ac.currentTime + dur);
}

function playBufferSe(name, velocity = 1) {
  if (!ac || !ensureAudioGraph()) return false;
  const buf = audioBuffers[name];
  if (!buf) return false;
  const src = ac.createBufferSource();
  const g = ac.createGain();
  src.buffer = buf;
  g.gain.value = Math.min(1.2, 0.65 * velocity);
  src.connect(g).connect(seGain);
  src.start();
  return true;
}

function se(name) {
  if (!ac || !ensureAudioGraph()) return;
  const mapFallthrough = {
    type: () => beep(2000, 0.012, "square", 0.05),
    select: () => { beep(880, 0.04, "square", 0.06); setTimeout(() => beep(1320, 0.05, "square", 0.055), 40); },
    move: () => beep(660, 0.03, "square", 0.06),
    step: () => { beep(130, 0.08, "sawtooth", 0.04); setTimeout(() => beep(92, 0.05, "triangle", 0.025), 26); },
    good: () => { beep(880, 0.08); setTimeout(() => beep(1320, 0.1), 80); setTimeout(() => beep(1760, 0.14), 180); },
    bad: () => { beep(220, 0.2, "sawtooth", 0.07); setTimeout(() => beep(110, 0.3, "sawtooth", 0.065), 200); },
    alert: () => { beep(1500, 0.08, "square", 0.07); setTimeout(() => beep(1500, 0.08, "square", 0.065), 200); setTimeout(() => beep(1500, 0.08, "square", 0.065), 400); },
    floor: () => { beep(660, 0.05); setTimeout(() => beep(880, 0.05), 60); setTimeout(() => beep(1100, 0.08), 120); }
  };
  if (playBufferSe(name)) return;
  const fb = mapFallthrough[name];
  if (fb) fb();
}

function playKanjiApproach(onDone) {
  let steps = 0;
  const timer = setInterval(() => {
    se("step");
    steps++;
    if (steps >= 6) {
      clearInterval(timer);
      if (onDone) onDone();
    }
  }, 180);
}

const BGM_PATTERNS = {
  title:   [220, 0, 330, 0, 247, 0, 196, 0],
  fun:     [392, 440, 392, 330, 392, 494, 523, 0],
  warm:    [294, 330, 349, 330, 294, 262, 294, 0],
  mystery: [247, 0, 220, 0, 196, 0, 233, 0],
  serious: [196, 0, 185, 0, 175, 0, 165, 0],
  danger:  [165, 0, 175, 0, 146, 0, 155, 0],
  relief:  [330, 349, 392, 349, 330, 294, 262, 0],
  kanji: [146, 0, 220, 0, 130, 0, 196, 0],
  end: [262, 330, 392, 330, 262, 220, 196, 0],
  truth: [262, 330, 392, 523, 494, 392, 330, 0],
  despair: [175, 0, 165, 0, 147, 0, 139, 0]
};

const SCENE_BGM_THEME = {
  s1_entrance: "mystery",
  s2_branch: "serious",
  s2_hot: "serious",
  s2_cool: "serious",
  s2_split: "serious",
  s2_staff: "serious",
  s2_elevator: "serious",
  m1: "warm",
  m2: "warm",
  m3: "relief",
  m4: "truth"
};

function resolveBgmTheme(sceneId) {
  if (!sceneId) return "title";
  if (SCENE_BGM_THEME[sceneId]) return SCENE_BGM_THEME[sceneId];
  const m = /^([a-f])(\d+)$/.exec(sceneId);
  if (m) {
    const r = m[1];
    const n = parseInt(m[2], 10);
    if (r === "a") return n >= 4 ? "danger" : "mystery";
    if (r === "b") return n >= 5 ? "danger" : "serious";
    if (r === "c") return "warm";
    if (r === "d") return n >= 4 ? "relief" : "serious";
    if (r === "e") return n >= 5 ? "warm" : "mystery";
    if (r === "f") return "mystery";
  }
  return "mystery";
}

function applyLocationBgmFilter(sceneId, startTime) {
  if (!bgmFilter || !ac) return;
  const t = startTime ?? ac.currentTime;
  let hz = 2900;
  if (!sceneId) {
    hz = 2800;
  } else if (/^a[4-6]$/.test(sceneId) || /^b[5-6]$/.test(sceneId)) {
    hz = 1150;
  } else if (/^[ac]/.test(sceneId)) {
    hz = /^c/.test(sceneId) ? 2600 : 1750;
  } else if (/^d[4-6]$/.test(sceneId)) {
    hz = 3000;
  }
  try {
    bgmFilter.frequency.cancelScheduledValues(t);
    bgmFilter.frequency.setValueAtTime(bgmFilter.frequency.value, t);
    bgmFilter.frequency.linearRampToValueAtTime(hz, t + 0.65);
  } catch (_) {
    bgmFilter.frequency.value = hz;
  }
}

function stopBgmLoop() {
  if (bgmIntervalTimer) {
    clearInterval(bgmIntervalTimer);
    bgmIntervalTimer = null;
  }
  if (bgmFadeArmTimer) {
    clearTimeout(bgmFadeArmTimer);
    bgmFadeArmTimer = null;
  }
}

function playProceduralBgmStep(pattern) {
  if (!ac || !ensureAudioGraph() || document.hidden) return;
  const f = pattern[bgmStep % pattern.length];
  if (f > 0) {
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.038, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    o.connect(g).connect(bgmGain);
    o.start(t);
    o.stop(t + 0.2);
    if (bgmStep % 2 === 0) {
      const o2 = ac.createOscillator();
      const g2 = ac.createGain();
      o2.type = "sine";
      o2.frequency.value = f / 2;
      g2.gain.setValueAtTime(0.001, t);
      g2.gain.linearRampToValueAtTime(0.015, t + 0.04);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o2.connect(g2).connect(bgmGain);
      o2.start(t);
      o2.stop(t + 0.24);
    }
  }
  bgmStep++;
}

function applyBgmTheme(theme, sceneIdForFx) {
  if (!ac || !ensureAudioGraph()) return;
  const durOut = Math.min(0.55, bgmCrossfadeMs / 2000 + 0.12);
  const durIn = Math.min(1.15, bgmCrossfadeMs / 1000 * 0.55 + 0.28);
  const now = ac.currentTime;

  stopBgmLoop();

  try {
    bgmGain.gain.cancelScheduledValues(now);
    bgmGain.gain.setValueAtTime(Math.max(0.0008, bgmGain.gain.value), now);
    bgmGain.gain.linearRampToValueAtTime(0.0008, now + durOut);
  } catch (_) {}

  bgmTheme = theme;
  const pattern = BGM_PATTERNS[theme] || BGM_PATTERNS.title;

  const resumeAt = Math.max(0, durOut * 1000 + 25);
  bgmFadeArmTimer = setTimeout(() => {
    bgmFadeArmTimer = null;
    if (!ac || !ensureAudioGraph()) return;
    const t0 = ac.currentTime;
    applyLocationBgmFilter(sceneIdForFx, t0);
    try {
      bgmGain.gain.cancelScheduledValues(t0);
      bgmGain.gain.setValueAtTime(0.0008, t0);
      bgmGain.gain.linearRampToValueAtTime(0.042, t0 + durIn);
    } catch (_) {}

    bgmStep = 0;
    bgmIntervalTimer = setInterval(() => playProceduralBgmStep(pattern), 220);
  }, resumeAt);
}

function setBgmTheme(theme, sceneIdOpt) {
  bgmTheme = theme;
  if (ac) applyBgmTheme(theme, sceneIdOpt ?? currentSceneId);
}

/* ===== タイトル画面UX ===== */
const titleButtons = [
  ...document.querySelectorAll("#title-menu button")
];
const ENDING_SAVE_KEY = "depamaigo_endings_v2";

function getValidEndingIds() {
  return new Set(DATA.endings.map((e) => e.id));
}

/** v2 のみ使用（旧 v1 は参照しない＝初回は未開放 0 から） */
function getUnlockedEndings() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDING_SAVE_KEY) || "[]");
    const arr = Array.isArray(raw) ? raw : [];
    const valid = getValidEndingIds();
    const cleanedRaw = [...new Set(arr.filter((id) => typeof id === "string" && valid.has(id)))];
    let cleaned;
    try {
      cleaned = structuredClone(cleanedRaw);
    } catch (_) {
      cleaned = cleanedRaw.slice();
    }
    if (JSON.stringify(arr) !== JSON.stringify(cleaned)) {
      localStorage.setItem(ENDING_SAVE_KEY, JSON.stringify(cleaned));
    }
    return cleaned;
  } catch (_) {
    return [];
  }
}
function unlockEnding(endingId) {
  if (!getValidEndingIds().has(endingId)) return;
  const unlocked = new Set(getUnlockedEndings());
  unlocked.add(endingId);
  const payload = structuredClone([...unlocked]);
  localStorage.setItem(ENDING_SAVE_KEY, JSON.stringify(payload));
  updateEndingCountLabel();
}
function updateEndingCountLabel() {
  const el = document.getElementById("title-ending-count");
  if (!el) return;
  const total = DATA.endings.length;
  const unlockedCount = getUnlockedEndings().length;
  const count = Math.min(total, unlockedCount);
  el.innerHTML = `エンディング開放数 <span class="title-ending-num">${count}</span>/<span class="title-ending-num">${total}</span>`;
  updateMotherButton();
}
function updateMotherButton() {
  const btn = document.getElementById("title-btn-mother");
  if (!btn) return;
  btn.style.display = getUnlockedEndings().length >= 1 ? "" : "none";
}
function extractFloorNumbers(label) {
  const matched = String(label || "").match(/(\d+)F/g) || [];
  return matched.map((v) => parseInt(v, 10));
}
function analyzeBranchGraph() {
  const edgeMap = {};
  const sceneIds = DATA.scenes.map((s) => s.id);
  DATA.scenes.forEach((sc) => {
    const nextSet = new Set();
    (sc.choices || []).forEach((c) => {
      const next = c.next || sc.next;
      if (next && next !== "ENDING") nextSet.add(next);
    });
    edgeMap[sc.id] = [...nextSet];
  });

  // 到達可能シーン（設計上）
  const reachableScenes = new Set();
  const q = ["s1_entrance"];
  while (q.length) {
    const id = q.shift();
    if (reachableScenes.has(id)) continue;
    reachableScenes.add(id);
    (edgeMap[id] || []).forEach((n) => {
      if (!reachableScenes.has(n)) q.push(n);
    });
  }

  const reachableFloors = new Set();
  DATA.scenes.forEach((sc) => {
    if (!reachableScenes.has(sc.id)) return;
    extractFloorNumbers(sc.floor).forEach((n) => reachableFloors.add(n));
  });

  return { edgeMap, sceneIds, reachableScenes, reachableFloors };
}
function updateFloorCheckLabel() {
  const el = document.getElementById("title-floor-check");
  if (!el) return;
  const { reachableFloors } = analyzeBranchGraph();
  const chunks = [];
  for (let f = 1; f <= 8; f++) {
    chunks.push(`${reachableFloors.has(f) ? "●" : "○"}${f}F`);
  }
  el.textContent = `到達可能: ${chunks.join(" ")}`;
}
function buildBranchMapText() {
  const { edgeMap, reachableFloors } = analyzeBranchGraph();
  const scene = (id) => DATA.scenes.find((s) => s.id === id);
  const lines = [];
  lines.push("【分岐可視化マップ】（検証用詳細は story-paths.spec.json）");
  lines.push("");
  lines.push("s1_entrance -> s2_branch（三択）");
  lines.push("s2_branch -> s2_hot | s2_cool | s2_split（各三択・合流あり）");
  lines.push("s2_hot -> a1|b1|c1／s2_cool -> d1|e1|f1／s2_split -> s2_hot|s2_cool|s2_staff／s2_staff -> d1|e1|f1");
  lines.push("各ルート a〜f はそれぞれ 6 シーン直列（例: a1→…→a6）→ ENDING（endingId で確定）");
  lines.push("");
  lines.push("【全シーンの接続】");
  Object.keys(edgeMap).sort().forEach((id) => {
    const nexts = edgeMap[id];
    lines.push(`- ${id} (${scene(id)?.floor || "?"}) -> ${nexts.length ? nexts.join(", ") : "（肢は ENDING のみ）"}`);
  });
  lines.push("");
  lines.push("【1F〜8F 到達可能チェック（設計上）】");
  for (let f = 1; f <= 8; f++) {
    lines.push(`- ${f}F: ${reachableFloors.has(f) ? "到達可能" : "この分岐設計では未使用"}`);
  }
  return lines.join("\n");
}
function openBranchMap() {
  const modal = document.getElementById("branchMapModal");
  const text = document.getElementById("branchMapText");
  text.textContent = buildBranchMapText();
  modal.style.display = "flex";
}
function closeBranchMap() {
  document.getElementById("branchMapModal").style.display = "none";
}
function isTitleVisible() {
  return document.getElementById("title").style.display !== "none";
}
function updateTitleFocus() {
  if (!titleButtons.length) return;
  titleButtons.forEach((btn, i) => {
    btn.classList.toggle("focused", i === titleMenuIndex);
  });
}
function moveTitleFocus(delta) {
  if (!titleButtons.length) return;
  titleMenuIndex = (titleMenuIndex + delta + titleButtons.length) % titleButtons.length;
  updateTitleFocus();
  se("move");
}
titleButtons.forEach((btn, i) => {
  btn.addEventListener("mouseenter", () => {
    titleMenuIndex = i;
    updateTitleFocus();
  });
  btn.addEventListener("touchstart", () => {
    titleMenuIndex = i;
    updateTitleFocus();
  }, { passive: true });
  btn.addEventListener("click", () => {
    ensureAudioReady();
  });
});
updateTitleFocus();
updateEndingCountLabel();
updateMotherButton();
updateFloorCheckLabel();

/* ===== 表示ユーティリティ ===== */
function resizeBgCanvas() {
  const rect = document.getElementById("screen").getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  bgCanvas.width = Math.floor(rect.width * dpr);
  bgCanvas.height = Math.floor(rect.height * dpr);
  bgCanvas.style.width = `${rect.width}px`;
  bgCanvas.style.height = `${rect.height}px`;
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeBgCanvas);
resizeBgCanvas();

/**
 * Canvas に画像を aspect 比を保ったまま全面表示（はみ出しトリム）。
 */
function drawImageCover(ctx, img, w, h) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const ir = iw / ih;
  const wr = w / h;
  let dw;
  let dh;
  let ox;
  let oy;
  if (ir > wr) {
    dh = h;
    dw = h * ir;
    ox = (w - dw) / 2;
    oy = 0;
  } else {
    dw = w;
    dh = w / ir;
    ox = 0;
    oy = (h - dh) / 2;
  }
  ctx.drawImage(img, ox, oy, dw, dh);
}

/**
 * 屋上ピエロBAD END用。イラストをゆっくり不透明度で出す（動きは付けない）。
 * @param {number} w
 * @param {number} h
 * @param {number} progress 0〜1
 */
function drawRoofClownBadEndOverlay(w, h, progress) {
  const p = Math.max(0, Math.min(1, progress));
  const ease = p * p * (3 - 2 * p);

  bgCtx.fillStyle = `rgb(2,2,3)`;
  bgCtx.fillRect(0, 0, w, h);

  const imgReady = badEndClownImg.complete && badEndClownImg.naturalWidth > 0;
  const reveal = Math.max(0, (ease - 0.06) / 0.94);

  if (imgReady && reveal > 0.008) {
    bgCtx.save();
    bgCtx.globalAlpha = Math.min(1, reveal * 0.97);
    drawImageCover(bgCtx, badEndClownImg, w, h);
    bgCtx.restore();
  } else {
    const vg = bgCtx.createRadialGradient(w * 0.5, h * 0.42, w * 0.08, w * 0.5, h * 0.45, w * 0.85);
    vg.addColorStop(0, `rgba(40, 20, 55, ${0.15 + 0.35 * ease})`);
    vg.addColorStop(1, `rgba(0, 0, 0, ${0.75 + 0.2 * ease})`);
    bgCtx.fillStyle = vg;
    bgCtx.fillRect(0, 0, w, h);
  }

  bgCtx.save();
  const vig = bgCtx.createRadialGradient(
    w * 0.5,
    h * 0.48,
    Math.max(w, h) * 0.12,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.78
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, `rgba(0,0,0,${0.42 + 0.28 * ease})`);
  bgCtx.fillStyle = vig;
  bgCtx.fillRect(0, 0, w, h);
  bgCtx.restore();
}

/**
 * ハッピーエンド用：フロアの灯りのような暖色と、淡く上がる粒子（待ちわく感）
 */
function drawHappyEndBackdropExtras(w, h, t) {
  const rm = prefersReducedMotion();
  const pulse = rm ? 0.88 : 0.52 + 0.48 * Math.sin(t * 1.12);

  const g = bgCtx.createRadialGradient(
    w * 0.5,
    h * 0.58,
    Math.max(20, w * 0.04),
    w * 0.5,
    h * 0.52,
    Math.max(w, h) * 0.58
  );
  g.addColorStop(0, `rgba(255, 224, 170, ${0.2 * pulse})`);
  g.addColorStop(0.38, `rgba(180, 120, 60, ${0.08 * pulse})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  bgCtx.fillStyle = g;
  bgCtx.fillRect(0, 0, w, h);

  const g2 = bgCtx.createRadialGradient(w * 0.5, h * 0.1, 4, w * 0.5, h * 0.14, w * 0.5);
  g2.addColorStop(0, `rgba(255, 248, 220, ${0.1 * pulse})`);
  g2.addColorStop(1, "rgba(0,0,0,0)");
  bgCtx.fillStyle = g2;
  bgCtx.fillRect(0, 0, w, h);

  const n = rm ? 7 : 15;
  for (let i = 0; i < n; i++) {
    const phase = (i * 0.71 + t * (rm ? 0.12 : 0.48)) % 1;
    const y = h * (0.9 - phase * 0.72);
    const x = w * (0.1 + ((i * 53 + Math.sin(t * 0.9 + i) * 40) % 1000) / 1000 * 0.8);
    const s = 1 + (i % 3);
    bgCtx.fillStyle = "rgba(255, 220, 160, 0.85)";
    bgCtx.globalAlpha = 0.08 + 0.22 * (1 - phase);
    bgCtx.fillRect(Math.floor(x), Math.floor(y), s, s);
  }
  bgCtx.globalAlpha = 1;
}

function drawSceneBackdrop(theme, t) {
  const w = bgCanvas.clientWidth || 800;
  const h = bgCanvas.clientHeight || 600;
  if (photoBackdropActive) return;

  bgCtx.clearRect(0, 0, w, h);

  const grad = bgCtx.createLinearGradient(0, 0, 0, h);
  if (theme === "bg-title") {
    grad.addColorStop(0, "#071126");
    grad.addColorStop(0.55, "#0c1b39");
    grad.addColorStop(1, "#04060e");
  } else if (theme === "bg-roof") {
    grad.addColorStop(0, "#6ca3c8");
    grad.addColorStop(0.65, "#2a4f72");
    grad.addColorStop(1, "#132233");
  } else if (theme === "bg-stair") {
    grad.addColorStop(0, "#222");
    grad.addColorStop(1, "#040404");
  } else if (theme === "bg-food") {
    grad.addColorStop(0, "#704022");
    grad.addColorStop(1, "#1f1209");
  } else if (theme === "bg-elevator") {
    grad.addColorStop(0, "#3a3a3a");
    grad.addColorStop(1, "#050505");
  } else if (theme === "bg-info") {
    grad.addColorStop(0, "#ffccdf");
    grad.addColorStop(1, "#8f3d75");
  } else if (theme === "bg-kanji") {
    grad.addColorStop(0, "#290f0f");
    grad.addColorStop(1, "#060101");
  } else if (theme === "bg-end") {
    if (endingBgMood === "happy") {
      grad.addColorStop(0, "#4d3520");
      grad.addColorStop(0.45, "#24160e");
      grad.addColorStop(1, "#0a0604");
    } else {
      grad.addColorStop(0, "#130909");
      grad.addColorStop(1, "#020202");
    }
  } else if (theme === "bg-toy") {
    grad.addColorStop(0, "#4a2e67");
    grad.addColorStop(1, "#1c1231");
  } else if (theme === "bg-book") {
    grad.addColorStop(0, "#4a3224");
    grad.addColorStop(0.55, "#261810");
    grad.addColorStop(1, "#0e0906");
  } else {
    grad.addColorStop(0, "#0a1a34");
    grad.addColorStop(1, "#02060f");
  }
  bgCtx.fillStyle = grad;
  bgCtx.fillRect(0, 0, w, h);

  const skipEndGrid =
    (theme === "bg-end" && badEndRoofClownRevealStart != null) ||
    (theme === "bg-end" && endingBgMood === "happy");

  if (theme === "bg-title") {
    // 夜のデパート外観
    const bW = w * 0.56;
    const bH = h * 0.58;
    const bx = (w - bW) / 2;
    const by = h * 0.20;
    bgCtx.fillStyle = "rgba(10,16,34,0.92)";
    bgCtx.fillRect(bx, by, bW, bH);

    // 遠景の街あかり
    bgCtx.fillStyle = "rgba(25,44,82,0.6)";
    for (let i = 0; i < 11; i++) {
      const tw = 26 + (i % 4) * 9;
      const th = 42 + (i % 5) * 16;
      const tx = 10 + i * ((w - 20) / 11);
      const ty = by + bH - th - 8;
      bgCtx.fillRect(tx, ty, tw, th);
      bgCtx.fillStyle = "rgba(150,215,255,0.14)";
      for (let wy = ty + 5; wy < ty + th - 4; wy += 9) {
        bgCtx.fillRect(tx + 4, wy, tw - 8, 2);
      }
      bgCtx.fillStyle = "rgba(25,44,82,0.6)";
    }

    // ガラス窓の明かり
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 10; col++) {
        const wx = bx + 16 + col * ((bW - 32) / 10);
        const wy = by + 16 + row * 54;
        const on = ((row + col + Math.floor(t * 2)) % 4) !== 0;
        bgCtx.fillStyle = on ? "rgba(150,220,255,0.28)" : "rgba(80,120,180,0.14)";
        bgCtx.fillRect(wx, wy, 24, 34);
      }
    }

    // ネオンサイン
    bgCtx.fillStyle = "rgba(255, 220, 156, 0.93)";
    bgCtx.font = '16px "Press Start 2P", monospace';
    bgCtx.fillText("DEPAMIGO", bx + bW * 0.33, by + 26);
    bgCtx.strokeStyle = "rgba(255,190,100,0.55)";
    bgCtx.strokeRect(bx + bW * 0.28, by + 8, bW * 0.44, 26);

    // 上空サーチライト
    const beamX = bx + bW * (0.25 + (Math.sin(t * 0.55) + 1) * 0.25);
    bgCtx.fillStyle = "rgba(180,225,255,0.13)";
    bgCtx.beginPath();
    bgCtx.moveTo(beamX - 14, by + 24);
    bgCtx.lineTo(beamX + 14, by + 24);
    bgCtx.lineTo(beamX + 170, 0);
    bgCtx.lineTo(beamX - 170, 0);
    bgCtx.closePath();
    bgCtx.fill();

    // 入口の光と導線
    const doorW = bW * 0.22;
    const doorX = bx + bW * 0.39;
    const doorY = by + bH - 94;
    bgCtx.fillStyle = "rgba(255,220,170,0.25)";
    bgCtx.fillRect(doorX, doorY, doorW, 78);
    bgCtx.fillStyle = "rgba(255,200,130,0.18)";
    bgCtx.beginPath();
    bgCtx.moveTo(doorX, doorY + 78);
    bgCtx.lineTo(doorX + doorW, doorY + 78);
    bgCtx.lineTo(doorX + doorW + 90, h);
    bgCtx.lineTo(doorX - 90, h);
    bgCtx.closePath();
    bgCtx.fill();

    // 入口ネオン矢印
    bgCtx.fillStyle = "rgba(255,214,132,0.8)";
    const arrowPulse = 0.65 + (Math.sin(t * 3.2) + 1) * 0.175;
    bgCtx.globalAlpha = arrowPulse;
    bgCtx.beginPath();
    bgCtx.moveTo(doorX - 26, doorY + 36);
    bgCtx.lineTo(doorX - 10, doorY + 26);
    bgCtx.lineTo(doorX - 10, doorY + 46);
    bgCtx.closePath();
    bgCtx.fill();
    bgCtx.beginPath();
    bgCtx.moveTo(doorX + doorW + 26, doorY + 36);
    bgCtx.lineTo(doorX + doorW + 10, doorY + 26);
    bgCtx.lineTo(doorX + doorW + 10, doorY + 46);
    bgCtx.closePath();
    bgCtx.fill();
    bgCtx.globalAlpha = 1;

    // 小さな人影（探索したくなる雰囲気）
    for (let i = 0; i < 4; i++) {
      const px = bx + 80 + i * 92 + Math.sin(t * 0.7 + i) * 4;
      const py = h - 46 + (i % 2 ? 2 : 0);
      bgCtx.fillStyle = "rgba(12,18,30,0.95)";
      bgCtx.fillRect(px, py - 18, 8, 18);
      bgCtx.fillRect(px - 2, py - 24, 12, 8);
    }

    // 低い霧
    for (let i = 0; i < 3; i++) {
      const mx = ((t * (12 + i * 6)) + i * 220) % (w + 300) - 220;
      const my = h - 86 - i * 18;
      const mg = bgCtx.createRadialGradient(mx, my, 6, mx, my, 160 + i * 40);
      mg.addColorStop(0, "rgba(170,215,255,0.14)");
      mg.addColorStop(1, "rgba(170,215,255,0)");
      bgCtx.fillStyle = mg;
      bgCtx.fillRect(mx - 220, my - 120, 440, 240);
    }
  }

  // 共通の床線（屋上ピエロBAD終幕時は暗幕演出の邪魔になるので省略）
  if (!skipEndGrid) {
    bgCtx.strokeStyle = "rgba(180,220,255,0.15)";
    for (let i = 0; i < 7; i++) {
      const y = h * 0.58 + i * 32;
      bgCtx.beginPath();
      bgCtx.moveTo(0, y);
      bgCtx.lineTo(w, y);
      bgCtx.stroke();
    }
  }

  if (theme === "bg-roof") {
    bgCtx.fillStyle = "rgba(230, 245, 255, 0.85)";
    for (let i = 0; i < 24; i++) {
      bgCtx.fillRect((i * 79 + t * 10) % w, 40 + (i * 37) % 140, 2, 2);
    }
    // 観覧車
    const cx = w * 0.78, cy = h * 0.42, r = 86;
    bgCtx.strokeStyle = "rgba(255,255,255,0.45)";
    bgCtx.lineWidth = 2;
    bgCtx.beginPath();
    bgCtx.arc(cx, cy, r, 0, Math.PI * 2);
    bgCtx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + t * 0.6;
      bgCtx.beginPath();
      bgCtx.moveTo(cx, cy);
      bgCtx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      bgCtx.stroke();
      bgCtx.fillStyle = "rgba(255, 220, 140, 0.9)";
      bgCtx.fillRect(cx + Math.cos(a) * (r + 2) - 4, cy + Math.sin(a) * (r + 2) - 4, 8, 8);
    }
  } else if (theme === "bg-toy") {
    // 本棚シルエット（おもちゃ売り場）
    bgCtx.fillStyle = "rgba(12, 8, 24, 0.85)";
    bgCtx.fillRect(40, 120, w - 80, 360);
    bgCtx.fillStyle = "rgba(240, 180, 90, 0.45)";
    for (let y = 140; y < 430; y += 64) {
      for (let x = 60; x < w - 80; x += 22) {
        bgCtx.fillRect(x, y, 14, 48 - (x % 3) * 4);
      }
    }
  } else if (theme === "bg-book") {
    bgCtx.fillStyle = "rgba(42, 26, 14, 0.9)";
    bgCtx.fillRect(38, 118, w - 76, 368);
    bgCtx.fillStyle = "rgba(215, 165, 82, 0.48)";
    for (let y = 138; y < 432; y += 62) {
      for (let x = 56; x < w - 76; x += 20) {
        bgCtx.fillRect(x, y, 12, 46 - (x % 4) * 3);
      }
    }
    bgCtx.fillStyle = "rgba(255, 246, 220, 0.06)";
    bgCtx.fillRect(52, 132, w - 104, 28);
  } else if (theme === "bg-elevator") {
    bgCtx.fillStyle = "rgba(20,20,20,0.85)";
    bgCtx.fillRect(w * 0.3, 90, w * 0.4, h - 160);
    bgCtx.strokeStyle = "rgba(255,220,150,0.65)";
    bgCtx.strokeRect(w * 0.45, 130, 42, 24);
    const p = 3 + (Math.floor(t * 4) % 6);
    bgCtx.fillStyle = "#ffd27a";
    bgCtx.font = '12px "Press Start 2P", monospace';
    bgCtx.fillText(`${p}F`, w * 0.462, 148);
  } else if (theme === "bg-info") {
    bgCtx.fillStyle = "rgba(255,255,255,0.75)";
    bgCtx.fillRect(w * 0.16, h * 0.3, w * 0.68, h * 0.22);
    bgCtx.fillStyle = "rgba(140,70,110,0.6)";
    bgCtx.fillRect(w * 0.16, h * 0.3, w * 0.68, 30);
  } else if (theme === "bg-kanji") {
    bgCtx.fillStyle = "rgba(0,0,0,0.65)";
    bgCtx.fillRect(0, 0, w, h);
    bgCtx.fillStyle = "rgba(255,220,150,0.08)";
    bgCtx.font = "120px serif";
    bgCtx.fillText("漢", w * 0.15 + Math.sin(t * 2) * 8, h * 0.55);
    bgCtx.fillText("字", w * 0.56 + Math.cos(t * 2) * 8, h * 0.5);
  }

  if (theme === "bg-end" && endingBgMood === "happy") {
    drawHappyEndBackdropExtras(w, h, t);
  }

  if (theme === "bg-end" && badEndRoofClownRevealStart != null) {
    const elapsed = performance.now() - badEndRoofClownRevealStart;
    const dur = prefersReducedMotion() ? 520 : 11500;
    const linear = Math.min(1, elapsed / dur);
    drawRoofClownBadEndOverlay(w, h, linear);
  }
}

function startBackgroundLoop() {
  const loop = (ts) => {
    bgTick = ts * 0.001;
    drawSceneBackdrop(currentBgTheme, bgTick);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
startBackgroundLoop();

setPhotoBackdrop(BG_ASSET_BASE + "scene_exterior.webp");

function setBG(cls) {
  currentBgTheme = cls || "bg-title";
}
function showFloor(label) {
  if (!label) return;
  const t = document.getElementById("floor-telop");
  t.textContent = label;
  t.classList.add("show");
  se("floor");
  setTimeout(()=>t.classList.remove("show"), 1600);
}
function updateHUD() {
  document.getElementById("hud-courage").textContent = `勇気 ★ ${state.courage}`;
  document.getElementById("hud-observe").textContent = `観察 ◆ ${state.observe}`;
  document.getElementById("hud-anxiety").textContent = `不安 ▼ ${state.anxiety}`;
}
function flash(opts) {
  void animateFlashLayers(typeof opts === "object" ? opts : { soft: !!opts });
}

function paginateText(text) {
  const box = document.getElementById("textbox");
  const style = getComputedStyle(box);
  const tempCanvas = document.createElement("canvas");
  const mctx = tempCanvas.getContext("2d");
  mctx.font = `${style.fontSize} ${style.fontFamily}`;

  const maxWidth = Math.max(80, box.clientWidth - 8);
  const lineHeight = parseFloat(style.lineHeight) || 26;
  const maxLines = Math.max(1, Math.floor((box.clientHeight - 8) / lineHeight));

  const lines = [];
  const srcLines = String(text).split("\n");
  srcLines.forEach((src) => {
    if (src.length === 0) {
      lines.push("");
      return;
    }
    let row = "";
    const glyphs = segmentStringToGraphemes(src);
    for (let gi = 0; gi < glyphs.length; gi++) {
      const ch = glyphs[gi];
      const candidate = row + ch;
      if (mctx.measureText(candidate).width > maxWidth && row.length > 0) {
        lines.push(row);
        row = ch;
      } else {
        row = candidate;
      }
    }
    lines.push(row);
  });

  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join("\n"));
  }
  return pages.length ? pages : [""];
}

function finishTypingImmediately() {
  cancelSpeech();
  if (!isTyping) return;
  clearInterval(typingTimer);
  typingTimer = null;
  if (currentPageSpan) currentPageSpan.textContent = currentPageFullText;
  isTyping = false;
}

function runTextDoneCallbackIfNeeded() {
  const cb = textDoneCallback;
  textDoneCallback = null;
  if (cb) cb();
}

function showPage(index) {
  const box = document.getElementById("textbox");
  box.innerHTML = "";
  const span = document.createElement("span");
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  box.appendChild(span);
  box.appendChild(cursor);

  currentPageSpan = span;
  currentPageFullText = textPages[index] || "";
  const glyphs = segmentStringToGraphemes(currentPageFullText);
  let gi = 0;
  let tick = 0;
  isTyping = true;
  if (typingTimer) clearInterval(typingTimer);

  typingTimer = setInterval(() => {
    if (gi >= glyphs.length) {
      clearInterval(typingTimer);
      typingTimer = null;
      isTyping = false;
      maybeAutoSpeakPage();
      return;
    }
    const ch = glyphs[gi++];
    span.textContent += ch;
    if (ch !== "\n" && ch !== " " && ch !== "\u3000" && (tick++ % 2 === 0)) se("type");
  }, 26);
}

function typeText(text, onDone) {
  cancelSpeech();
  if (typingTimer) clearInterval(typingTimer);
  animateTextboxReveal();
  textPages = paginateText(text);
  textPageIndex = 0;
  textDoneCallback = onDone || null;
  waitForClickAdvance = textPages.length > 1;
  showPage(textPageIndex);

  if (!waitForClickAdvance && !onDone) return;
  if (!waitForClickAdvance && onDone) {
    const checkDone = setInterval(() => {
      if (!isTyping) {
        clearInterval(checkDone);
        runTextDoneCallbackIfNeeded();
      }
    }, 30);
  }
}

document.getElementById("textbox").addEventListener("click", () => {
  if (!textDoneCallback && !isTyping) return;

  if (isTyping) {
    finishTypingImmediately();
    return;
  }

  if (textPageIndex < textPages.length - 1) {
    cancelSpeech();
    textPageIndex++;
    showPage(textPageIndex);
    return;
  }

  runTextDoneCallbackIfNeeded();
});

/* ===== ポートレート（SVG） ===== */
function setPortrait(kind) {
  const p = document.getElementById("portrait");
  if (!kind) { p.style.display = "none"; p.innerHTML = ""; return; }
  p.style.display = "block";
  if (kind === "kanji") {
    p.innerHTML = `
      <rect x="40" y="20" width="100" height="20" fill="#444"/>
      <rect x="35" y="35" width="110" height="80" fill="#d8b080"/>
      <text x="90" y="92" text-anchor="middle" font-size="48" font-weight="bold" fill="#111" font-family="serif">漢</text>
      <rect x="30" y="115" width="120" height="100" fill="#4b3a25"/>
      <rect x="80" y="115" width="20" height="100" fill="#2a1f15"/>
      <rect x="120" y="160" width="40" height="30" fill="#fff" stroke="#000" stroke-width="2"/>
      <text x="140" y="180" text-anchor="middle" font-size="14" fill="#000">漢字</text>
    `;
  } else if (kind === "info") {
    p.innerHTML = `
      <rect x="35" y="20" width="110" height="80" fill="#fce4ec"/>
      <circle cx="90" cy="60" r="32" fill="#fce4ec"/>
      <rect x="60" y="30" width="60" height="20" fill="#5a3a2a"/>
      <rect x="70" y="60" width="6" height="6" fill="#000"/>
      <rect x="104" y="60" width="6" height="6" fill="#000"/>
      <rect x="80" y="78" width="20" height="3" fill="#a55"/>
      <rect x="30" y="100" width="120" height="115" fill="#e91e63"/>
      <rect x="60" y="100" width="60" height="115" fill="#fff"/>
    `;
  } else if (kind === "toy-staff") {
    p.innerHTML = `
      <rect x="30" y="20" width="120" height="70" fill="#ffd39a"/>
      <rect x="65" y="40" width="50" height="16" fill="#5b3d2a"/>
      <rect x="70" y="60" width="6" height="6" fill="#000"/><rect x="104" y="60" width="6" height="6" fill="#000"/>
      <rect x="80" y="78" width="22" height="4" fill="#a55"/>
      <rect x="25" y="92" width="130" height="122" fill="#4aa3ff"/>
      <rect x="55" y="130" width="70" height="30" fill="#ffe07a"/>
    `;
  } else if (kind === "food-staff") {
    p.innerHTML = `
      <rect x="28" y="24" width="124" height="60" fill="#fbe0c2"/>
      <rect x="42" y="20" width="96" height="20" fill="#fff"/>
      <rect x="68" y="56" width="7" height="7" fill="#000"/><rect x="105" y="56" width="7" height="7" fill="#000"/>
      <rect x="80" y="76" width="24" height="4" fill="#c76"/>
      <rect x="22" y="90" width="136" height="124" fill="#f39c6b"/>
      <rect x="126" y="140" width="34" height="22" fill="#fff" stroke="#000" stroke-width="2"/>
    `;
  } else if (kind === "book-staff") {
    p.innerHTML = `
      <rect x="34" y="20" width="112" height="70" fill="#f0d7c1"/>
      <rect x="58" y="38" width="64" height="14" fill="#2f2f2f"/>
      <rect x="70" y="60" width="6" height="6" fill="#000"/><rect x="104" y="60" width="6" height="6" fill="#000"/>
      <rect x="82" y="78" width="20" height="3" fill="#855"/>
      <rect x="30" y="94" width="120" height="120" fill="#7a5aa8"/>
      <rect x="48" y="136" width="84" height="46" fill="#fff2a6" stroke="#000" stroke-width="2"/>
    `;
  } else if (kind === "art-staff") {
    p.innerHTML = `
      <rect x="34" y="20" width="112" height="70" fill="#f0d7c1"/>
      <rect x="52" y="34" width="76" height="16" fill="#4a8f6a"/>
      <rect x="70" y="60" width="6" height="6" fill="#000"/><rect x="104" y="60" width="6" height="6" fill="#000"/>
      <rect x="82" y="78" width="20" height="3" fill="#855"/>
      <rect x="30" y="94" width="120" height="120" fill="#5a4a7a"/>
      <rect x="44" y="128" width="92" height="52" fill="#e8f4e0" stroke="#000" stroke-width="2"/>
      <circle cx="62" cy="148" r="8" fill="#c44"/>
      <rect x="96" y="140" width="18" height="6" fill="#2a4a6a"/>
    `;
  } else if (kind === "cleaner") {
    p.innerHTML = `
      <rect x="36" y="24" width="108" height="66" fill="#e7d5c5"/>
      <rect x="52" y="30" width="76" height="16" fill="#bdbdbd"/>
      <rect x="68" y="58" width="6" height="6" fill="#000"/><rect x="103" y="58" width="6" height="6" fill="#000"/>
      <rect x="80" y="77" width="20" height="3" fill="#755"/>
      <rect x="26" y="92" width="128" height="122" fill="#8aa3b5"/>
      <rect x="18" y="136" width="18" height="72" fill="#9a7b58"/>
    `;
  } else if (kind === "rooftop") {
    p.innerHTML = `
      <rect x="35" y="24" width="110" height="64" fill="#e8c9a6"/>
      <rect x="45" y="22" width="90" height="18" fill="#2f5b8f"/>
      <rect x="68" y="56" width="6" height="6" fill="#000"/><rect x="104" y="56" width="6" height="6" fill="#000"/>
      <rect x="82" y="76" width="20" height="4" fill="#955"/>
      <rect x="28" y="90" width="124" height="124" fill="#4f7d4f"/>
    `;
  } else if (kind === "businessman") {
    p.innerHTML = `
      <rect x="36" y="24" width="108" height="66" fill="#e5cdb9"/>
      <rect x="56" y="34" width="68" height="18" fill="#323232"/>
      <rect x="69" y="58" width="6" height="6" fill="#000"/><rect x="103" y="58" width="6" height="6" fill="#000"/>
      <rect x="81" y="77" width="20" height="3" fill="#744"/>
      <rect x="30" y="90" width="120" height="124" fill="#2b3f66"/>
      <rect x="84" y="104" width="12" height="108" fill="#5b2233"/>
    `;
  } else if (kind === "guard") {
    p.innerHTML = `
      <rect x="36" y="24" width="108" height="66" fill="#e7cfba"/>
      <rect x="50" y="24" width="80" height="14" fill="#1e2940"/>
      <rect x="70" y="58" width="6" height="6" fill="#000"/><rect x="104" y="58" width="6" height="6" fill="#000"/>
      <rect x="82" y="77" width="20" height="3" fill="#744"/>
      <rect x="28" y="90" width="124" height="124" fill="#37465f"/>
      <rect x="132" y="128" width="10" height="66" fill="#777"/>
    `;
  } else if (kind === "announcer") {
    p.innerHTML = `
      <rect x="18" y="24" width="144" height="186" fill="#202530"/>
      <rect x="28" y="36" width="124" height="56" fill="#89a9c6"/>
      <rect x="36" y="48" width="108" height="10" fill="#0d1a29"/>
      <rect x="36" y="66" width="88" height="8" fill="#0d1a29"/>
      <rect x="36" y="82" width="70" height="8" fill="#0d1a29"/>
      <circle cx="130" cy="142" r="22" fill="#a7b4c4"/>
      <rect x="84" y="156" width="66" height="8" fill="#0d1a29"/>
    `;
  } else if (kind === "mother") {
    p.innerHTML = `
      <rect x="34" y="20" width="112" height="70" fill="#f5d7c5"/>
      <rect x="56" y="34" width="68" height="20" fill="#6b3f33"/>
      <rect x="70" y="60" width="6" height="6" fill="#000"/><rect x="104" y="60" width="6" height="6" fill="#000"/>
      <rect x="80" y="78" width="22" height="3" fill="#a55"/>
      <rect x="26" y="92" width="128" height="122" fill="#be3d3d"/>
      <rect x="106" y="136" width="44" height="30" fill="#fff" stroke="#000" stroke-width="2"/>
    `;
  }
}

/* ===== ゲーム進行 ===== */
function startIntro() {
  ensureAudioReady();
  setBgmTheme("title", null);
  setBG("bg-title");
  document.getElementById("title").style.display = "none";
  const intro = document.getElementById("intro");
  const text = document.getElementById("intro-text");
  text.textContent = DATA.intro;
  intro.style.display = "block";

  const skip = (e) => {
    if (e.type === "keydown" && !["Space","KeyZ","Enter"].includes(e.code)) return;
    cancelSpeech();
    intro.style.display = "none";
    window.removeEventListener("keydown", skip);
    intro.removeEventListener("click", skip);
    startGame();
  };
  window.addEventListener("keydown", skip);
  intro.addEventListener("click", skip);
  setTimeout(() => {
    if (intro.style.display !== "none") {
      intro.style.display = "none";
      window.removeEventListener("keydown", skip);
      startGame();
    }
  }, 32000);
}

function startGame() {
  ensureAudioReady();
  abortSceneFlow();
  state = structuredClone({ courage: 0, observe: 0, anxiety: 0 });
  flag = structuredClone({});
  visitedFloors = new Set();
  pendingEndingId = null;
  badEndRoofClownRevealStart = null;
  endingBgMood = null;
  const scr = document.getElementById("screen");
  if (scr) scr.classList.remove("ending-true", "ending-bad", "ending-neutral", "ending-happy");
  document.getElementById("title").style.display = "none";
  document.getElementById("intro").style.display = "none";
  document.getElementById("hud").style.display = "flex";
  setPortrait(null);
  updateHUD();
  updateQuestLine();
  refreshTtsUi();
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      if (!est.quota) return;
      const ratio = est.usage / est.quota;
      if (ratio <= 0.88) return;
      const el = document.getElementById("stat-toast");
      if (!el) return;
      el.textContent = "ブラウザの保存領域が逼迫しています。サイトデータの削除やこのゲームのセーブ消去も検討してください。";
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 5200);
    }).catch(() => {});
  }
  enterScene("s1_entrance");
}
function startMotherRoute() {
  if (getUnlockedEndings().length < 1) return;
  ensureAudioReady();
  abortSceneFlow();
  state = structuredClone({ courage: 0, observe: 0, anxiety: 0 });
  flag = structuredClone({});
  visitedFloors = new Set();
  pendingEndingId = null;
  badEndRoofClownRevealStart = null;
  endingBgMood = null;
  const scr2 = document.getElementById("screen");
  if (scr2) scr2.classList.remove("ending-true", "ending-bad", "ending-neutral", "ending-happy");
  document.getElementById("title").style.display = "none";
  document.getElementById("intro").style.display = "none";
  document.getElementById("hud").style.display = "flex";
  setPortrait(null);
  updateHUD();
  updateQuestLine();
  refreshTtsUi();
  enterScene("m1");
}
function onContinueFromTitle() {
  ensureAudioReady();
  se("bad");
  alert("まだ迷子になっていません");
}

function updateRouteClass(sceneId) {
  const screen = document.getElementById("screen");
  if (!screen) return;
  screen.classList.remove("route-a","route-b","route-c","route-d","route-e","route-f","route-m");
  const m = /^([a-fm])(\d+)$/.exec(sceneId || "");
  if (m) screen.classList.add(`route-${m[1]}`);
}

function enterScene(id) {
  const signal = beginSceneFlow();
  currentSceneId = id;
  updateRouteClass(id);
  const sc = sceneMap[id];
  setBG(sc.bg);
  setPhotoBackdropFromScene(id);
  setBgmTheme(resolveBgmTheme(id), id);
  extractFloorNumbers(sc.floor).forEach((n) => visitedFloors.add(n));
  showFloor(sc.floor);
  document.getElementById("speaker").textContent = sc.speaker || "";
  document.getElementById("choices").innerHTML = "";
  setPortrait(sc.portrait || null);
  refreshMediaSession(id);
  updateQuestLine();

  let displayText = sc.text;
  if (id === "a3" && getUnlockedEndings().includes("end_deduction")) {
    displayText = sc.text + "\n\nよく見ると、着ぐるみの足元に\n「本日最終公演」と書かれた紙が\n折り畳まれて落ちていた。";
  }

  armTimeout(signal, 700, () => {
    typeText(displayText, () => {
      renderChoices(sc);
    });
  });
}

function renderChoices(sc) {
  const box = document.getElementById("choices");
  box.innerHTML = "";
  sc.choices.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "choice-button";
    btn.textContent = `${i+1}. ${c.label}`;
    btn.onmouseenter = () => se("move");
    btn.onclick = () => onChoose(sc, c);
    box.appendChild(btn);
  });
}

function onChoose(sc, choice) {
  if (isTyping) return;
  const signal = sceneFlowAbort ? sceneFlowAbort.signal : null;
  se("select");

  // 効果適用
  if (choice.effect) {
    for (const k in choice.effect) {
      if (k === "courage" || k === "observe" || k === "anxiety") {
        state[k] = Math.max(0, state[k] + choice.effect[k]);
      } else {
        flag[k] = choice.effect[k];
      }
    }
  }
  updateHUD();
  updateQuestLine();
  document.getElementById("choices").innerHTML = "";
  showStatToast(choice.effect);

  const important = IMPORTANT_KANJI_SCENES.has(sc.id);

  typeText(choice.after, () => {
    if (!signal || signal.aborted) return;
    armTimeout(signal, 600, () => {
      const nextId = choice.next || sc.next;
      const proceed = () => {
        if (nextId === "ENDING") {
          pendingEndingId = choice.endingId || sc.endingId || null;
          showEnding();
        } else {
          enterScene(nextId);
        }
      };
      const kanjiOpts = { importantChoiceFromScene: important, choiceSceneId: sc.id };
      if (!maybeStartKanjiEvent(proceed, kanjiOpts)) proceed();
    });
  });
}

function getJourneyProfile(stats) {
  const c = stats.courage || 0;
  const o = stats.observe || 0;
  const a = stats.anxiety || 0;
  const total = c + o + a;
  const max = Math.max(c, o, a);
  const min = Math.min(c, o, a);

  if (total <= 2) {
    return {
      title: "これからつよくなる子",
      note: "まだはじまったばかり。ここから、なんにでもなれる。"
    };
  }
  if (max - min <= 1) {
    return {
      title: "なんでもできる子",
      note: "ゆうきも、よく見る力も、こわい気持ちも、ぜんぶ使えている。"
    };
  }
  if (c === o && c > a) {
    return {
      title: "さきにすすむ名たんてい",
      note: "自分から動いて、手がかりもちゃんと見つけられる。"
    };
  }
  if (c === a && c > o) {
    return {
      title: "こわくても進める子",
      note: "ドキドキしても足を止めない。"
    };
  }
  if (o === a && o > c) {
    return {
      title: "きけんに気づける子",
      note: "へんな気配を、だれより先に見つけられる。"
    };
  }
  if (c > o && o > a) {
    return {
      title: "ゆうきいっぱいの子",
      note: "まず一歩ふみ出せる。まっすぐ前に進める。"
    };
  }
  if (c > a && a > o) {
    return {
      title: "ピンチにつよい子",
      note: "こまったときほど、ぐっと強くなれる。"
    };
  }
  if (o > c && c > a) {
    return {
      title: "よく見てすすめる子",
      note: "あせらず見て、いちばんいい道を選べる。"
    };
  }
  if (o > a && a > c) {
    return {
      title: "ヒントを見つけるのが上手な子",
      note: "小さなサインを見つけて、道につなげられる。"
    };
  }
  return {
    title: "ふしぎに気づける子",
    note: "みんなが気づかない、ふしぎなことに目が届く。"
  };
}

function getEndingCinematicStyle(ending) {
  const title = String(ending.title || "");
  const isTrue = title.startsWith("TRUE END");
  const isHappy = title.startsWith("ハッピーエンド");
  const isSepia = title.startsWith("セピアエンド");
  const isBad = title.startsWith("BAD END");
  const isMother = title.startsWith("母さんのページ");
  if (isMother) {
    return { kind: "true", stamp: "母さんのページ", seType: "good" };
  }
  if (isTrue) {
    return {
      kind: "true",
      stamp: "TRUE END",
      seType: "good"
    };
  }
  if (isHappy) {
    return {
      kind: "happy",
      stamp: "ハッピーエンド",
      seType: "good"
    };
  }
  if (isSepia) {
    return {
      kind: "neutral",
      stamp: "セピアエンド",
      seType: "select"
    };
  }
  if (isBad) {
    return {
      kind: "bad",
      stamp: "BAD END",
      seType: "alert"
    };
  }
  return {
    kind: "neutral",
    stamp: "ENDING",
    seType: "select"
  };
}

function ensureHappyGlowInLayer(layer) {
  if (!layer || layer.querySelector(".ending-happy-glow")) return;
  const glow = document.createElement("div");
  glow.className = "ending-happy-glow";
  glow.setAttribute("aria-hidden", "true");
  layer.insertBefore(glow, layer.firstChild);
}

function ensureEndingCinematicLayer() {
  let layer = document.getElementById("ending-cinematic");
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = "ending-cinematic";
  layer.innerHTML = `
    <div class="ending-vignette"></div>
    <div class="ending-bar top"></div>
    <div class="ending-bar bottom"></div>
    <div class="ending-stamp"></div>
  `;
  document.getElementById("screen").appendChild(layer);
  return layer;
}

function playEndingCinematic(style) {
  const screen = document.getElementById("screen");
  const layer = ensureEndingCinematicLayer();
  ensureHappyGlowInLayer(layer);
  const stamp = layer.querySelector(".ending-stamp");

  screen.classList.remove("ending-true", "ending-bad", "ending-neutral", "ending-happy");
  screen.classList.add(`ending-${style.kind}`);
  layer.classList.remove("show", "true", "bad", "neutral", "happy");
  layer.classList.add(style.kind);
  stamp.textContent = style.stamp;

  if (style.kind === "happy") {
    flash({ soft: true });
    se(style.seType);
  } else {
    flash();
    se(style.seType);
    setTimeout(() => flash(), 180);
  }

  setTimeout(() => {
    layer.classList.add("show");
  }, 40);
}

function showEnding() {
  abortSceneFlow();
  updateRouteClass(null);
  badEndRoofClownRevealStart = null;
  endingBgMood = null;

  setPhotoBackdrop(null);
  setBG("bg-end");
  document.getElementById("speaker").textContent = "";
  document.getElementById("choices").innerHTML = "";
  setPortrait(null);

  const resolvedId =
    pendingEndingId || (DATA.endings[0] && DATA.endings[0].id) || null;
  pendingEndingId = null;
  let ending =
    (resolvedId && DATA.endings.find((e) => e.id === resolvedId)) || DATA.endings[0];

  // ④ TRUE END ロック：いずれか1つ BAD END を見ていなければハッピーエンド扱い
  if (resolvedId === "end_deduction") {
    const BAD_IDS = new Set(["end_roof_clown", "end_wrong_mother", "end_food_heaven"]);
    const hasBad = getUnlockedEndings().some(id => BAD_IDS.has(id));
    if (!hasBad) {
      ending = {
        id: "end_deduction",
        title: "ハッピーエンド  ―  証跡のむこう",
        replay_tip: "この結末には、もう一つの顔がある。いくつかの道を経てから、もう一度ここへ来てみて。",
        text: ending.text
      };
    }
  }

  unlockEnding(ending.id);
  if (ending.id === "end_roof_clown") {
    badEndRoofClownRevealStart = performance.now();
  }
  const style = getEndingCinematicStyle(ending);
  endingBgMood = style.kind;

  const endingBgmPositive = style.kind === "true" || style.kind === "happy";
  setBgmTheme(endingBgmPositive ? "truth" : (style.kind === "bad" ? "despair" : "end"), null);
  playEndingCinematic(style);

  const questEl = document.getElementById("quest-line");
  if (style.kind === "happy" && questEl) {
    questEl.textContent = "もうすぐ母さんに会える——名前が呼ばれるのを待っている";
  } else {
    updateQuestLine();
  }

  showFloor(ending.title);

  // ② JOURNEY REPORT を本文から切り離し「記録を見る」ボタンへ移動
  const floorList = [...visitedFloors].sort((a, b) => a - b).map((n) => `${n}F`).join(" / ") || "なし";
  const profile = getJourneyProfile(state);
  const reportText = [
    "【JOURNEY REPORT】",
    `勇気:${state.courage}  観察:${state.observe}  不安:${state.anxiety}`,
    `あなたは、${profile.title}です。`,
    profile.note,
    `踏破フロア: ${floorList}`,
    `判定: ${style.stamp}`
  ].join("\n");
  const replayTipText = ending.replay_tip ? `\n\n【つぎのひとこと】\n${ending.replay_tip}` : "";

  setTimeout(() => {
    typeText(ending.text + replayTipText, () => {

      const showEndingButtons = () => {
        // エンディング画面の色・BGMを復元
        setPhotoBackdrop(null);
        setBG("bg-end");
        const warmBgm = style.kind === "true" || style.kind === "happy";
        setBgmTheme(warmBgm ? "truth" : (style.kind === "bad" ? "despair" : "end"), null);

        const box = document.getElementById("choices");
        box.innerHTML = "";

        // 「記録を見る」ボタン
        const btnReport = document.createElement("button");
        btnReport.className = "choice-button";
        btnReport.textContent = "記録を見る";
        btnReport.onclick = () => {
          btnReport.remove();
          typeText(reportText, () => {});
        };
        box.appendChild(btnReport);

        // 「タイトルへ戻る」ボタン
        const btnTitle = document.createElement("button");
        btnTitle.className = "choice-button";
        btnTitle.textContent = "タイトルへ戻る";
        btnTitle.onclick = () => location.reload();
        box.appendChild(btnTitle);
      };

      // ① 漢字おじさん：グッドエンド後のみ、母さんのページは除く
      if (style.kind === "true" && ending.id !== "end_mother_pov") {
        showKanjiOjisan(showEndingButtons);
      } else {
        showEndingButtons();
      }
    });
  }, 1500);
}

/* ===== 漢字おじさん ===== */
function maybeStartKanjiEvent(onClear, opts = {}) {
  const sceneId = opts.choiceSceneId || currentSceneId;
  const sc = sceneMap[sceneId];
  if (!sc || !sc.next || sc.next === "ENDING") return false;
  const kanjiBlockedScenes = new Set(["a6", "b6", "c6", "d6", "e6", "f6"]);
  if (kanjiBlockedScenes.has(sceneId)) return false;
  if (!opts.importantChoiceFromScene) return false;
  showKanjiOjisan(onClear);
  return true;
}

function showKanjiOjisan(onClear) {
  void (async () => {
    await animateFlashLayers({});
    se("alert");
    await animateScreenAlertShake();
  })();

  setPhotoBackdrop(null);
  setBG("bg-kanji");
  setBgmTheme("kanji", null);
  showFloor("!?  サブクエスト  ?!");
  setPortrait("kanji");
  document.getElementById("speaker").textContent = "漢字おじさん";

  const q = DATA.kanji_questions[Math.floor(Math.random() * DATA.kanji_questions.length)];

  const intro =
`カツ、カツ、カツ。

うしろから、革ぐつの音が近づいてきた。
ふりむくと、古い背広のおじさん。
手には、ぶ厚い漢字ドリル。

「おや、きみ。
　ここを通るなら、漢字を読んでいきなさい」
`;

  const tutorial =
`【おしらせ】

大事な選択のあとにだけ、
漢字クイズが始まることがあります。

（この説明は初回だけです）`;

  document.getElementById("choices").innerHTML = "";

  const runKanjiBody = () => {
    setTimeout(() => {
      playKanjiApproach(() => {
        typeText(intro, () => showKanjiQuestion(q, onClear));
      });
    }, 280);
  };

  try {
    if (!localStorage.getItem(KANJI_TUTORIAL_KEY)) {
      typeText(tutorial, () => {
        try { localStorage.setItem(KANJI_TUTORIAL_KEY, "1"); } catch (_) {}
        runKanjiBody();
      });
    } else {
      runKanjiBody();
    }
  } catch (_) {
    runKanjiBody();
  }
}

function showKanjiQuestion(q, onClear) {
  const box = document.getElementById("choices");
  box.innerHTML = "";

  // 問題を選択肢の上にも表示して、テキスト窓で見切れても必ず読めるようにする
  const qEl = document.createElement("div");
  qEl.className = "kanji-question";
  qEl.textContent = `【問題】 ${q.q}`;
  box.appendChild(qEl);

  const shuffled = shuffle([...q.choices]);
  shuffled.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "choice-button";
    btn.textContent = `${i+1}. ${c}`;
    btn.onmouseenter = () => se("move");
    btn.onclick = () => {
      if (isTyping) return;
      se("select");
      if (c === q.answer) clearKanji(onClear);
      else kanjiGameOver(q.answer);
    };
    box.appendChild(btn);
  });
}

function clearKanji(onClear) {
  state.courage += 1; state.observe += 1;
  state.anxiety = Math.max(0, state.anxiety - 1);
  updateHUD();
  se("good");
  document.getElementById("choices").innerHTML = "";

  typeText(
`「……正解だ」

漢字おじさんは、
ちょっとだけ口の端を上げた。

「読める迷子は、道にも強い。
　忘れるなよ」

おじさんは、文具売り場の方へ、
すうっと消えていった。`,
    () => {
      setTimeout(() => {
        setPortrait(null);
        setBgmTheme(resolveBgmTheme(currentSceneId), currentSceneId);
        setPhotoBackdropFromScene(currentSceneId);
        onClear();
      }, 800);
    }
  );
}

function kanjiGameOver(answer) {
  cancelSpeech();
  setPhotoBackdrop(null);
  se("bad");
  setBgmTheme("kanji", null);
  document.getElementById("choices").innerHTML = "";
  document.getElementById("speaker").textContent = "GAME OVER";

  typeText(
`「ちがう」

漢字おじさんの声が、
天井のすみまで響いた。

正解は、「${answer}」。

漢字ドリルが、ぱたん、と閉じた。
売り場の明かりが、ひとつずつ消えた。

― GAME OVER ―
漢字おじさんに、つかまった。`,
    () => {
      const box = document.getElementById("choices");
      const r = document.createElement("button");
      r.className = "choice-button";
      r.textContent = "もう一度、デパートへ行く";
      r.onclick = () => startGame();
      box.appendChild(r);

      const t = document.createElement("button");
      t.className = "choice-button";
      t.textContent = "タイトルへ戻る";
      t.onclick = () => location.reload();
      box.appendChild(t);
    }
  );
}

function shuffle(a) {
  for (let i=a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

/* キーボード操作 */
(function initSpeechUiAndMotionToggle() {
  const ver = document.getElementById("title-version");
  if (ver) ver.textContent = `ver.${GAME_VERSION}`;
  const chk = document.getElementById("chk-reduced-motion");
  if (chk) {
    try { chk.checked = localStorage.getItem(REDUCED_MOTION_USER_KEY) === "1"; } catch (_) {}
    chk.addEventListener("change", () => {
      try { localStorage.setItem(REDUCED_MOTION_USER_KEY, chk.checked ? "1" : "0"); } catch (_) {}
    });
  }
  const btn = document.getElementById("btn-tts");
  if (btn) {
    btn.addEventListener("click", () => {
      void ensureAudioReady();
      speakCurrentTypingPage();
    });
  }
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener("voiceschanged", refreshTtsUi);
    refreshTtsUi();
  }
  refreshMediaSession(null);
})();

window.addEventListener("keydown", (e) => {
  const mapOpen = document.getElementById("branchMapModal").style.display === "flex";
  if (mapOpen) {
    if (e.code === "Escape" || e.code === "KeyX") closeBranchMap();
    e.preventDefault();
    return;
  }
  if (isTitleVisible()) {
    if (["ArrowUp", "KeyW"].includes(e.code)) {
      e.preventDefault();
      moveTitleFocus(-1);
      return;
    }
    if (["ArrowDown", "KeyS"].includes(e.code)) {
      e.preventDefault();
      moveTitleFocus(1);
      return;
    }
    if (["Enter", "Space", "KeyZ"].includes(e.code)) {
      e.preventDefault();
      ensureAudioReady();
      if (titleButtons[titleMenuIndex]) {
        titleButtons[titleMenuIndex].click();
      }
      return;
    }
  }
  if (["1", "2", "3"].includes(e.key)) {
    const btns = document.querySelectorAll("#choices .choice-button");
    const idx = parseInt(e.key, 10) - 1;
    if (btns[idx]) btns[idx].click();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ensureAudioReady();
});
