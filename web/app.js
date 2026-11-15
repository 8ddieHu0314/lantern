// Lantern UI: record a visit, show who said what, show the drafted note.
// No libraries and no network calls beyond this laptop.

const $ = (id) => document.getElementById(id);

const state = {
  turns: [],
  roles: {},
  recorder: null,
  tick: null,
  busy: false,
};

// ---------- status ----------

function setPill(el, label, kind) {
  el.textContent = label;
  el.className = `pill ${kind}`;
}

function showNetwork() {
  if (navigator.onLine) setPill($("st-network"), "Network: online", "");
  else setPill($("st-network"), "Network: OFF · running locally", "offline");
}

async function checkHealth() {
  try {
    const health = await (await fetch("/api/health")).json();
    setPill($("st-speech"), health.speech ? "Speech: ready" : "Speech: not running", health.speech ? "ok" : "down");
    setPill($("st-llm"), health.llm ? "Bonsai: ready" : "Bonsai: not running", health.llm ? "ok" : "down");
  } catch {
    setPill($("st-speech"), "Speech: unknown", "down");
    setPill($("st-llm"), "Bonsai: unknown", "down");
  }
}

function progress(message, isError = false) {
  const el = $("progress");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

// Shows "message (12s)" and keeps the seconds ticking until the returned function is called.
function progressTimer(message) {
  const started = Date.now();
  const show = () => progress(`${message} (${Math.round((Date.now() - started) / 1000)}s)`);
  show();
  const id = setInterval(show, 1000);
  return () => clearInterval(id);
}

function setBusy(busy) {
  state.busy = busy;
  $("record").disabled = busy;
  $("sample").disabled = busy;
  $("file").disabled = busy;
  $("swap").disabled = busy;
}

// ---------- audio ----------

// Any audio the browser can decode -> 16 kHz mono 16-bit WAV, which the speech service reads.
async function toWav(arrayBuffer) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();

  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    progress("Lantern can't use the microphone. Allow microphone access for this page, then try again.", true);
    return;
  }
  // The stop handler runs after stopRecording has cleared state.recorder,
  // so it keeps its own references to the recorder, its audio and the stream.
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  recorder.onstop = async () => {
    stopMeter();
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    if (!blob.size) {
      progress("Nothing was recorded. Check the microphone and try again.", true);
      return;
    }
    await processAudio(await blob.arrayBuffer());
  };
  state.recorder = recorder;
  recorder.start();
  startMeter(stream);

  const started = Date.now();
  $("timer").classList.add("live");
  state.tick = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
  $("record").textContent = "Stop and write note";
  $("record").classList.add("recording");
  progress("Recording. Talk as usual.");
}

function stopRecording() {
  clearInterval(state.tick);
  $("timer").classList.remove("live");
  $("record").textContent = "Start recording";
  $("record").classList.remove("recording");
  state.recorder.stop();
  state.recorder = null;
}

let meter = null;
function startMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    $("level").style.width = `${Math.min(100, (peak / 128) * 160)}%`;
    meter.frame = requestAnimationFrame(draw);
  };
  meter = { ctx, frame: requestAnimationFrame(draw) };
}
function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.frame);
  meter.ctx.close();
  meter = null;
  $("level").style.width = "0";
}

// ---------- pipeline ----------

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = (await response.json()).detail || detail; } catch { /* keep the status */ }
    throw new Error(detail);
  }
  return response.json();
}

