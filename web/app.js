// Lantern UI: record a visit, show who said what, show the drafted note, keep every note of the outage.
// No libraries and no network calls beyond this laptop.

const $ = (id) => document.getElementById(id);

const SECTIONS = ["subjective", "objective", "assessment", "plan"];
const WAIT_HINT = "The note opens here when it is ready.";

const state = {
  turns: [],
  roles: {},
  recorder: null,
  audioUrl: null,
  tick: null,
  busy: false,
  view: "empty",
  visit: null, // the visit on screen: { id, created, note, sources, medications, allergies }
  visits: [], // what the saved visits list shows
};

// ---------- views and messages ----------

// The main area shows one thing at a time: nothing yet, recording or waiting, or a note.
function setView(view) {
  state.view = view;
  for (const name of ["empty", "work", "note"]) $(`view-${name}`).hidden = name !== view;
}

// The recording screen, also used while the note is being written.
function setWork(title, { live = false, hint = "" } = {}) {
  setView("work");
  $("view-work").classList.toggle("live", live);
  $("work-title").textContent = title;
  $("work-status").textContent = "";
  $("work-hint").textContent = hint;
  notice("");
}

function notice(message, isError = false) {
  const el = $("progress");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

// While recording or waiting, progress is the large line in the middle of the screen.
// Errors, and anything said while a note is open, go in the bar at the top.
function progress(message, isError = false) {
  if (state.view === "work" && !isError) $("work-status").textContent = message;
  else notice(message, isError);
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

// Says nothing while everything works. A clinician only needs to hear about it when it doesn't.
async function checkHealth() {
  let trouble = "";
  try {
    const health = await (await fetch("/api/health")).json();
    if (!health.speech) trouble = "Lantern can't transcribe recordings right now.";
    else if (!health.llm) trouble = "Lantern can't draft notes right now.";
  } catch {
    trouble = "Lantern isn't responding.";
  }
  $("trouble").textContent = trouble ? `${trouble} Restart it with scripts/run_all.sh.` : "";
}

// The one status always on screen: that nothing here needs the network.
function showNetwork() {
  const offline = !navigator.onLine;
  $("st-network").textContent = offline ? "Network: OFF · running locally" : "Runs on this laptop. Nothing is sent anywhere.";
  $("st-network").classList.toggle("offline", offline);
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
  await flushSave();
  const started = new Date();
  // The stop handler runs after stopRecording has cleared state.recorder,
  // so it keeps its own references to the recorder, its audio and the stream.
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  recorder.onstop = async () => {
    stopMeter();
    stream.getTracks().forEach((track) => track.stop());
    renderVisits();
    const blob = new Blob(chunks, { type: recorder.mimeType });
    if (!blob.size) {
      setView(state.visit ? "note" : "empty");
      progress("Nothing was recorded. Check the microphone and try again.", true);
      return;
    }
    await processAudio(await blob.arrayBuffer(), started);
  };
  state.recorder = recorder;
  recorder.start();
  startMeter(stream);

  $("timer").textContent = "0:00";
  state.tick = setInterval(() => {
    $("timer").textContent = clock((Date.now() - started.getTime()) / 1000);
  }, 250);
  $("record").textContent = "Stop and write note";
  $("record").classList.add("recording");
  setWork("Recording", {
    live: true,
    hint: "When you stop, Lantern writes down who said what, then drafts the note. Audio is processed on this laptop and never sent anywhere.",
  });
  progress("Talk as usual.");
  renderVisits();
}

function stopRecording() {
  clearInterval(state.tick);
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

// Takes a blob URL of the recording, or null when a saved visit has none.
function setAudio(url) {
  player.pause();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = url;
  if (url) player.src = url;
  else player.removeAttribute("src");
}

// Playing is off unless the clinician turns it on: a laptop that suddenly talks is
// unwelcome next to a patient. The choice is remembered in this browser.
function setSound(on) {
  $("sound").checked = on;
  document.body.classList.toggle("sound-off", !on);
  if (!on) player.pause();
  try { localStorage.setItem("lantern.sound", on ? "on" : "off"); } catch { /* private window: not remembered */ }
}

function playRange(start, end) {
  if (!state.audioUrl || !$("sound").checked) return;
  clearTimeout(playTimer);
  const from = Math.max(0, start - 0.1);
  player.currentTime = from;
  player.play().catch(() => {});
  playTimer = setTimeout(() => player.pause(), (end + 0.25 - from) * 1000);
}

function playLine(line) {
  const turn = state.turns.find((t) => t.id === line);
  if (turn) playRange(turn.start, turn.end);
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

async function processAudio(arrayBuffer, started = new Date()) {
  await flushSave();
  setBusy(true);
  state.visit = null;
  renderVisits();
  setWork("Writing the note", { hint: WAIT_HINT });
  let stop = progressTimer("Preparing the audio");
  try {
    const wav = await toWav(arrayBuffer);
    setAudio(URL.createObjectURL(wav));
    stop();
    stop = progressTimer("Writing down who said what");
    const result = await api("/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    stop();
    state.turns = result.turns;
    state.roles = result.roles;
    renderTranscript();

    const drafted = await draftNote();
    state.visit = { id: visitId(started), created: started.toISOString(), ...unverified(drafted) };
    renderNote(state.visit);
    await saveVisit();
    // The recording is saved next to the note, so its lines can still be played after a restart.
    api(`/api/visits/${state.visit.id}/audio`, { method: "PUT", headers: { "Content-Type": "audio/wav" }, body: wav })
      .catch((error) => progress(`The recording couldn't be saved: ${error.message}`, true));
  } catch (error) {
    stop();
    setView("empty");
    progress(`That didn't work: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function draftNote() {
  const stop = progressTimer("Drafting the note");
  try {
    return await api("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns: state.turns, roles: state.roles }),
    });
  } finally {
    stop();
  }
}

// A fresh draft: nothing in it has been verified by anyone yet.
function unverified({ note, sources, medications, allergies }) {
  return {
    note,
    sources,
    medications: medications.map((med) => ({ ...med, verified: false })),
    allergies: allergies.map((allergy) => ({ ...allergy, verified: false })),
  };
}

// ---------- saved visits ----------

// A visit's id is the local time it started, like 20261115-015200.
function visitId(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function visitTime(visit) {
  const date = new Date(visit.created);
  if (!Number.isNaN(date.getTime())) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${visit.id.slice(9, 11)}:${visit.id.slice(11, 13)}`;
}

async function loadVisits() {
  try {
    state.visits = (await api("/api/visits")).visits;
  } catch { /* the list stays as it was */ }
  renderVisits();
}

function renderVisits() {
  const items = state.visits.map((visit) => {
    const current = !state.recorder && state.visit?.id === visit.id;
    const button = el("button", current ? "visit current" : "visit");
    button.type = "button";
    if (current) button.setAttribute("aria-current", "true");
    const top = el("span", "visit-top");
    top.append(
      el("span", "visit-time", visitTime(visit)),
      visit.to_verify ? el("span", "visit-state todo", `${visit.to_verify} to verify`) : el("span", "visit-state done", "✓ Verified"),
    );
    button.append(top, el("span", "visit-title", visit.title));
    button.addEventListener("click", () => openVisit(visit.id));
    const item = el("li");
    item.append(button);
    if (current) {
      const remove = el("button", "visit-delete", "Delete this visit");
      remove.type = "button";
      remove.addEventListener("click", () => deleteVisit(visit));
      item.append(remove);
    }
    return item;
  });
  if (state.recorder) {
    const row = el("div", "visit current");
    const top = el("span", "visit-top");
    top.append(el("span", "visit-time", "Now"), el("span", "visit-state live", "● Recording"));
    row.append(top, el("span", "visit-title", "New visit"));
    const item = el("li");
    item.append(row);
    items.unshift(item);
  }
  $("visits").replaceChildren(...items);
  $("visits-none").hidden = items.length > 0;
  $("export").hidden = state.visits.length === 0;
}

async function openVisit(id) {
  if (state.busy || state.recorder || state.visit?.id === id) return;
  await flushSave();
  try {
    const record = await api(`/api/visits/${id}`);
    state.visit = { sources: {}, medications: [], allergies: [], ...record, id };
    state.turns = record.turns || [];
    state.roles = record.roles || {};
    const audio = await fetch(`/api/visits/${id}/audio`);
    setAudio(audio.ok ? URL.createObjectURL(await audio.blob()) : null);
    renderTranscript();
    renderNote(state.visit);
    notice("");
  } catch (error) {
    progress(`That visit couldn't be opened: ${error.message}`, true);
  }
  renderVisits();
}

async function deleteVisit(visit) {
  const question = `Delete "${visit.title}" from ${visitTime(visit)}? The note and its recording are removed from this laptop and cannot be recovered.`;
  if (state.busy || !confirm(question)) return;
  // Drop any pending save first, so it cannot bring the visit back.
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await api(`/api/visits/${visit.id}`, { method: "DELETE" });
    if (state.visit?.id === visit.id) {
      state.visit = null;
      setAudio(null);
      setView("empty");
      notice("");
    }
  } catch (error) {
    progress(`That visit couldn't be deleted: ${error.message}`, true);
  }
  await loadVisits();
}

// Reads the note back off the page, so edits and ticks are what gets saved.
function collect() {
  const visit = state.visit;
  visit.note.chief_complaint = $("n-cc").textContent.trim();
  visit.note.handoff = $("n-handoff").textContent.trim();
  for (const section of SECTIONS) {
    const rows = [...$(`n-${section}`).children];
    visit.note[section] = rows.map((row) => row.querySelector(".say").textContent.trim());
    visit.sources[section] = rows.map((row) => row.source);
  }
  for (const row of document.querySelectorAll(".check-row")) {
    row.item.verified = row.querySelector("input").checked;
    if (row.nameEl.isContentEditable) row.item.name = row.nameEl.textContent.trim();
  }
  visit.note.allergies = visit.allergies.map((allergy) => allergy.name);
  visit.turns = state.turns;
  visit.roles = state.roles;
  visit.text = noteAsText();
}

async function saveVisit() {
  if (!state.visit) return;
  collect();
  const { id, ...record } = state.visit;
  try {
    await api(`/api/visits/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
    await loadVisits();
  } catch (error) {
    progress(`This note isn't saved yet: ${error.message}`, true);
  }
}

// Every edit and every tick is saved shortly after it is made.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveVisit(); }, 500);
}
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveVisit();
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

function setTab(tab) {
  $("note-col").dataset.tab = tab;
  for (const name of ["note", "transcript"]) $(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
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

    const said = el("div");
    said.append(el("span", "role", role), text);
    item.append(num, said);
    list.append(item);
  }
}

// One sentence per row: the editable text, then where in the recording it came from.
function fillList(id, items = [], sources = []) {
  const list = $(id);
  list.replaceChildren(...items.map((item, index) => {
    const row = el("li");
    row.source = sources[index] ?? null;
    const say = el("span", "say", item);
    say.contentEditable = "true";
    say.spellcheck = false;
    // Clearing a sentence removes it, which is how a line with no source gets dismissed.
    say.addEventListener("blur", () => {
      if (!say.textContent.trim()) { row.remove(); updateBanner(); }
      scheduleSave();
    });
    row.append(say, " ", sourceChip(row.source));
    return row;
  }));
}

function sourceChip(source) {
  if (!source) return "";
  if (!source.line) return el("span", "check unheard", "✕ No source found");
  const chip = el("button", "src", `line ${source.line}`);
  chip.type = "button";
  chip.title = `Heard: "${source.quote}"`;
  chip.setAttribute("aria-label", `Show where this was said, line ${source.line}`);
  chip.addEventListener("click", () => showSource(source));
  return chip;
}

// Opens the transcript at the line and lights up the exact phrase. Plays it too if audio is switched on.
function showSource(source) {
  goToLine(source.line);
  const turn = $(`turn-${source.line}`);
  for (const part of turn ? turn.querySelectorAll(".part") : []) {
    const start = Number(part.dataset.start);
    if (start >= source.start - 0.01 && start < source.end) part.classList.add("lit");
  }
  playRange(source.start, source.end);
}

function goToLine(line) {
  setTab("transcript");
  document.querySelectorAll(".part.lit").forEach((part) => part.classList.remove("lit"));
  document.querySelectorAll(".turn.flash").forEach((turn) => turn.classList.remove("flash"));
  const turn = $(`turn-${line}`);
  if (!turn) return;
  turn.scrollIntoView({ behavior: "smooth", block: "center" });
  turn.classList.add("flash");
}

// Counts the medications and allergies nobody has ticked as verified yet.
function updateBanner() {
  const kinds = [
    { list: "meds", one: "medication", many: "medications" },
    { list: "allergies", one: "allergy", many: "allergies" },
  ].map((kind) => {
    const boxes = [...document.querySelectorAll(`#${kind.list} input`)];
    return { ...kind, total: boxes.length, left: boxes.filter((box) => !box.checked).length };
  }).filter((kind) => kind.total);

  const waiting = kinds.filter((kind) => kind.left);
  const left = waiting.reduce((sum, kind) => sum + kind.left, 0);
  // A "not found" mark stops counting once its row is ticked as verified.
  const unheard = [...document.querySelectorAll("#view-note .check.unheard")]
    .filter((mark) => !mark.closest(".check-row")?.querySelector("input").checked).length;

  const banner = $("med-banner");
  banner.hidden = kinds.length === 0 && unheard === 0;
  banner.className = left ? "banner" : "banner clear";
  $("banner-count").textContent = left || "✓";
  if (left) {
    const counts = waiting.map((kind) => `${kind.left} ${kind.left === 1 ? kind.one : kind.many}`);
    $("banner-text").textContent = `${counts.join(" and ")} to verify before this note is used.`;
  } else if (kinds.length) {
    $("banner-text").textContent = `All ${kinds.map((kind) => kind.many).join(" and ")} verified.`;
  } else {
    $("banner-text").textContent = "No medications or allergies to verify.";
  }
  $("banner-unheard").hidden = !unheard;
  $("banner-unheard").textContent = `✕ ${unheard} ${unheard === 1 ? "detail was" : "details were"} not found in the recording.`;
}

function mark(heard, label) {
  return el("span", `check ${heard ? "heard" : "unheard"}`, heard ? `✓ ${label} heard` : `✕ ${label} not heard`);
}

function lineLink(line) {
  const link = el("button", "line-link", `line ${line}`);
  link.type = "button";
  link.setAttribute("aria-label", `Show line ${line}`);
  link.addEventListener("click", () => { goToLine(line); playLine(line); });
  return link;
}

// One allergy or medication: the box to tick, its name, and what the recording says about it.
function checkRow(item, label, marks) {
  const row = el("li", "check-row");
  row.item = item;
  row.nameEl = label.querySelector(".check-name");

  const box = el("input");
  box.type = "checkbox";
  box.checked = Boolean(item.verified);
  box.setAttribute("aria-label", `Verified ${item.name}`);

  const status = el("span", "check-state");
  const top = el("div", "check-top");
  top.append(label, status);
  const evidence = el("p", "check-evidence");
  evidence.append(...marks);
  if (item.line) evidence.append(lineLink(item.line));
  if (item.line_text) evidence.append(el("span", "quote", `“${item.line_text}”`));
  const main = el("div");
  main.append(top, evidence);

  const show = () => {
    row.classList.toggle("verified", box.checked);
    status.textContent = box.checked ? "Verified" : "Not yet verified";
  };
  box.addEventListener("change", () => { show(); updateBanner(); scheduleSave(); });
  show();
  row.append(box, main);
  return row;
}

function renderNote({ created, note, medications, allergies, sources }) {
  $("n-cc").textContent = note.chief_complaint || "Visit note";
  $("n-date").textContent = new Date(created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  for (const section of SECTIONS) fillList(`n-${section}`, note[section], sources[section]);
  $("n-handoff").textContent = note.handoff;

  $("allergies").replaceChildren(...allergies.map((allergy) => {
    const label = el("span");
    const name = el("strong", "check-name", allergy.name);
    name.contentEditable = "true";
    name.spellcheck = false;
    name.addEventListener("blur", scheduleSave);
    label.append(name);
    return checkRow(allergy, label, [mark(allergy.heard, "Allergy")]);
  }));
  $("allergies").hidden = allergies.length === 0;
  $("allergies-none").hidden = allergies.length !== 0;

  $("meds").replaceChildren(...medications.map((med) => {
    const label = el("span");
    label.append(el("strong", "check-name", med.name), med.dose ? `, ${med.dose}` : "");
    const marks = [mark(med.name_heard, "Drug")];
    marks.push(med.dose ? mark(med.dose_heard, "Dose") : el("span", "check nodose", "No dose said"));
    return checkRow(med, label, marks);
  }));
  $("meds").hidden = medications.length === 0;
  $("meds-none").hidden = medications.length !== 0;

  updateBanner();
  setTab("note");
  setView("note");
  notice("");
}

function noteAsText() {
  const items = (id) => [...$(id).querySelectorAll("li")]
    .map((li) => `- ${li.querySelector(".say").textContent}${li.querySelector(".unheard") ? " (NOT found in recording)" : ""}`)
    .join("\n") || "- Nothing was said.";
  const verified = (row) => (row.querySelector("input").checked ? " (verified)" : " (NOT verified)");
  const meds = [...$("meds").children]
    .map((row) => `- ${row.item.name}, ${row.item.dose || "none said"}${verified(row)}`)
    .join("\n") || "- None mentioned.";
  const allergies = [...$("allergies").children]
    .map((row) => `- ${row.nameEl.textContent.trim()}${verified(row)}`)
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

$("tab-note").addEventListener("click", () => setTab("note"));
$("tab-transcript").addEventListener("click", () => setTab("transcript"));

$("swap").addEventListener("click", async () => {
  for (const speaker of Object.keys(state.roles)) {
    if (state.roles[speaker] === "clinician") state.roles[speaker] = "patient";
    else if (state.roles[speaker] === "patient") state.roles[speaker] = "clinician";
  }
  renderTranscript();
  clearTimeout(saveTimer);
  saveTimer = null;
  setBusy(true);
  setWork("Writing the note", { hint: WAIT_HINT });
  try {
    // A redrafted note has to be verified again.
    Object.assign(state.visit, unverified(await draftNote()));
    renderNote(state.visit);
    setTab("transcript");
    await saveVisit();
  } catch (error) {
    setView("note");
    progress(`The note couldn't be drafted: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

$("n-cc").addEventListener("blur", scheduleSave);
$("n-handoff").addEventListener("blur", scheduleSave);

$("sound").addEventListener("change", (event) => setSound(event.target.checked));

$("print").addEventListener("click", () => window.print());

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(noteAsText());
    progress("Note copied as text.");
    setTimeout(() => { if ($("progress").textContent === "Note copied as text.") notice(""); }, 4000);
  } catch {
    progress("Copying was blocked by the browser. Select the note and copy it by hand.", true);
  }
});

window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
showNetwork();
let soundChoice = null;
try { soundChoice = localStorage.getItem("lantern.sound"); } catch { /* private window */ }
setSound(soundChoice === "on");

checkHealth();
setInterval(checkHealth, 5000);
loadVisits();
fetch("sample-visit.wav", { method: "HEAD" }).then((r) => { $("sample").hidden = !r.ok; }).catch(() => {});
