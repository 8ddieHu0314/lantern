// Lantern UI: record a visit, show who said what, show the drafted note.
// No libraries and no network calls beyond this laptop.

const $ = (id) => document.getElementById(id);

// The sections of the note whose sentences each link back to the recording.
const SECTIONS = ["subjective", "objective", "assessment", "plan"];

const state = {
  turns: [],
  roles: {},
  recorder: null,
  audioUrl: null,
  // The visit on screen: { id, created, audio, audioSaved }. Null until a recording is processed.
  visit: null,
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

// ---------- playback ----------

// The recording stays in the browser so any line of the note can be played back.
const player = new Audio();
let playTimer = null;

function playRange(start, end) {
  if (!state.audioUrl) return;
  clearTimeout(playTimer);
  const from = Math.max(0, start - 0.1);
  player.currentTime = from;
  player.play().catch(() => {});
  playTimer = setTimeout(() => player.pause(), (end + 0.25 - from) * 1000);
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
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(wav);
    player.src = state.audioUrl;
    state.visit = { id: newVisitId(new Date()), created: new Date().toISOString(), audio: wav, audioSaved: false };
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
    renderNote({ ...result, created: state.visit?.created });
    progress(`Note drafted in ${result.seconds}s. Check the medications and allergies, then print.`);
    await saveVisit();
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
    const num = el("button", "num", String(turn.id));
    num.type = "button";
    num.setAttribute("aria-label", `Play line ${turn.id}`);
    num.addEventListener("click", () => playRange(turn.start, turn.end));

    const text = el("span", "text");
    const parts = turn.parts?.length ? turn.parts : [{ start: turn.start, end: turn.end, text: turn.text }];
    parts.forEach((part, index) => {
      const phrase = el("span", "part", part.text);
      phrase.dataset.start = part.start;
      text.append(phrase, index < parts.length - 1 ? " " : "");
    });

    item.append(num, el("span", "role", role), text);
    list.append(item);
  }
  $("transcript-empty").hidden = true;
  $("transcript-wrap").hidden = false;
}

// One sentence per row: the editable text, then where in the recording it came from.
function fillList(id, items, sources = []) {
  const list = $(id);
  list.replaceChildren(...items.map((item, index) => {
    const row = el("li");
    const say = el("span", "say", item);
    say.contentEditable = "true";
    say.spellcheck = false;
    // Clearing a sentence removes it, which is how a line with no source gets dismissed.
    say.addEventListener("blur", () => {
      if (!say.textContent.trim()) { row.remove(); updateBanner(); }
    });
    row.source = sources[index];
    row.append(say, " ", sourceChip(sources[index]));
    return row;
  }));
}

function sourceChip(source) {
  if (!source) return "";
  if (!source.line) return el("span", "check unheard", "Not found in recording");
  const chip = el("button", "src", `line ${source.line}`);
  chip.type = "button";
  chip.title = `Heard: "${source.quote}"`;
  chip.setAttribute("aria-label", `Play where this was said, line ${source.line}`);
  chip.addEventListener("click", () => showSource(source));
  return chip;
}

// Scrolls to the line, lights up the exact phrase and plays it.
function showSource(source) {
  goToLine(source.line);
  document.querySelectorAll(".part.lit").forEach((part) => part.classList.remove("lit"));
  const turn = $(`turn-${source.line}`);
  for (const part of turn ? turn.querySelectorAll(".part") : []) {
    const start = Number(part.dataset.start);
    if (start >= source.start - 0.01 && start < source.end) part.classList.add("lit");
  }
  playRange(source.start, source.end);
}

function goToLine(line) {
  const turn = $(`turn-${line}`);
  if (!turn) return;
  turn.scrollIntoView({ behavior: "smooth", block: "center" });
  turn.classList.add("flash");
  setTimeout(() => turn.classList.remove("flash"), 1800);
}

// Counts the medications and allergies nobody has ticked as verified yet.
function updateBanner() {
  const kinds = [
    { table: "meds", one: "medication", many: "medications" },
    { table: "allergies", one: "allergy", many: "allergies" },
  ].map((kind) => {
    const boxes = [...document.querySelectorAll(`#${kind.table} tbody input`)];
    return { ...kind, total: boxes.length, left: boxes.filter((box) => !box.checked).length };
  }).filter((kind) => kind.total);

  const waiting = kinds.filter((kind) => kind.left);
  // A "not found" mark stops counting once its row is ticked as verified.
  const unheard = [...document.querySelectorAll("#note .check.unheard")]
    .filter((mark) => !mark.closest("tr")?.querySelector("input").checked).length;

  const banner = $("med-banner");
  banner.hidden = kinds.length === 0 && unheard === 0;
  banner.className = unheard ? "banner alert" : waiting.length ? "banner" : "banner clear";
  const lines = [];
  if (waiting.length) {
    const counts = waiting.map((kind) => `${kind.left} ${kind.left === 1 ? kind.one : kind.many}`);
    lines.push(`${counts.join(" and ")} to verify before this note is used.`);
  } else if (kinds.length) lines.push(`All ${kinds.map((kind) => kind.many).join(" and ")} verified.`);
  if (unheard) lines.push("Some details were not found in the recording.");
  banner.textContent = lines.join(" ");
}