async function processAudio(arrayBuffer) {
  setBusy(true);
  let stop = progressTimer("Preparing the audio");
  try {
    const wav = await toWav(arrayBuffer);
    stop();
    stop = progressTimer("Writing down who said what");
    const result = await api("/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    stop();
    state.turns = result.turns;
    state.roles = result.roles;
    renderTranscript();
    await writeNote();
  } catch (error) {
    stop();
    progress(`That didn't work: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function writeNote() {
  const stop = progressTimer("Bonsai is drafting the note");
  try {
    const result = await api("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns: state.turns, roles: state.roles }),
    });
    stop();
    renderNote(result);
    progress(`Note drafted in ${result.seconds}s. Check the medications, then print.`);
  } catch (error) {
    stop();
    progress(`The note couldn't be drafted: ${error.message}`, true);
  }
}

// ---------- rendering ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderTranscript() {
  const list = $("transcript");
  list.replaceChildren();
  for (const turn of state.turns) {
    const role = state.roles[turn.speaker] || "other";
    const item = el("li", `turn ${role}`);
    item.id = `turn-${turn.id}`;
    item.title = clock(turn.start);
    item.append(el("span", "num", String(turn.id)), el("span", "role", role), el("span", "text", turn.text));
    list.append(item);
  }
  $("transcript-empty").hidden = true;
  $("transcript-wrap").hidden = false;
}

function fillList(id, items) {
  const list = $(id);
  list.replaceChildren(...items.map((item) => el("li", "", item)));
}

function goToLine(line) {
  const turn = $(`turn-${line}`);
  if (!turn) return;
  turn.scrollIntoView({ behavior: "smooth", block: "center" });
  turn.classList.add("flash");
  setTimeout(() => turn.classList.remove("flash"), 1800);
}

function updateBanner() {
  const boxes = [...document.querySelectorAll("#meds tbody input")];
  const banner = $("med-banner");
  banner.hidden = boxes.length === 0;
  const left = boxes.filter((box) => !box.checked).length;
  const unheard = document.querySelectorAll("#meds .check.unheard").length;
  banner.className = left === 0 ? "banner clear" : unheard ? "banner alert" : "banner";
  if (left === 0) banner.textContent = "All medications verified.";
  else {
    banner.textContent = `${left} medication${left === 1 ? "" : "s"} to verify before this note is used.`;
    if (unheard) banner.textContent += " Some details were not found in the recording.";
  }
}

function renderNote({ note, medications }) {
  $("n-cc").textContent = note.chief_complaint || "Visit note";
  $("n-date").textContent = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  fillList("n-subjective", note.subjective);
  fillList("n-objective", note.objective);
  fillList("n-assessment", note.assessment);
  fillList("n-plan", note.plan);
  fillList("n-allergies", note.allergies);
  $("n-handoff").textContent = note.handoff;

  const body = document.querySelector("#meds tbody");
  body.replaceChildren();
  for (const med of medications) {
    const row = el("tr");
    row.append(el("td", "", med.name));
    row.append(el("td", "", med.dose || "none said"));

    const checks = el("td");
    checks.append(el("span", `check ${med.name_heard ? "heard" : "unheard"}`, med.name_heard ? "Drug heard" : "Drug not heard"));
    if (!med.dose) checks.append(el("span", "check nodose", "No dose said"));
    else checks.append(el("span", `check ${med.dose_heard ? "heard" : "unheard"}`, med.dose_heard ? "Dose heard" : "Dose not heard"));
    if (med.line) {
      const link = el("button", "line-link", `line ${med.line}`);
      link.type = "button";
      link.addEventListener("click", () => goToLine(med.line));
      checks.append(link);
    }
    row.append(checks);

    const verify = el("td");
    const box = el("input");
    box.type = "checkbox";
    box.setAttribute("aria-label", `Verified ${med.name}`);
    box.addEventListener("change", updateBanner);
    verify.append(box);
    row.append(verify);
    body.append(row);
  }
  document.querySelector("#meds").hidden = medications.length === 0;
  $("meds-none").hidden = medications.length !== 0;
  updateBanner();

  $("note-empty").hidden = true;
  $("note").hidden = false;
  $("print").disabled = false;
  $("copy").disabled = false;
}

function noteAsText() {
  const items = (id) => [...$(id).querySelectorAll("li")].map((li) => `- ${li.textContent}`).join("\n") || "- Nothing was said.";
  const meds = [...document.querySelectorAll("#meds tbody tr")].map((row) => {
    const [name, dose] = [...row.children].map((cell) => cell.textContent);
    return `- ${name}, ${dose}${row.querySelector("input").checked ? " (verified)" : " (NOT verified)"}`;
  }).join("\n") || "- None mentioned.";
  return [
    `DOWNTIME CLINICAL NOTE (draft) · ${$("n-date").textContent}`,
    $("n-cc").textContent, "",
    "SUBJECTIVE", items("n-subjective"), "",
    "OBJECTIVE", items("n-objective"), "",
    "ASSESSMENT", items("n-assessment"), "",
    "PLAN", items("n-plan"), "",
    "ALLERGIES", items("n-allergies"), "",
    "MEDICATIONS", meds, "",
    "HANDOFF", $("n-handoff").textContent,
  ].join("\n");
}

// ---------- wiring ----------

$("record").addEventListener("click", () => (state.recorder ? stopRecording() : startRecording()));

$("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) await processAudio(await file.arrayBuffer());
});

$("sample").addEventListener("click", async () => {
  const response = await fetch("sample-visit.wav");
  await processAudio(await response.arrayBuffer());
});

$("swap").addEventListener("click", async () => {
  for (const speaker of Object.keys(state.roles)) {
    if (state.roles[speaker] === "clinician") state.roles[speaker] = "patient";
    else if (state.roles[speaker] === "patient") state.roles[speaker] = "clinician";
  }
  renderTranscript();
  setBusy(true);
  await writeNote();
  setBusy(false);
});

$("print").addEventListener("click", () => window.print());

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(noteAsText());
    progress("Note copied as text.");
  } catch {
    progress("Copying was blocked by the browser. Select the note and copy it by hand.", true);
  }
});

window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
showNetwork();
checkHealth();
setInterval(checkHealth, 5000);
fetch("sample-visit.wav", { method: "HEAD" }).then((r) => { $("sample").hidden = !r.ok; }).catch(() => {});
