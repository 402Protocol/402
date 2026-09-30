/* 402 CLAIM TERMINAL — ceremony logic. No frameworks, no build step. */
(function () {
  'use strict';

  var token = location.pathname.split('/').filter(Boolean).pop();
  var stage = document.getElementById('stage');
  var bootEl = document.getElementById('boot');
  var stepsEl = document.getElementById('steps');

  function b64ToBytes(s) {
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); });
  }
  function bytesToB64(bytes) {
    var arr = new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: token }, body || {})),
    }).then(function (r) { return r.json(); });
  }
  function setSteps(n) {
    stepsEl.classList.remove('hidden');
    var blocks = stepsEl.querySelectorAll('.step-block');
    blocks.forEach(function (b) {
      var i = parseInt(b.getAttribute('data-step'), 10);
      b.classList.toggle('active', i === n);
      b.classList.toggle('done', i < n);
    });
  }
  function errBox(msg) {
    return '<div class="warn">ERROR: ' + escapeHtml(msg) + '</div>';
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* one-step-back button; fn re-renders the previous screen */
  function backRow() {
    return '<div class="back-row"><button class="btn ghost small" id="backbtn">◂ BACK</button></div>';
  }
  function wireBack(fn) {
    var b = document.getElementById('backbtn');
    if (b) b.addEventListener('click', fn);
  }

  /* pixel icons, hand-drawn */
  var ICONS = {
    lock: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="6" y="2" width="4" height="2" fill="#fff"/><rect x="4" y="4" width="2" height="3" fill="#fff"/>' +
      '<rect x="10" y="4" width="2" height="3" fill="#fff"/><rect x="3" y="7" width="10" height="7" fill="#fff"/>' +
      '<rect x="7" y="9" width="2" height="3" fill="#000"/></svg>',
    scroll: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="3" y="1" width="10" height="14" fill="#fff"/><rect x="5" y="4" width="6" height="1" fill="#000"/>' +
      '<rect x="5" y="7" width="6" height="1" fill="#000"/><rect x="5" y="10" width="4" height="1" fill="#000"/></svg>',
    wallet: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="1" y="4" width="14" height="9" fill="#fff"/><rect x="1" y="4" width="14" height="2" fill="#000"/>' +
      '<rect x="10" y="8" width="4" height="3" fill="#000"/><rect x="11" y="9" width="2" height="1" fill="#fff"/></svg>',
    check: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="2" y="8" width="2" height="2" fill="#fff"/><rect x="4" y="10" width="2" height="2" fill="#fff"/>' +
      '<rect x="6" y="12" width="2" height="2" fill="#fff"/><rect x="8" y="10" width="2" height="2" fill="#fff"/>' +
      '<rect x="10" y="8" width="2" height="2" fill="#fff"/><rect x="12" y="6" width="2" height="2" fill="#fff"/>' +
      '<rect x="12" y="4" width="2" height="2" fill="#fff"/></svg>',
  };

  /* ---------- boot ---------- */
  var bootLines = [
    '402 SECURE CLAIM TERMINAL v0.1',
    '> VERIFYING CLAIM KEY ............ <span class="ok">OK</span>',
    '> ESTABLISHING SECURE CHANNEL .... <span class="ok">OK</span>',
    '> AWAITING OPERATOR <span class="cursor"></span>',
  ];
  function boot(done) {
    var li = 0, ci = 0, html = '';
    var plain = bootLines.map(function (l) { return l.replace(/<[^>]+>/g, ''); });
    function tick() {
      if (li >= bootLines.length) { done(); return; }
      // reveal progressively: strip tags for typing, then swap in full line
      ci++;
      var target = plain[li];
      if (ci >= target.length) {
        html += bootLines[li] + '<br>';
        bootEl.innerHTML = html;
        li++; ci = 0;
        setTimeout(tick, 220);
      } else {
        bootEl.innerHTML = html + escapeHtml(target.slice(0, ci)) + '<span class="cursor"></span>';
        setTimeout(tick, 14);
      }
    }
    tick();
  }

  /* ---------- step 1: identity ---------- */
  function renderIdentity() {
    setSteps(1);
    stage.innerHTML =
      ICONS.lock +
      '<h2 class="center">STEP 01 — PROVE IT\'S YOU</h2>' +
      '<p>This wallet gets <u>one</u> owner. Press the button, then approve with your face, finger, or security key.</p>' +
      '<p class="dim">The agent cannot do this part. It has no fingers. The link alone is worthless without you.</p>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="scan">▸ Start scan</button></div>' +
      '<div id="msg" class="mt"></div>';
    document.getElementById('scan').addEventListener('click', doPasskey);
  }

  function doPasskey() {
    var btn = document.getElementById('scan');
    var msg = document.getElementById('msg');
    btn.disabled = true;
    btn.textContent = 'WAITING FOR YOUR DEVICE…';
    api('/api/claim/passkey/options').then(function (o) {
      if (!o.ok) throw new Error(o.error);
      var opts = o.options;
      var publicKey = {
        challenge: b64ToBytes(opts.challenge),
        rp: opts.rp,
        user: {
          id: b64ToBytes(opts.user.id),
          name: opts.user.name,
          displayName: opts.user.displayName,
        },
        pubKeyCredParams: opts.pubKeyCredParams,
        authenticatorSelection: opts.authenticatorSelection,
        timeout: opts.timeout,
        attestation: opts.attestation,
      };
      return navigator.credentials.create({ publicKey: publicKey });
    }).then(function (cred) {
      if (!cred) throw new Error('no credential returned');
      var resp = cred.response;
      return api('/api/claim/passkey/verify', {
        attestation: {
          credentialId: bytesToB64(cred.rawId),
          clientDataJson: bytesToB64(resp.clientDataJSON),
          attestationObject: bytesToB64(resp.attestationObject),
          transports: resp.getTransports ? resp.getTransports() : [],
        },
      });
    }).then(function (v) {
      if (!v.ok) throw new Error(v.error);
      renderExport();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '▸ Start scan';
      msg.innerHTML = errBox(e.message || e.name || 'scan failed') +
        '<p class="dim small">Tip: this needs HTTPS or localhost, and a device with biometrics or a security key.</p>';
    });
  }

  /* ---------- step 2: backup ---------- */
  var words = [];

  function renderExport() {
    setSteps(2);
    stage.innerHTML =
      ICONS.check +
      '<h2 class="center">IDENTITY LOCKED</h2>' +
      '<p class="center dim">Fetching your recovery words. Eyes only.</p>' +
      '<div class="center"><span class="cursor"></span></div>';
    api('/api/claim/export').then(function (r) {
      if (!r.ok) throw new Error(r.error);
      words = r.words;
      renderWords();
    }).catch(function (e) {
      stage.innerHTML = errBox(e.message);
    });
  }

  function renderWords() {
    var grid = words.map(function (w, i) {
      return '<div class="word" style="animation-delay:' + (i * 0.08) + 's"><span class="n">' +
        String(i + 1).padStart(2, '0') + '</span>' + escapeHtml(w) + '</div>';
    }).join('');
    stage.innerHTML =
      backRow() +
      '<h2 class="center">STEP 02 — BACK UP OR CRY LATER</h2>' +
      '<div class="warn">12 WORDS. THEY APPEAR <u>ONCE</u>, ON <u>THIS SCREEN ONLY</u>.<br>' +
      'WRITE THEM ON PAPER. DO NOT SCREENSHOT. DO NOT REFRESH.<br>' +
      'LOSE THEM = LOSE THE WALLET. NO SUPPORT TICKET FIXES THAT.</div>' +
      '<div class="words">' + grid + '</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="wrote">I wrote them down</button></div>';
    wireBack(renderIdentity);
    // reveal the button only after the last word pops in
    var btn = document.getElementById('wrote');
    btn.disabled = true;
    setTimeout(function () { btn.disabled = false; }, words.length * 80 + 400);
    btn.addEventListener('click', renderQuiz);
  }

  function renderQuiz() {
    // pick 3 positions, ask in order
    var idx = [];
    while (idx.length < 3) {
      var n = Math.floor(Math.random() * 12);
      if (idx.indexOf(n) === -1) idx.push(n);
    }
    var order = idx.slice();
    var shuffled = words.map(function (w, i) { return { w: w, i: i }; });
    for (var s = shuffled.length - 1; s > 0; s--) {
      var j = Math.floor(Math.random() * (s + 1));
      var t = shuffled[s]; shuffled[s] = shuffled[j]; shuffled[j] = t;
    }
    var grid = shuffled.map(function (o) {
      return '<div class="word quiz" data-i="' + o.i + '">' + escapeHtml(o.w) + '</div>';
    }).join('');
    var pos = 0;
    function prompt() {
      var p = document.getElementById('quizprompt');
      if (p) p.innerHTML = 'TAP WORD <u>#' + (order[pos] + 1) + '</u> <span class="dim">(' + (pos + 1) + '/3)</span>';
    }
    stage.innerHTML =
      backRow() +
      '<h2 class="center">PROVE IT</h2>' +
      '<p class="center" id="quizprompt"></p>' +
      '<div class="words">' + grid + '</div>' +
      '<p class="dim small center">Wrong tap resets. This is the part that saves you someday.</p>';
    wireBack(renderExport);
    prompt();
    stage.querySelectorAll('.word.quiz').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = parseInt(el.getAttribute('data-i'), 10);
        if (i === order[pos]) {
          el.classList.add('picked');
          pos++;
          if (pos >= order.length) { confirmBackup(); }
          else prompt();
        } else {
          el.classList.add('wrong');
          setTimeout(function () {
            stage.querySelectorAll('.word.quiz').forEach(function (x) { x.classList.remove('picked', 'wrong'); });
            pos = 0;
            prompt();
          }, 450);
        }
      });
    });
  }

  function confirmBackup() {
    stage.innerHTML = '<p class="center">SEALING BACKUP… <span class="cursor"></span></p>';
    api('/api/claim/backup-confirm', { confirmed: true }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      renderArmed(r.deposit_address);
    }).catch(function (e) {
      stage.innerHTML = errBox(e.message);
    });
  }

  /* ---------- step 3: wallet ---------- */
  function renderArmed(address) {
    setSteps(3);
    stage.innerHTML =
      backRow() +
      ICONS.wallet +
      '<div class="armed">WALLET ARMED</div>' +
      '<p class="center">Backup sealed. This wallet is yours now.</p>' +
      '<div class="address-box">' + escapeHtml(address) + '</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="copy">Copy address</button></div>' +
      '<hr class="hr-px">' +
      '<p class="center">FUND IT TO START TRADING.<br><span class="dim">The agent can trade. Only you can withdraw.</span></p>';
    wireBack(renderQuiz);
    document.getElementById('copy').addEventListener('click', function () {
      var btn = this;
      function done(t) { btn.textContent = t; setTimeout(function () { btn.textContent = 'Copy address'; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(function () { done('COPIED'); }, function () { done('COPY FAILED'); });
      } else { done('COPY FAILED'); }
    });
  }

  function renderClaimed() {
    setSteps(3);
    stage.innerHTML =
      ICONS.check +
      '<h2 class="center">ALREADY CLAIMED</h2>' +
      '<p class="center dim">This claim link was already used. The wallet is armed and out there.<br>Need a new one? Ask your agent.</p>';
  }

  /* ---------- go ---------- */
  api('/api/claim/validate').then(function (v) {
    if (!v.ok) { location.reload(); return; } // server 404s bad links; this is a backstop
    boot(function () {
      if (v.status === 'complete') renderClaimed();
      else if (v.status === 'issued') renderIdentity();
      else if (v.status === 'passkey_registered') renderExport();
      else renderIdentity(); // exported/backup_confirmed without words: restart ceremony safely
    });
  }).catch(function () {
    bootEl.innerHTML = errBox('cannot reach the claim server');
  });
})();