function checkPill(heard, label) {
  return el("span", `check ${heard ? "heard" : "unheard"}`, heard ? `${label} heard` : `${label} not heard`);
}

function lineLink(line) {
  const link = el("button", "line-link", `line ${line}`);
  link.type = "button";
  link.addEventListener("click", () => goToLine(line));
  return link;
}

// The "Verified" checkbox cell that ends every medication and allergy row.
function verifyCell(name, verified) {
  const cell = el("td");
  const box = el("input");
  box.type = "checkbox";
  box.checked = Boolean(verified);
  box.setAttribute("aria-label", `Verified ${name}`);
  box.addEventListener("change", updateBanner);
  cell.append(box);
  return cell;
}

// Draws a note: a fresh one from /api/note, or a saved one with its edits and ticks.
function renderNote({ note, medications, allergies, sources = {}, created }) {
  $("n-cc").textContent = note.chief_complaint || "Visit note";
  $("n-date").textContent = new Date(created || Date.now()).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  for (const section of SECTIONS) fillList(`n-${section}`, note[section] || [], sources[section]);
  $("n-handoff").textContent = note.handoff;

  const allergyRows = document.querySelector("#allergies tbody");
  allergyRows.replaceChildren();
  for (const allergy of allergies) {
    const row = el("tr");
    const name = el("td", "", allergy.name);
    name.contentEditable = "true";
    name.spellcheck = false;
    const checks = el("td");
    checks.append(checkPill(allergy.heard, "Allergy"));
    if (allergy.line) checks.append(lineLink(allergy.line));
    row.item = allergy;
    row.append(name, checks, verifyCell(allergy.name, allergy.verified));
    allergyRows.append(row);
  }
  $("allergies").hidden = allergies.length === 0;
  $("allergies-none").hidden = allergies.length !== 0;

  const body = document.querySelector("#meds tbody");
  body.replaceChildren();
  for (const med of medications) {
    const row = el("tr");
    row.append(el("td", "", med.name));
    row.append(el("td", "", med.dose || "none said"));

    const checks = el("td");
    checks.append(checkPill(med.name_heard, "Drug"));
    if (!med.dose) checks.append(el("span", "check nodose", "No dose said"));
    else checks.append(checkPill(med.dose_heard, "Dose"));
    if (med.line) checks.append(lineLink(med.line));
    row.item = med;
    row.append(checks, verifyCell(med.name, med.verified));
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
  const items = (id) => [...$(id).querySelectorAll("li")]
    .map((li) => `- ${li.querySelector(".say").textContent}${li.querySelector(".unheard") ? " (NOT found in recording)" : ""}`)
    .join("\n") || "- Nothing was said.";
  const verified = (row) => (row.querySelector("input").checked ? " (verified)" : " (NOT verified)");
  const meds = [...document.querySelectorAll("#meds tbody tr")].map((row) => {
    const [name, dose] = [...row.children].map((cell) => cell.textContent);
    return `- ${name}, ${dose}${verified(row)}`;
  }).join("\n") || "- None mentioned.";
  const allergies = [...document.querySelectorAll("#allergies tbody tr")]
    .map((row) => `- ${row.children[0].textContent}${verified(row)}`)
    .join("\n") || "- None mentioned.";
  return [
    `DOWNTIME CLINICAL NOTE (draft) · ${$("n-date").textContent}`,
    $("n-cc").textContent, "",
    "SUBJECTIVE", items("n-subjective"), "",
    "OBJECTIVE", items("n-objective"), "",
    "ASSESSMENT", items("n-assessment"), "",
    "PLAN", items("n-plan"), "",
    "ALLERGIES", allergies, "",
    "MEDICATIONS", meds, "",
    "HANDOFF", $("n-handoff").textContent,
  ].join("\n");
}

// ---------- saved visits ----------

// A visit's id is the local time it started, like 20261115-015200.
function newVisitId(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// The note as it stands on screen, edits and ticks included, in the shape renderNote reads.
function snapshot() {
  const note = { chief_complaint: $("n-cc").textContent, handoff: $("n-handoff").textContent };
  const sources = {};
  for (const section of SECTIONS) {
    const rows = [...$(`n-${section}`).querySelectorAll("li")];
    note[section] = rows.map((row) => row.querySelector(".say").textContent);
    sources[section] = rows.map((row) => row.source);
  }
  const rows = (table) => [...document.querySelectorAll(`#${table} tbody tr`)];
  const verified = (row) => row.querySelector("input").checked;
  return {
    note,
    sources,
    medications: rows("meds").map((row) => ({ ...row.item, verified: verified(row) })),
    allergies: rows("allergies").map((row) => ({ ...row.item, name: row.children[0].textContent, verified: verified(row) })),
  };
}

// Writes the visit on screen to this laptop's disk. The recording is sent once, the note every time.
async function saveVisit() {
  const visit = state.visit;
  if (!visit || $("note").hidden) return;
  try {
    if (!visit.audioSaved && visit.audio) {
      await api(`/api/visits/${visit.id}/audio`, { method: "PUT", headers: { "Content-Type": "audio/wav" }, body: visit.audio });
      visit.audioSaved = true;
    }
    await api(`/api/visits/${visit.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ created: visit.created, turns: state.turns, roles: state.roles, ...snapshot(), text: noteAsText() }),
    });
    refreshVisits();
  } catch (error) {
    progress(`This visit could not be saved: ${error.message}`, true);
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveVisit, 400);
}

const timeOf = (visit) => (visit.created ? new Date(visit.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

async function refreshVisits() {
  let visits;
  try { visits = (await api("/api/visits")).visits; } catch { return; }
  $("visits-open").textContent = visits.length ? `Saved visits (${visits.length})` : "Saved visits";
  $("visits-none").hidden = visits.length !== 0;
  $("visits-export").hidden = visits.length === 0;
  $("visits-list").replaceChildren(...visits.map((visit) => {
    const open = el("button", "visit-open");
    open.type = "button";
    open.append(
      el("span", "visit-time", timeOf(visit)),
      el("span", "visit-title", visit.title),
      el("span", `check ${visit.to_verify ? "nodose" : "heard"}`, visit.to_verify ? `${visit.to_verify} to verify` : "Verified"),
      el("span", "visit-handoff", visit.handoff),
    );
    open.addEventListener("click", () => openVisit(visit));

    const remove = el("button", "btn small", "Delete");
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete the visit from ${timeOf(visit)}: ${visit.title}`);
    remove.addEventListener("click", () => deleteVisit(visit));

    const row = el("li", "visit-row");
    row.append(open, remove);
    return row;
  }));
}

