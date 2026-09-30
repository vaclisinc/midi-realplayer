const $ = (id) => document.getElementById(id);
const status = (message) => { $("status").textContent = message; };
const total = 100;
const visited = new Set();
let players = [];
let selected = -1;
let generation = 0;
let playRequest = 0;
let pending = false;
let loading = false;
let readyCount = 0;
let created = 0;
const contextStates = new Map();

// Installed before the player module loads. Store only IDs/states so diagnostics
// do not keep closed contexts or their audio graphs alive.
const NativeAudioContext = window.AudioContext;
if (NativeAudioContext) {
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      const id = ++created;
      const update = () => {
        if (this.state === "closed") contextStates.delete(id);
        else contextStates.set(id, this.state);
        $("contexts").textContent = String(contextStates.size);
        $("created").textContent = String(created);
      };
      this.addEventListener("statechange", update);
      update();
    }
  };
}

function controls() {
  $("next").disabled = $("previous").disabled = pending || loading || !players.length;
  $("pause").disabled = $("remove").disabled = !players.length;
  $("rebuild").disabled = Boolean(players.length) || loading;
}

function pauseAll() {
  playRequest++;
  pending = false;
  for (const player of players) player.pause();
  controls();
}

async function mountAll() {
  const run = ++generation;
  loading = true;
  readyCount = 0;
  selected = -1;
  visited.clear();
  $("visited").textContent = "0";
  $("latency").textContent = "—";
  $("ready").textContent = "0 / 100";
  const samples = ["piano.mid", "bass.mid", "muscriptor.mid"];
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const article = document.createElement("article");
    const heading = document.createElement("h2");
    const number = document.createElement("span");
    number.textContent = String(i + 1).padStart(3, "0");
    heading.append(number, ` ${samples[i % samples.length]}`);
    const element = document.createElement("midi-realplayer");
    element.setAttribute("src", samples[i % samples.length]);
    element.setAttribute("no-export", "");
    element.addEventListener("play", () => {
      selected = i;
      visited.add(i);
      $("visited").textContent = String(visited.size);
    });
    article.append(heading, element);
    fragment.append(article);
    players.push(element);
  }
  $("players").append(fragment);
  controls();
  status("正在掛載全部 100 個 player…");
  await Promise.all(players.map(async (element) => {
    await element.player.ready;
    if (run !== generation) return;
    if (element.player.trackCount > 0) readyCount++;
    $("ready").textContent = `${readyCount} / ${total}`;
  }));
  if (run !== generation) return;
  loading = false;
  controls();
  status(readyCount === total ? "100 個已就緒。點「播放下一個」開始，或直接操作下方 player。" : `只有 ${readyCount} 個成功讀取 MIDI，請檢查網路後重建。`);
}

async function playAt(index) {
  if (pending || loading || !players.length) return;
  const player = players[index];
  const request = ++playRequest;
  pending = true;
  controls();
  status(`正在準備第 ${index + 1} 個…若一直無聲，請直接點該 player 的播放鍵。`);
  const start = performance.now();
  try {
    await player.play();
    if (request !== playRequest) return;
    $("latency").textContent = `${Math.round(performance.now() - start)} ms`;
    status(player.playing ? `正在播放第 ${index + 1} / ${total} 個。可繼續切換，或往下滑動。` : `第 ${index + 1} 個未開始播放，請查看 player 的錯誤訊息。`);
  } catch (error) {
    if (request === playRequest) status(`播放失敗：${error.message}`);
  } finally {
    if (request === playRequest) { pending = false; controls(); }
  }
}

$("next").addEventListener("click", () => void playAt((selected + 1) % players.length));
$("previous").addEventListener("click", () => void playAt(selected <= 0 ? players.length - 1 : selected - 1));
$("pause").addEventListener("click", () => { pauseAll(); status("已全部暫停。引擎完成載入／回收後，AudioContext 應最多剩 3 個。"); });
$("remove").addEventListener("click", () => {
  pauseAll();
  generation++;
  $("players").replaceChildren();
  players = [];
  loading = false;
  $("ready").textContent = "0 / 0";
  controls();
  status("已移除全部 player。等待 AudioContext 關閉後，數量應降到 0。");
});
$("rebuild").addEventListener("click", () => { void mountAll().catch(fail); });
function fail(error) { loading = false; controls(); status(`測試頁載入失敗：${error.message}`); }

// Nonstandard and unavailable on many phones; never present this as total RAM.
if (performance.memory) {
  const updateHeap = () => {
    $("heap").hidden = false;
    $("heap").textContent = `JS heap 約 ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB（非總記憶體）`;
  };
  updateHeap();
  setInterval(updateHeap, 2000);
}

try {
  if (!isSecureContext || !NativeAudioContext) {
    throw new Error("請使用 HTTPS 網址（電腦可用 localhost），此環境無法測試 AudioWorklet 播放。");
  }
  await import("../dist/midi-realplayer.js");
  await mountAll();
} catch (error) { fail(error); }
