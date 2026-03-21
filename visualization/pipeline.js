// Larmindon Audio Pipeline Visualization
// Vanilla JS — no frameworks

(function () {
  'use strict';

  // ─── Constants (matching the real system) ─────────────────────────
  const ASR_SAMPLE_RATE = 16000;
  const VAD_FRAME_SIZE = 512;         // 32ms at 16kHz
  const PRE_SPEECH_CAPACITY = 8000;   // 500ms ring buffer
  const CHUNK_SIZE = 8960;            // 560ms default
  const EMPTY_RESET_THRESHOLD = 6;
  const INPUT_RATE = 48000;
  const MIN_SPEECH_FRAMES = 8;        // ~250ms (8 * 32ms)
  const MIN_SILENCE_FRAMES = 16;      // ~500ms (16 * 32ms)

  // Simulated phrases
  const PHRASES = [
    'Hello world.',
    'This is a test of the transcription system.',
    'The quick brown fox jumps over the lazy dog.',
    'Speech recognition is working correctly.',
    'Larmindon processes audio in real time.',
    'How does the pipeline handle silence?',
    'Punctuation triggers decoder resets!',
    'The ring buffer stores pre-speech context.',
  ];

  // ─── DOM refs ─────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const btnStart = $('btn-start');
  const btnStop = $('btn-stop');
  const speedSlider = $('speed');
  const speedLabel = $('speed-label');
  const scenarioSelect = $('scenario');
  const eventLog = $('event-log');

  // SVG elements
  const bufferFill = $('buffer-fill');
  const bufferCount = $('buffer-count');
  const resampleIndicator = $('resample-indicator');
  const vadState = $('vad-state');
  const vadProbFill = $('vad-prob-fill');
  const ringFill = $('ring-fill');
  const ringCount = $('ring-count');
  const ringPct = $('ring-pct');
  const asrFill = $('asr-fill');
  const asrCount = $('asr-count');
  const nemotronStatus = $('nemotron-status');
  const nemotronTiming = $('nemotron-timing');
  const inferProgress = $('infer-progress');
  const emptyCountEl = $('empty-count');
  const outputText = $('output-text');
  const resetLabel = $('reset-label');
  const waveformInput = $('waveform-input');
  const particlesGroup = $('particles');

  // Connections
  const conns = {
    deviceBuffer:    $('conn-device-buffer'),
    bufferResample:  $('conn-buffer-resample'),
    resampleVad:     $('conn-resample-vad'),
    vadRing:         $('conn-vad-ring'),
    vadAsr:          $('conn-vad-asr'),
    ringAsr:         $('conn-ring-asr'),
    asrNemotron:     $('conn-asr-nemotron'),
    nemotronOutput:  $('conn-nemotron-output'),
    resetLoop:       $('conn-reset-loop'),
    nemotronDiag:    $('conn-nemotron-diag'),
  };

  // Stages
  const stages = {
    device:    $('stage-device'),
    buffer:    $('stage-buffer'),
    resample:  $('stage-resample'),
    vad:       $('stage-vad'),
    ring:      $('stage-ring'),
    asrBuffer: $('stage-asr-buffer'),
    nemotron:  $('stage-nemotron'),
    output:    $('stage-output'),
  };

  // ─── Simulation state ─────────────────────────────────────────────
  let running = false;
  let animFrame = null;
  let speed = 1;
  let simTime = 0;
  let diagEventCount = 0;

  let sharedBufferLevel = 0;
  const SHARED_BUFFER_MAX = 4800;

  let ringBufferLevel = 0;
  let asrBufferLevel = 0;

  let vadCurrentState = 'silence';
  let vadProb = 0;
  let speechFrameCount = 0;
  let silenceFrameCount = 0;

  let inferring = false;
  let inferStartTime = 0;
  let inferDuration = 0;
  let consecutiveEmpty = 0;

  let phraseIndex = 0;
  let scenario = 'speech';

  let lastTick = 0;
  let vadTickAccum = 0;
  let drainAccum = 0;

  // Pending timeouts to clear on stop
  let pendingTimeouts = [];

  // ─── Scenario: target VAD probability ─────────────────────────────
  function getTargetProb(t) {
    switch (scenario) {
      case 'silence':
        return 0.05 + Math.random() * 0.1;

      case 'speech': {
        // 2.5s silence at start so ring buffer fills visibly,
        // then speech with periodic ~1.5s pauses every ~7s
        if (t < 2500) return 0.08 + Math.random() * 0.1;
        const cycle = ((t - 2500) % 7500);
        if (cycle > 6000) return 0.1 + Math.random() * 0.1;
        return 0.7 + Math.sin(t * 0.001) * 0.15 + Math.random() * 0.1;
      }

      case 'intermittent': {
        // 4s speech, 3s silence — long enough to see ring buffer fill
        const cycle = (t % 7000);
        if (cycle < 4000) return 0.75 + Math.random() * 0.15;
        return 0.08 + Math.random() * 0.1;
      }

      case 'stuck': {
        if (t < 2000) return 0.08 + Math.random() * 0.1;
        return 0.65 + Math.random() * 0.2;
      }

      default:
        return 0.3;
    }
  }

  // ─── Waveform generator ───────────────────────────────────────────
  let wavePhase = 0;

  function generateWaveform(amplitude) {
    const pts = [];
    for (let x = 0; x < 165; x += 3) {
      const mid = 15;
      const y = mid + amplitude * mid * (
        Math.sin((x + wavePhase) * 0.08) * 0.6 +
        Math.sin((x + wavePhase) * 0.15) * 0.3 +
        (Math.random() - 0.5) * 0.4
      );
      pts.push(`${x},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }

  // ─── Particle system ──────────────────────────────────────────────
  const particles = [];

  function spawnParticle(pathEl, color, duration) {
    if (!pathEl) return;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', color || '#22d3ee');
    circle.setAttribute('opacity', '0.9');
    particlesGroup.appendChild(circle);

    const pathLength = pathEl.getTotalLength();
    particles.push({ circle, pathEl, pathLength, progress: 0, duration: duration || 600 });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.progress += dt / p.duration;
      if (p.progress >= 1) {
        p.circle.remove();
        particles.splice(i, 1);
        continue;
      }
      const pt = p.pathEl.getPointAtLength(p.progress * p.pathLength);
      p.circle.setAttribute('cx', pt.x);
      p.circle.setAttribute('cy', pt.y);
      p.circle.setAttribute('opacity', (1 - p.progress * 0.5).toFixed(2));
    }
  }

  function clearParticles() {
    for (const p of particles) p.circle.remove();
    particles.length = 0;
  }

  // Throttled spawn
  const spawnTimers = {};
  function spawnThrottled(key, pathEl, color, dur, prob) {
    if (Math.random() > (prob || 0.2)) return;
    const now = simTime;
    if (spawnTimers[key] && now - spawnTimers[key] < 150) return;
    spawnTimers[key] = now;
    spawnParticle(pathEl, color, dur);
  }

  // ─── Event logging ────────────────────────────────────────────────
  function logEvent(type, detail) {
    const secs = (simTime / 1000).toFixed(1);
    const ev = document.createElement('div');
    ev.className = 'ev';
    ev.innerHTML = `<span class="ev-time">${secs}s</span><span class="ev-type ${type}">${type}</span><span class="ev-detail">${detail || ''}</span>`;
    eventLog.appendChild(ev);
    eventLog.scrollTop = eventLog.scrollHeight;
    while (eventLog.children.length > 200) eventLog.removeChild(eventLog.firstChild);
    diagEventCount++;
  }

  // ─── Helpers ──────────────────────────────────────────────────────
  function setConnActive(conn, active) {
    if (!conn) return;
    conn.classList.toggle('active', !!active);
  }

  function setStageActive(stage, active) {
    if (!stage) return;
    stage.classList.toggle('active', !!active);
  }

  function safeTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    pendingTimeouts.push(id);
    return id;
  }

  // ─── Main tick ────────────────────────────────────────────────────
  function tick(timestamp) {
    if (!running) return;

    if (!lastTick) lastTick = timestamp;
    const rawDt = Math.min(timestamp - lastTick, 100);
    const dt = rawDt * speed;
    lastTick = timestamp;
    simTime += dt;

    // 1. Audio capture fills shared buffer
    const captureRate = INPUT_RATE * (dt / 1000) * 0.3;
    sharedBufferLevel = Math.min(sharedBufferLevel + captureRate, SHARED_BUFFER_MAX);

    setStageActive(stages.device, true);
    setConnActive(conns.deviceBuffer, true);
    wavePhase += dt * 0.3;
    const amp = vadCurrentState === 'speech' ? 0.7 : 0.15;
    waveformInput.setAttribute('points', generateWaveform(amp));

    // Update shared buffer visual
    const bufPct = sharedBufferLevel / SHARED_BUFFER_MAX;
    bufferFill.setAttribute('width', Math.round(bufPct * 167));
    bufferCount.textContent = `${Math.round(sharedBufferLevel)} samples`;

    // 2. Drain shared buffer → resample → VAD
    drainAccum += dt;
    if (drainAccum >= 30 && sharedBufferLevel > 0) {
      const drained = Math.min(sharedBufferLevel, 1440);
      sharedBufferLevel -= drained;
      drainAccum = 0;

      setConnActive(conns.bufferResample, true);
      setStageActive(stages.buffer, true);
      spawnThrottled('buf-rs', conns.bufferResample, '#22d3ee', 400, 0.25);

      // Resample
      const resampledCount = Math.round(drained * (ASR_SAMPLE_RATE / INPUT_RATE));
      setStageActive(stages.resample, true);
      resampleIndicator.classList.add('active');
      setConnActive(conns.resampleVad, true);
      spawnThrottled('rs-vad', conns.resampleVad, '#22d3ee', 500, 0.2);

      // VAD frames
      vadTickAccum += resampledCount;
      while (vadTickAccum >= VAD_FRAME_SIZE) {
        vadTickAccum -= VAD_FRAME_SIZE;
        processVadFrame();
      }

      // ASR check
      processAsr();
    } else {
      setConnActive(conns.bufferResample, sharedBufferLevel > 100);
      resampleIndicator.classList.remove('active');
    }

    // Update inference progress
    if (inferring) {
      const elapsed = simTime - inferStartTime;
      const pct = Math.min(elapsed / inferDuration, 1);
      inferProgress.setAttribute('width', Math.round(132 * pct));
      if (pct >= 1) completeInference();
    }

    updateParticles(dt);
    animFrame = requestAnimationFrame(tick);
  }

  // ─── VAD processing ───────────────────────────────────────────────
  //
  // The real pipeline:
  //   Resampled 16kHz audio → VAD (512-sample frames)
  //     - silence:  frame → ring buffer (overwrites oldest when full)
  //     - speech detected (after min_speech_frames):
  //         ring buffer drains into ASR buffer (pre-speech context)
  //         then ongoing frames → ASR buffer directly
  //     - speech ends (after min_silence_frames):
  //         final frame → ASR buffer, pad + flush, decoder reset
  //
  // There is NO separate "VAD → ASR" path — audio ALWAYS goes through
  // the ring buffer during silence, and the ring buffer drains into
  // the ASR buffer when speech starts.

  function processVadFrame() {
    const targetProb = getTargetProb(simTime);
    vadProb += (targetProb - vadProb) * 0.3;
    vadProb = Math.max(0, Math.min(1, vadProb + (Math.random() - 0.5) * 0.05));

    const isSpeech = vadProb >= 0.5;

    // Probability bar
    vadProbFill.setAttribute('width', Math.round(vadProb * 168));
    vadProbFill.classList.toggle('above', isSpeech);
    setStageActive(stages.vad, true);

    if (vadCurrentState === 'silence') {
      if (isSpeech) {
        speechFrameCount++;
        silenceFrameCount = 0;

        if (speechFrameCount >= MIN_SPEECH_FRAMES) {
          // ── Transition: silence → speech ──
          vadCurrentState = 'speech';
          vadState.textContent = 'SPEECH';
          vadState.setAttribute('class', 'stage-state speech');

          // Drain ring buffer into ASR buffer
          const pre = ringBufferLevel;
          asrBufferLevel += pre;
          ringBufferLevel = 0;

          setConnActive(conns.vadRing, false);
          setConnActive(conns.ringAsr, true);
          setConnActive(conns.vadAsr, true);

          // Burst of particles for the drain
          spawnParticle(conns.ringAsr, '#facc15', 500);
          spawnParticle(conns.ringAsr, '#facc15', 700);
          spawnParticle(conns.ringAsr, '#facc15', 900);

          logEvent('speech_start', `pre-speech: ${pre} samples drained from ring buffer`);
          logEvent('drain', `ring buffer → ASR buffer (${pre} samples)`);

          updateRingVisual();
          updateAsrVisual();
          consecutiveEmpty = 0;
        } else {
          // Pending speech — still buffer in ring (matches Rust)
          ringBufferLevel = Math.min(ringBufferLevel + VAD_FRAME_SIZE, PRE_SPEECH_CAPACITY);
          setConnActive(conns.vadRing, true);
          updateRingVisual();
        }
      } else {
        speechFrameCount = 0;
        silenceFrameCount++;

        // Silence: frame → ring buffer
        ringBufferLevel = Math.min(ringBufferLevel + VAD_FRAME_SIZE, PRE_SPEECH_CAPACITY);
        setConnActive(conns.vadRing, true);
        setConnActive(conns.vadAsr, false);
        setConnActive(conns.ringAsr, false);
        spawnThrottled('vad-ring', conns.vadRing, '#facc15', 500, 0.3);
        updateRingVisual();
      }
    } else {
      // In speech state
      if (isSpeech) {
        speechFrameCount++;
        silenceFrameCount = 0;
        // Frame → ASR buffer directly
        asrBufferLevel += VAD_FRAME_SIZE;
        setConnActive(conns.vadAsr, true);
        spawnThrottled('vad-asr', conns.vadAsr, '#34d399', 500, 0.15);
        updateAsrVisual();
      } else {
        silenceFrameCount++;
        speechFrameCount = 0;
        // Brief pause — still treat as speech (audio → ASR buffer)
        asrBufferLevel += VAD_FRAME_SIZE;

        if (silenceFrameCount >= MIN_SILENCE_FRAMES) {
          // ── Transition: speech → silence ──
          vadCurrentState = 'silence';
          vadState.textContent = 'SILENCE';
          vadState.setAttribute('class', 'stage-state');

          // Pad sub-chunk and flush
          if (asrBufferLevel > 0 && asrBufferLevel < CHUNK_SIZE) {
            asrBufferLevel = CHUNK_SIZE;
          }

          setConnActive(conns.vadAsr, false);
          setConnActive(conns.ringAsr, false);
          setConnActive(conns.vadRing, true);

          logEvent('speech_end', `consecutive_empty: ${consecutiveEmpty}`);
          showReset('END');
          consecutiveEmpty = 0;
        }
        updateAsrVisual();
      }
    }
  }

  // ─── ASR processing ───────────────────────────────────────────────
  function processAsr() {
    if (inferring) return;
    if (asrBufferLevel < CHUNK_SIZE) return;

    asrBufferLevel -= CHUNK_SIZE;
    inferring = true;
    inferStartTime = simTime;
    inferDuration = (20 + Math.random() * 60) / speed;

    setStageActive(stages.nemotron, true);
    setConnActive(conns.asrNemotron, true);
    nemotronStatus.textContent = 'INFERRING';
    nemotronStatus.setAttribute('class', 'stage-state inferring');
    spawnParticle(conns.asrNemotron, '#a78bfa', 400);
    setConnActive(conns.nemotronDiag, true);
    updateAsrVisual();
  }

  function completeInference() {
    inferring = false;
    const inferMs = Math.round(inferDuration * speed);
    nemotronTiming.textContent = `${inferMs}ms`;
    inferProgress.setAttribute('width', '0');
    setConnActive(conns.asrNemotron, false);
    nemotronStatus.textContent = 'IDLE';
    nemotronStatus.setAttribute('class', 'stage-state');
    setStageActive(stages.nemotron, false);
    setConnActive(conns.nemotronDiag, false);

    const producesEmpty = scenario === 'stuck' || scenario === 'silence' || Math.random() < 0.1;

    if (producesEmpty && vadCurrentState === 'speech') {
      consecutiveEmpty++;
      emptyCountEl.textContent = `empty: ${consecutiveEmpty}/${EMPTY_RESET_THRESHOLD}`;
      logEvent('empty_chunk', `consecutive: ${consecutiveEmpty}/${EMPTY_RESET_THRESHOLD}`);

      if (consecutiveEmpty >= EMPTY_RESET_THRESHOLD) {
        showReset('MID-SPEECH');
        logEvent('reset', `mid-speech reset after ${EMPTY_RESET_THRESHOLD} empty chunks`);
        consecutiveEmpty = 0;
        emptyCountEl.textContent = '';
      }
    } else if (!producesEmpty) {
      consecutiveEmpty = 0;
      emptyCountEl.textContent = '';

      const text = PHRASES[phraseIndex % PHRASES.length];
      phraseIndex++;
      outputText.textContent = text;
      setStageActive(stages.output, true);
      setConnActive(conns.nemotronOutput, true);
      spawnParticle(conns.nemotronOutput, '#6ee7b7', 400);

      logEvent('transcribe', `"${text.substring(0, 40)}" (${inferMs}ms)`);

      if (endsWithSentencePunctuation(text)) {
        showReset('PUNCTUATION');
        logEvent('punctuation', `reset after: "${text.slice(-1)}"`);
      }

      safeTimeout(() => {
        if (!running) return;
        setStageActive(stages.output, false);
        setConnActive(conns.nemotronOutput, false);
      }, 800 / speed);
    } else {
      logEvent('silence', 'no speech to transcribe');
    }
  }

  // ─── Decoder reset animation ──────────────────────────────────────
  function showReset(type) {
    const txt = $('reset-text');
    txt.textContent = type + ' RESET';
    resetLabel.setAttribute('visibility', 'visible');
    setConnActive(conns.resetLoop, true);

    safeTimeout(() => {
      resetLabel.setAttribute('visibility', 'hidden');
      setConnActive(conns.resetLoop, false);
    }, 1200 / speed);
  }

  // ─── Punctuation check (mirrors Rust) ─────────────────────────────
  function endsWithSentencePunctuation(text) {
    const t = text.trim();
    if (!t) return false;
    const last = t[t.length - 1];
    if (last === '?' || last === '!') return true;
    if (last === '.') {
      if (t.endsWith('...')) return false;
      const before = t.slice(0, -1).trim();
      if (before && /\d$/.test(before)) return false;
      return true;
    }
    return false;
  }

  // ─── Visual updates ───────────────────────────────────────────────
  function updateRingVisual() {
    const pct = ringBufferLevel / PRE_SPEECH_CAPACITY;
    ringFill.setAttribute('width', Math.round(pct * 158));
    ringCount.textContent = `${ringBufferLevel} / ${PRE_SPEECH_CAPACITY}`;
    ringPct.textContent = `${Math.round(pct * 100)}%`;
    setStageActive(stages.ring, ringBufferLevel > 0);
  }

  function updateAsrVisual() {
    const pct = Math.min(asrBufferLevel / CHUNK_SIZE, 1);
    asrFill.setAttribute('width', Math.round(pct * 112));
    asrCount.textContent = `${asrBufferLevel} / ${CHUNK_SIZE}`;
    setStageActive(stages.asrBuffer, asrBufferLevel > 0);
  }

  // ─── Full reset ───────────────────────────────────────────────────
  function fullReset() {
    simTime = 0;
    diagEventCount = 0;
    sharedBufferLevel = 0;
    ringBufferLevel = 0;
    asrBufferLevel = 0;
    vadCurrentState = 'silence';
    vadProb = 0;
    speechFrameCount = 0;
    silenceFrameCount = 0;
    inferring = false;
    consecutiveEmpty = 0;
    phraseIndex = 0;
    lastTick = 0;
    vadTickAccum = 0;
    drainAccum = 0;

    // Clear pending timeouts
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts = [];

    // Reset all visuals
    bufferFill.setAttribute('width', '0');
    bufferCount.textContent = '0 samples';
    vadState.textContent = 'SILENCE';
    vadState.setAttribute('class', 'stage-state');
    vadProbFill.setAttribute('width', '0');
    ringFill.setAttribute('width', '0');
    ringCount.textContent = `0 / ${PRE_SPEECH_CAPACITY}`;
    ringPct.textContent = '0%';
    asrFill.setAttribute('width', '0');
    asrCount.textContent = `0 / ${CHUNK_SIZE}`;
    nemotronStatus.textContent = 'IDLE';
    nemotronStatus.setAttribute('class', 'stage-state');
    nemotronTiming.textContent = '0ms';
    inferProgress.setAttribute('width', '0');
    emptyCountEl.textContent = '';
    outputText.textContent = '';
    resetLabel.setAttribute('visibility', 'hidden');

    // Clear all connection and stage highlights
    Object.values(conns).forEach(c => { if (c) c.classList.remove('active'); });
    Object.values(stages).forEach(s => { if (s) s.classList.remove('active'); });

    clearParticles();
    Object.keys(spawnTimers).forEach(k => delete spawnTimers[k]);
    eventLog.innerHTML = '';
  }

  // ─── Controls ─────────────────────────────────────────────────────
  btnStart.addEventListener('click', () => {
    fullReset();
    running = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    logEvent('session', 'Simulation started');
    animFrame = requestAnimationFrame(tick);
  });

  btnStop.addEventListener('click', () => {
    running = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    if (animFrame) cancelAnimationFrame(animFrame);

    // Clear all active animations immediately
    Object.values(conns).forEach(c => { if (c) c.classList.remove('active'); });
    Object.values(stages).forEach(s => { if (s) s.classList.remove('active'); });
    clearParticles();
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts = [];

    logEvent('session', 'Simulation stopped');
  });

  speedSlider.addEventListener('input', () => {
    speed = parseFloat(speedSlider.value);
    speedLabel.textContent = speed + 'x';
  });

  scenarioSelect.addEventListener('change', () => {
    scenario = scenarioSelect.value;
    logEvent('scenario', `Switched to: ${scenario}`);
  });

})();
