/* 402 CLAIM TERMINAL — static demo. Whole ceremony runs client-side. Nothing is real. */
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var bootEl = document.getElementById('boot');
  var stepsEl = document.getElementById('steps');
  var words = [];

  function hex(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
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

  /* pixel brand mark: ring + 402>_ */
  var BRAND =
    '<div class="brand">' +
    '<svg class="px-logo" viewBox="0 0 24 24" shape-rendering="crispEdges">' +
    '<rect x="8" y="2" width="8" height="2" fill="#fff"/>' +
    '<rect x="4" y="4" width="4" height="2" fill="#fff"/><rect x="16" y="4" width="4" height="2" fill="#fff"/>' +
    '<rect x="2" y="8" width="2" height="8" fill="#fff"/><rect x="20" y="8" width="2" height="8" fill="#fff"/>' +
    '<rect x="4" y="16" width="4" height="2" fill="#fff"/><rect x="16" y="16" width="4" height="2" fill="#fff"/>' +
    '<rect x="8" y="20" width="8" height="2" fill="#fff"/>' +
    '<rect x="8" y="9" width="2" height="2" fill="#fff"/><rect x="10" y="11" width="2" height="2" fill="#fff"/>' +
    '<rect x="8" y="13" width="2" height="2" fill="#fff"/><rect x="13" y="13" width="4" height="2" fill="#fff"/>' +
    '</svg>' +
    '<div class="brand-text">402<span class="promptmark">&gt;<span class="us">_</span></span></div>' +
    '</div>';
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

  /* pixel icons, hand-drawn */
  var ICONS = {
    lock: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="6" y="2" width="4" height="2" fill="#fff"/><rect x="4" y="4" width="2" height="3" fill="#fff"/>' +
      '<rect x="10" y="4" width="2" height="3" fill="#fff"/><rect x="3" y="7" width="10" height="7" fill="#fff"/>' +
      '<rect x="7" y="9" width="2" height="3" fill="#000"/></svg>',
    wallet: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="1" y="4" width="14" height="9" fill="#fff"/><rect x="1" y="4" width="14" height="2" fill="#000"/>' +
      '<rect x="10" y="8" width="4" height="3" fill="#000"/><rect x="11" y="9" width="2" height="1" fill="#fff"/></svg>',
    check: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="2" y="8" width="2" height="2" fill="#fff"/><rect x="4" y="10" width="2" height="2" fill="#fff"/>' +
      '<rect x="6" y="12" width="2" height="2" fill="#fff"/><rect x="8" y="10" width="2" height="2" fill="#fff"/>' +
      '<rect x="10" y="8" width="2" height="2" fill="#fff"/><rect x="12" y="6" width="2" height="2" fill="#fff"/>' +
      '<rect x="12" y="4" width="2" height="2" fill="#fff"/></svg>',
    key: '<svg class="px-icon" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
      '<rect x="2" y="1" width="12" height="2" fill="#fff"/><rect x="4" y="3" width="8" height="10" fill="#fff"/>' +
      '<rect x="6" y="5" width="4" height="6" fill="#000"/><rect x="4" y="13" width="8" height="2" fill="#fff"/></svg>',
  };

  /* ---------- step 00: connect your agent (front door) ---------- */
  var DEMO_MCP_URL = 'https://mcp.402.example/taap'; // .example = illustrative, not real

  function copyText(t, btn) {
    var label = btn.textContent;
    function done(l) { btn.textContent = l; setTimeout(function () { btn.textContent = label; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { done('COPIED'); }, function () { done('COPY FAILED'); });
    } else { done('COPY FAILED'); }
  }

  function renderOnboarding() {
    stage.innerHTML =
      BRAND +
      '<h2 class="center">STEP 00 — CONNECT YOUR AGENT</h2>' +
      '<p class="center">Your agent needs the trading tools before it can make you a wallet.<br>' +
      '<span class="dim">Plug this in once. Takes 30 seconds.</span></p>' +
      '<p class="dim small">MCP SERVER URL <span class="dim">(example)</span></p>' +
      '<div class="address-box">' + escapeHtml(DEMO_MCP_URL) + '</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn small" id="copyurl">Copy URL</button></div>' +
      '<hr class="hr-px">' +
      '<p><span class="dim">HOW:</span><br><br>' +
      '01 — OPEN YOUR Muse APP → SETTINGS → CONNECTORS<br>' +
      '02 — ADD MCP SERVER → PASTE THE URL<br>' +
      '03 — COME BACK HERE</p>' +
      '<p class="center">→ THAT\'S IT. <span class="dim">YOUR AGENT TAKES IT FROM HERE.</span></p>' +
      '<hr class="hr-px">' +
      '<p><span class="dim">WHAT HAPPENS NEXT:</span><br><br>' +
      '→ YOUR AGENT PROVISIONS YOUR WALLET — ON ITS OWN, NOTHING TO TYPE<br>' +
      '→ IT HANDS YOU A <u>CLAIM LINK</u>, RIGHT IN CHAT<br>' +
      '→ THE LINK OPENS THE CEREMONY: PROVE IT\'S YOU,<br>' +
      '&nbsp;&nbsp;&nbsp;BACK UP 12 WORDS, GET YOUR DEPOSIT ADDRESS<br>' +
      '→ FUND IT. THE DEPOSIT IS THE SIGNUP.</p>' +
      '<p class="dim small center">The agent can trade. Only you can withdraw.</p>' +
      '<hr class="hr-px">' +
      '<p class="dim small center">DEMO SHORTCUT — SKIP THE AGENT:</p>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="simulate">▸ My agent sent me a claim link</button></div>';
    document.getElementById('copyurl').addEventListener('click', function () {
      copyText(DEMO_MCP_URL, this);
    });
    document.getElementById('simulate').addEventListener('click', function () {
      boot(renderIdentity);
    });
  }

  function renderLanding() {
    renderOnboarding();
  }

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
      backRow() +
      ICONS.lock +
      '<h2 class="center">STEP 01 — PROVE IT\'S YOU</h2>' +
      '<p>This wallet gets <u>one</u> owner. Press the button, then approve with your face, finger, or security key.</p>' +
      '<p class="dim">The agent cannot do this part. It has no fingers. The link alone is worthless without you.</p>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="scan">▸ Start scan</button></div>' +
      '<div id="msg" class="mt"></div>';
    wireBack(renderLanding);
    document.getElementById('scan').addEventListener('click', doPasskey);
  }

  function doPasskey() {
    var btn = document.getElementById('scan');
    var msg = document.getElementById('msg');
    btn.disabled = true;
    btn.textContent = 'WAITING FOR YOUR DEVICE…';
    var challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    var userId = new Uint8Array(16);
    crypto.getRandomValues(userId);
    var publicKey = {
      challenge: challenge,
      rp: { name: '402 demo', id: location.hostname },
      user: { id: userId, name: 'demo@402', displayName: '402 demo owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
      attestation: 'none',
    };
    navigator.credentials.create({ publicKey: publicKey }).then(function (cred) {
      if (!cred) throw new Error('no credential returned');
      renderExport();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '▸ Start scan';
      msg.innerHTML = errBox(e.name ? (e.name + ': ' + (e.message || 'scan failed')) : 'scan failed') +
        '<div class="btn-row" style="justify-content:center">' +
        '<button class="btn" id="demopass">Use demo passkey instead</button></div>';
      document.getElementById('demopass').addEventListener('click', renderExport);
    });
  }

  /* ---------- step 2: backup ---------- */
  function renderExport() {
    setSteps(2);
    stage.innerHTML =
      ICONS.check +
      '<h2 class="center">IDENTITY LOCKED</h2>' +
      '<p class="center dim">Fetching your recovery words. Eyes only.</p>' +
      '<div class="center"><span class="cursor"></span></div>';
    setTimeout(function () {
      if (!words.length) {
        words = [];
        var pool = WORDS.slice();
        for (var i = 0; i < 12; i++) {
          words.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
      }
      renderWords();
    }, 700);
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
    var btn = document.getElementById('wrote');
    btn.disabled = true;
    setTimeout(function () { btn.disabled = false; }, words.length * 80 + 400);
    btn.addEventListener('click', renderQuiz);
  }

  function renderQuiz() {
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
      return '<div class="word quiz" data-i="' + o.i + '"><span class="n">' +
        String(o.i + 1).padStart(2, '0') + '</span>' + escapeHtml(o.w) + '</div>';
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
    wireBack(renderWords);
    prompt();
    stage.querySelectorAll('.word.quiz').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = parseInt(el.getAttribute('data-i'), 10);
        if (i === order[pos]) {
          el.classList.add('picked');
          pos++;
          if (pos >= order.length) { renderArmed(); }
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

  /* ---------- step 3: wallet ---------- */
  function renderArmed() {
    setSteps(3);
    var address = '0x' + hex(20);
    stage.innerHTML =
      backRow() +
      ICONS.wallet +
      '<div class="armed">WALLET ARMED</div>' +
      '<p class="center">Backup sealed. This wallet is yours now.</p>' +
      '<div class="address-box">' + escapeHtml(address) + '</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn" id="copy">Copy address</button></div>' +
      '<hr class="hr-px">' +
      '<p class="center">FUND IT TO START TRADING.<br><span class="dim">The agent can trade. Only you can withdraw.</span></p>' +
      '<p class="dim small center">demo wallet — do not send real funds anywhere near it</p>';
    wireBack(renderQuiz);
    document.getElementById('copy').addEventListener('click', function () {
      var btn = this;
      function done(t) { btn.textContent = t; setTimeout(function () { btn.textContent = 'Copy address'; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(function () { done('COPIED'); }, function () { done('COPY FAILED'); });
      } else { done('COPY FAILED'); }
    });
  }

  /* ---------- go ---------- */
  renderLanding();
})();