async function openVisit(visit) {
  if (state.busy || state.recorder) return;
  try {
    const record = await api(`/api/visits/${visit.id}`);
    const audio = await fetch(`/api/visits/${visit.id}/audio`);
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = audio.ok ? URL.createObjectURL(await audio.blob()) : null;
    if (state.audioUrl) player.src = state.audioUrl;
    state.turns = record.turns || [];
    state.roles = record.roles || {};
    state.visit = { id: visit.id, created: record.created, audio: null, audioSaved: true };
    renderTranscript();
    renderNote(record);
    $("visits").close();
    progress(`Opened the saved visit from ${timeOf(visit)}.`);
  } catch (error) {
    progress(`That visit could not be opened: ${error.message}`, true);
  }
}

async function deleteVisit(visit) {
  const question = `Delete "${visit.title}" from ${timeOf(visit)}? The note and its recording are removed from this laptop and cannot be recovered.`;
  if (!confirm(question)) return;
  try {
    await api(`/api/visits/${visit.id}`, { method: "DELETE" });
    // If it is the visit on screen, forget it, so the next autosave does not bring it back.
    if (state.visit?.id === visit.id) state.visit = null;
    refreshVisits();
  } catch (error) {
    progress(`That visit could not be deleted: ${error.message}`, true);
  }
}

// ---------- wiring ----------

// Save again whenever a tick changes or an edited field loses focus.
$("note").addEventListener("change", scheduleSave);
$("note").addEventListener("focusout", scheduleSave);
$("visits-open").addEventListener("click", () => { refreshVisits(); $("visits").showModal(); });
$("visits-close").addEventListener("click", () => $("visits").close());

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
refreshVisits();
setInterval(checkHealth, 5000);
fetch("sample-visit.wav", { method: "HEAD" }).then((r) => { $("sample").hidden = !r.ok; }).catch(() => {});
