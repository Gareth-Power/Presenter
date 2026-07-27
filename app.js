(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const els = {
    error: $("error"),
    setup: $("setup"), recording: $("recording"), done: $("done"),
    permGate: $("permGate"), btnPerm: $("btnPerm"), pickers: $("devicePickers"),
    cam: $("camSelect"), mic: $("micSelect"), micLevel: $("micLevel"), mirror: $("mirrorChk"),
    btnScreen: $("btnScreen"), screenStatus: $("screenStatus"),
    screenPreview: $("screenPreview"), camPreview: $("camPreview"),
    btnStart: $("btnStart"), btnStop: $("btnStop"), btnAgain: $("btnAgain"),
    composite: $("compositePreview"), timer: $("timer"), recStatus: $("recStatus"),
    manualLink: $("manualLink"), doneMsg: $("doneMsg"),
    canvas: $("stage"),
    srcScreen: $("srcScreen"), srcCam: $("srcCam"),
    trim: $("trim"), trimVideo: $("trimVideo"), trimBar: $("trimBar"),
    trimSel: $("trimSel"), trimPlayhead: $("trimPlayhead"),
    handleIn: $("handleIn"), handleOut: $("handleOut"),
    readIn: $("readIn"), readOut: $("readOut"), readLen: $("readLen"),
    btnPlaySel: $("btnPlaySel"), btnResetTrim: $("btnResetTrim"), trimStatus: $("trimStatus"),
    exportProgress: $("exportProgress"), exportBar: $("exportBar"), exportNote: $("exportNote"),
    btnSave: $("btnSave"), btnDiscard: $("btnDiscard")
  };

  // Point a preview element and its offscreen twin at the same stream.
  async function attach(previewEl, sourceEl, stream) {
    previewEl.srcObject = stream;
    sourceEl.srcObject = stream;
    await Promise.all([previewEl.play(), sourceEl.play()].map(p => p.catch(() => {})));
  }

  // --- tunables for the webcam bubble -------------------------------------
  const BUBBLE_HEIGHT_RATIO = 0.24;   // diameter as a fraction of video height
  const BUBBLE_MARGIN_RATIO = 0.035;  // gap from the bottom-left corner
  const FPS = 30;

  const state = {
    camStream: null,
    micStream: null,
    screenStream: null,
    recorder: null,
    chunks: [],
    canvasStream: null,
    audioCtx: null,
    drawTimer: null,
    frameCbHandle: null,
    watchdog: null,
    stopDrawing: false,
    startedAt: 0,
    timerTick: null,
    lastBlobUrl: null,
    outputExt: "webm",
    rawBlob: null,
    mbPromise: null
  };

  // Trim page state. Times are in seconds.
  const trim = { duration: 0, in: 0, out: 0, dragging: null, playing: false, ready: false };

  // Mediabunny is ~600KB, so it is only fetched once a recording is under way —
  // by the time anyone presses stop it has usually already arrived.
  function loadMediabunny() {
    if (!state.mbPromise) state.mbPromise = import("./mediabunny.min.js");
    return state.mbPromise;
  }

  const showError = msg => {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  };
  const clearError = () => els.error.classList.add("hidden");

  // ---------------------------------------------------------------- support
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    showError("This browser can't capture the screen. Use a recent Chrome, Edge, or Firefox on desktop.");
    els.btnPerm.disabled = true;
    els.btnScreen.disabled = true;
  }

  // ------------------------------------------------------- device selection
  els.btnPerm.addEventListener("click", async () => {
    clearError();
    els.btnPerm.disabled = true;
    try {
      // A throwaway grant so enumerateDevices() returns real labels.
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      probe.getTracks().forEach(t => t.stop());
      await listDevices();
      els.permGate.classList.add("hidden");
      els.pickers.classList.remove("hidden");
      await openCamAndMic();
    } catch (err) {
      els.btnPerm.disabled = false;
      showError(describeMediaError(err, "camera and microphone"));
    }
  });

  async function listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill(els.cam, devices.filter(d => d.kind === "videoinput"), "Camera");
    fill(els.mic, devices.filter(d => d.kind === "audioinput"), "Microphone");
  }

  function fill(select, devices, fallbackLabel) {
    const previous = select.value;
    select.innerHTML = "";
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
      select.appendChild(opt);
    });
    if (devices.some(d => d.deviceId === previous)) select.value = previous;
    select.disabled = devices.length === 0;
    if (devices.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = `No ${fallbackLabel.toLowerCase()} found`;
      select.appendChild(opt);
    }
  }

  // Opens (or re-opens) cam + mic using whatever the dropdowns currently say.
  async function openCamAndMic() {
    stopStream(state.camStream);
    stopStream(state.micStream);
    state.camStream = null;
    state.micStream = null;

    try {
      if (els.cam.value) {
        state.camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: els.cam.value },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
        await attach(els.camPreview, els.srcCam, state.camStream);
      }
      if (els.mic.value) {
        state.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: els.mic.value },
            echoCancellation: true,
            noiseSuppression: true
          }
        });
        attachLevelMeter(state.micStream);
      }
    } catch (err) {
      showError(describeMediaError(err, "the selected device"));
    }
    refreshStartButton();
  }

  els.cam.addEventListener("change", openCamAndMic);
  els.mic.addEventListener("change", openCamAndMic);
  els.mirror.addEventListener("change", () => {
    els.camPreview.classList.toggle("mirrored", els.mirror.checked);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);

  // A small live meter so the user can confirm the mic actually works.
  let meterCtx = null;
  function attachLevelMeter(stream) {
    meterCtx?.close().catch(() => {});
    meterCtx = new AudioContext();
    const source = meterCtx.createMediaStreamSource(stream);
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!meterCtx || meterCtx.state === "closed") return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      els.micLevel.style.width = Math.min(100, peak * 220) + "%";
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------------------------------------------------------- screen picker
  els.btnScreen.addEventListener("click", async () => {
    clearError();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: FPS } },
        audio: true // only honoured if the user ticks "share audio" in the picker
      });
      stopStream(state.screenStream);
      state.screenStream = stream;
      await attach(els.screenPreview, els.srcScreen, stream);

      const track = stream.getVideoTracks()[0];
      const hasAudio = stream.getAudioTracks().length > 0;
      els.screenStatus.textContent =
        `${track.label || "Screen"} selected${hasAudio ? " · with system audio" : ""}`;
      els.screenStatus.classList.add("ok");
      els.btnScreen.textContent = "Change screen…";

      // "Stop sharing" from the browser's own bar ends the source.
      track.addEventListener("ended", onScreenEnded);
    } catch (err) {
      if (err.name !== "NotAllowedError" && err.name !== "AbortError") {
        showError(describeMediaError(err, "the screen"));
      }
    }
    refreshStartButton();
  });

  function onScreenEnded() {
    if (state.recorder && state.recorder.state === "recording") {
      els.recStatus.textContent = "Screen sharing ended — finishing up…";
      stopRecording();
    } else {
      state.screenStream = null;
      els.screenPreview.srcObject = null;
      els.srcScreen.srcObject = null;
      els.screenStatus.textContent = "Nothing selected yet.";
      els.screenStatus.classList.remove("ok");
      els.btnScreen.textContent = "Choose screen…";
      refreshStartButton();
    }
  }

  function refreshStartButton() {
    els.btnStart.disabled = !(state.screenStream && state.camStream);
    els.btnStart.textContent = state.screenStream
      ? (state.camStream ? "Begin recording" : "Waiting for webcam…")
      : "Choose a screen first";
    if (!els.btnStart.disabled) els.btnStart.textContent = "Begin recording";
  }

  // -------------------------------------------------------------- recording
  els.btnStart.addEventListener("click", startRecording);
  els.btnStop.addEventListener("click", stopRecording);
  els.btnAgain.addEventListener("click", () => location.reload());

  async function startRecording() {
    clearError();
    els.btnStart.disabled = true;
    loadMediabunny().catch(() => {}); // warm the trim engine in the background

    const screenVideo = els.srcScreen;
    const camVideo = els.srcCam;

    // Match the canvas to the real capture resolution, not the CSS size.
    const settings = state.screenStream.getVideoTracks()[0].getSettings();
    const width = settings.width || screenVideo.videoWidth || 1920;
    const height = settings.height || screenVideo.videoHeight || 1080;
    els.canvas.width = width;
    els.canvas.height = height;
    const ctx = els.canvas.getContext("2d", { alpha: false });

    startDrawLoop(ctx, screenVideo, camVideo, width, height);

    state.canvasStream = els.canvas.captureStream(FPS);
    const mixedAudio = buildAudioTrack();
    if (mixedAudio) state.canvasStream.addTrack(mixedAudio);

    els.composite.srcObject = state.canvasStream;
    els.composite.play().catch(() => {});

    const mimeType = pickMimeType();
    state.recordedExt = mimeType.includes("mp4") ? "mp4" : "webm";
    state.outputExt = state.recordedExt;
    state.chunks = [];

    try {
      state.recorder = new MediaRecorder(state.canvasStream, {
        mimeType,
        videoBitsPerSecond: 6_000_000,
        audioBitsPerSecond: 128_000
      });
    } catch (err) {
      showError("Couldn't start the recorder: " + err.message);
      els.btnStart.disabled = false;
      return;
    }

    state.recorder.ondataavailable = e => { if (e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = finalize;
    state.recorder.onerror = e => showError("Recorder error: " + (e.error?.message || "unknown"));
    state.recorder.start(1000); // flush a chunk every second

    state.startedAt = Date.now();
    els.timer.textContent = "00:00";
    state.timerTick = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      els.timer.textContent =
        String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 250);

    els.setup.classList.add("hidden");
    els.recording.classList.remove("hidden");
    window.addEventListener("beforeunload", warnOnLeave);
  }

  const warnOnLeave = e => { e.preventDefault(); e.returnValue = ""; };

  // Composites screen + circular webcam onto the canvas.
  function startDrawLoop(ctx, screenVideo, camVideo, width, height) {
    state.stopDrawing = false;
    let lastDraw = 0;

    const draw = () => {
      if (state.stopDrawing) return;
      lastDraw = Date.now();

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      // Screen, letterboxed so nothing is cropped.
      if (screenVideo.videoWidth) {
        const scale = Math.min(width / screenVideo.videoWidth, height / screenVideo.videoHeight);
        const w = screenVideo.videoWidth * scale;
        const h = screenVideo.videoHeight * scale;
        ctx.drawImage(screenVideo, (width - w) / 2, (height - h) / 2, w, h);
      }

      // Webcam bubble, bottom-left.
      if (camVideo.videoWidth) {
        const d = height * BUBBLE_HEIGHT_RATIO;
        const margin = height * BUBBLE_MARGIN_RATIO;
        const cx = margin + d / 2;
        const cy = height - margin - d / 2;

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = d * 0.08;
        ctx.shadowOffsetY = d * 0.02;
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.clip();

        // Centre-crop the camera frame so the circle is always filled.
        const cs = Math.max(d / camVideo.videoWidth, d / camVideo.videoHeight);
        const cw = camVideo.videoWidth * cs;
        const ch = camVideo.videoHeight * cs;
        if (els.mirror.checked) {
          ctx.translate(cx, cy);
          ctx.scale(-1, 1);
          ctx.drawImage(camVideo, -cw / 2, -ch / 2, cw, ch);
        } else {
          ctx.drawImage(camVideo, cx - cw / 2, cy - ch / 2, cw, ch);
        }
        ctx.restore();

        // Ring.
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, d / 2 - 1, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, d * 0.012);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
        ctx.restore();
      }

      schedule(draw);
    };

    // Drive off webcam frames: unlike requestAnimationFrame, these keep firing
    // when the tab is in the background, which is the normal case here.
    const canUseFrameCb = typeof camVideo.requestVideoFrameCallback === "function";
    function schedule(fn) {
      if (state.stopDrawing) return;
      if (canUseFrameCb) state.frameCbHandle = camVideo.requestVideoFrameCallback(() => fn());
      else state.drawTimer = setTimeout(fn, 1000 / FPS);
    }

    // If the camera stalls (unplugged, throttled, frame callbacks starved) the
    // canvas would freeze and the recording with it. Keep it ticking over.
    state.watchdog = setInterval(() => {
      if (!state.stopDrawing && Date.now() - lastDraw > 150) draw();
    }, 150);

    draw();
  }

  // Mic + optional system audio into one track.
  function buildAudioTrack() {
    const micTrack = state.micStream?.getAudioTracks()[0];
    const sysTracks = state.screenStream.getAudioTracks();
    if (!micTrack && sysTracks.length === 0) return null;

    state.audioCtx = new AudioContext();
    const dest = state.audioCtx.createMediaStreamDestination();

    if (micTrack) {
      const g = state.audioCtx.createGain();
      g.gain.value = 1.0;
      state.audioCtx.createMediaStreamSource(new MediaStream([micTrack])).connect(g);
      g.connect(dest);
    }
    if (sysTracks.length) {
      const g = state.audioCtx.createGain();
      g.gain.value = 0.85; // duck system audio slightly under the voice
      state.audioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(g);
      g.connect(dest);
    }
    return dest.stream.getAudioTracks()[0];
  }

  function pickMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm",
      "video/mp4"
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
  }

  function stopRecording() {
    els.btnStop.disabled = true;
    els.recStatus.textContent = "Finishing up…";
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.stop();
    } else {
      finalize();
    }
  }

  function finalize() {
    clearInterval(state.timerTick);
    state.stopDrawing = true;
    clearTimeout(state.drawTimer);
    clearInterval(state.watchdog);

    // The beforeunload guard stays armed until the clip is actually saved.
    state.rawBlob = new Blob(state.chunks, { type: state.recorder?.mimeType || "video/webm" });

    els.recording.classList.add("hidden");
    els.trim.classList.remove("hidden");

    // Release the hardware — the tab-is-recording indicator goes away.
    [state.screenStream, state.camStream, state.micStream, state.canvasStream].forEach(stopStream);
    state.audioCtx?.close().catch(() => {});
    meterCtx?.close().catch(() => {});

    openTrimEditor(state.rawBlob);
  }

  // ------------------------------------------------------------------- trim
  const fmt = t => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  };

  async function openTrimEditor(blob) {
    els.trimVideo.src = URL.createObjectURL(blob);
    els.trimStatus.textContent = "Reading the recording…";

    let duration = 0;
    try {
      const mb = await loadMediabunny();
      // MediaRecorder writes WebM with no duration in the header, so the video
      // element usually reports Infinity. Mediabunny reads the real length.
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
      duration = await input.computeDuration();
      trim.ready = true;
    } catch (err) {
      console.warn("Trim engine unavailable", err);
      duration = await probeDuration(els.trimVideo);
      trim.ready = false;
    }

    trim.duration = duration;
    trim.in = 0;
    trim.out = duration;

    if (trim.ready) {
      els.trimBar.setAttribute("aria-disabled", "false");
      els.trimStatus.textContent = `${fmt(duration)} recorded`;
      els.btnSave.textContent = "Save clip";
    } else {
      els.trimStatus.textContent =
        "Trimming is unavailable — the whole recording will be saved instead.";
      els.btnSave.textContent = "Save recording";
    }

    els.btnSave.disabled = false;
    renderTrim();
  }

  // Fallback when mediabunny can't load: force the browser to resolve a WebM
  // with an unknown duration by seeking far past the end.
  function probeDuration(video) {
    return new Promise(resolve => {
      if (isFinite(video.duration) && video.duration > 0) return resolve(video.duration);
      const done = () => {
        video.removeEventListener("durationchange", onChange);
        video.currentTime = 0;
        resolve(isFinite(video.duration) ? video.duration : 0);
      };
      const onChange = () => { if (isFinite(video.duration)) done(); };
      video.addEventListener("durationchange", onChange);
      video.addEventListener("loadedmetadata", () => { video.currentTime = 1e101; }, { once: true });
      setTimeout(done, 3000);
    });
  }

  function renderTrim() {
    const d = trim.duration || 1;
    const inPct = (trim.in / d) * 100;
    const outPct = (trim.out / d) * 100;
    els.trimSel.style.left = inPct + "%";
    els.trimSel.style.width = (outPct - inPct) + "%";
    els.handleIn.style.left = inPct + "%";
    els.handleOut.style.left = outPct + "%";
    els.readIn.textContent = fmt(trim.in);
    els.readOut.textContent = fmt(trim.out);
    els.readLen.textContent = fmt(trim.out - trim.in);
    renderPlayhead();
  }

  function renderPlayhead() {
    const d = trim.duration || 1;
    els.trimPlayhead.style.left = ((els.trimVideo.currentTime || 0) / d) * 100 + "%";
  }

  const timeFromEvent = e => {
    const r = els.trimBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * trim.duration;
  };

  const MIN_CLIP = 0.2; // never let the handles cross or meet

  function setHandle(role, t) {
    if (role === "in") trim.in = Math.max(0, Math.min(t, trim.out - MIN_CLIP));
    else trim.out = Math.min(trim.duration, Math.max(t, trim.in + MIN_CLIP));
    renderTrim();
  }

  [["in", els.handleIn], ["out", els.handleOut]].forEach(([role, handle]) => {
    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      trim.dragging = role;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", e => {
      if (trim.dragging !== role) return;
      setHandle(role, timeFromEvent(e));
      els.trimVideo.currentTime = role === "in" ? trim.in : trim.out;
    });
    handle.addEventListener("pointerup", e => {
      trim.dragging = null;
      handle.releasePointerCapture(e.pointerId);
    });
    handle.addEventListener("keydown", e => {
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === "ArrowLeft") setHandle(role, (role === "in" ? trim.in : trim.out) - step);
      else if (e.key === "ArrowRight") setHandle(role, (role === "in" ? trim.in : trim.out) + step);
      else return;
      e.preventDefault();
      els.trimVideo.currentTime = role === "in" ? trim.in : trim.out;
    });
  });

  // Clicking anywhere else on the bar scrubs.
  els.trimBar.addEventListener("pointerdown", e => {
    if (trim.dragging) return;
    els.trimVideo.currentTime = timeFromEvent(e);
    renderPlayhead();
  });

  els.trimVideo.addEventListener("timeupdate", () => {
    renderPlayhead();
    // Stop at the out point while previewing the selection.
    if (trim.playing && els.trimVideo.currentTime >= trim.out) {
      els.trimVideo.pause();
      trim.playing = false;
      els.btnPlaySel.textContent = "Play selection";
    }
  });

  els.btnPlaySel.addEventListener("click", () => {
    if (trim.playing) {
      els.trimVideo.pause();
      trim.playing = false;
      els.btnPlaySel.textContent = "Play selection";
      return;
    }
    els.trimVideo.currentTime = trim.in;
    els.trimVideo.play().catch(() => {});
    trim.playing = true;
    els.btnPlaySel.textContent = "Pause";
  });

  els.trimVideo.addEventListener("pause", () => {
    trim.playing = false;
    els.btnPlaySel.textContent = "Play selection";
  });

  els.btnResetTrim.addEventListener("click", () => {
    trim.in = 0;
    trim.out = trim.duration;
    renderTrim();
  });

  els.btnDiscard.addEventListener("click", () => {
    if (confirm("Discard this recording and start over? It has not been saved.")) {
      window.removeEventListener("beforeunload", warnOnLeave);
      location.reload();
    }
  });

  // ------------------------------------------------------------------ export
  els.btnSave.addEventListener("click", saveClip);

  async function saveClip() {
    clearError();
    els.btnSave.disabled = true;
    els.btnDiscard.disabled = true;

    const untrimmed = !trim.ready || (trim.in <= 0.05 && trim.out >= trim.duration - 0.05);

    // Nothing was trimmed, so hand over the original bytes untouched.
    if (untrimmed) {
      state.outputExt = state.recordedExt || "webm";
      deliver(state.rawBlob);
      return;
    }

    state.outputExt = state.recordedExt || "webm";

    els.exportProgress.classList.remove("hidden");
    els.exportBar.style.width = "0%";
    els.exportNote.textContent = "Trimming…";

    try {
      const mb = await loadMediabunny();
      const input = new mb.Input({
        formats: mb.ALL_FORMATS,
        source: new mb.BlobSource(state.rawBlob)
      });
      const output = new mb.Output({
        format: new mb.WebMOutputFormat(),
        target: new mb.BufferTarget()
      });
      const conversion = await mb.Conversion.init({
        input,
        output,
        trim: { start: trim.in, end: trim.out }
      });

      if (!conversion.isValid) {
        throw new Error("this recording can't be trimmed (" +
          conversion.discardedTracks.map(t => t.reason).join(", ") + ")");
      }

      conversion.onProgress = p => {
        els.exportBar.style.width = Math.round(p * 100) + "%";
        els.exportNote.textContent = `Trimming… ${Math.round(p * 100)}%`;
      };

      await conversion.execute();
      els.exportProgress.classList.add("hidden");
      deliver(new Blob([output.target.buffer], { type: "video/webm" }));
    } catch (err) {
      els.exportProgress.classList.add("hidden");
      els.btnSave.disabled = false;
      els.btnDiscard.disabled = false;
      showError(`Couldn't trim the recording: ${err.message || err}` +
        " — press Save again to download the original untouched.");
      trim.ready = false;
      els.btnSave.textContent = "Save original recording";
      els.trimBar.setAttribute("aria-disabled", "true");
    }
  }

  // dd-mm-yyyy-hhmm in the machine's own timezone. toISOString() was giving UTC,
  // so recordings made during BST were stamped an hour early.
  function ukStamp(d = new Date()) {
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}` +
           `-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // Downloads the finished blob and moves to the confirmation page.
  function deliver(blob) {
    const url = URL.createObjectURL(blob);
    state.lastBlobUrl = url;

    const filename = `presenter-${ukStamp()}.${state.outputExt}`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    els.manualLink.href = url;
    els.manualLink.download = filename;
    els.doneMsg.textContent =
      `${filename} · ${(blob.size / 1048576).toFixed(1)} MB · ${fmt(trim.out - trim.in)}`;

    els.trimVideo.pause();
    window.removeEventListener("beforeunload", warnOnLeave);
    els.trim.classList.add("hidden");
    els.done.classList.remove("hidden");
  }

  // ----------------------------------------------------------------- helpers
  function stopStream(stream) {
    stream?.getTracks().forEach(t => t.stop());
  }

  function describeMediaError(err, what) {
    switch (err.name) {
      case "NotAllowedError":
        return `Permission to use ${what} was denied. Check the padlock icon in the address bar to re-allow it.`;
      case "NotFoundError":
        return `No ${what} was found on this machine.`;
      case "NotReadableError":
        return `${what[0].toUpperCase() + what.slice(1)} is already in use by another app. Close Zoom/Teams/OBS and try again.`;
      case "OverconstrainedError":
        return `That device no longer exists — pick another one.`;
      default:
        return `Couldn't access ${what}: ${err.message || err.name}`;
    }
  }
})();

