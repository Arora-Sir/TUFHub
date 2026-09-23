/**
 * TUFHub Page Interceptor (MAIN World)
 * Freezes each submission at the moment of submit intent, then matches judge verdicts back to that frozen snapshot.
 * Author: Mohit Arora (@Arora-Sir)
 */




(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  const TUFHUB_VERSION = process.env.TUFHUB_VERSION || '0.0.0';

  // Safety cap: a pending submission stays matchable until its verdict arrives or this timeout trips.
  // Extended 10-minute window accommodates cold judge environments without dropping verdicts.
  const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
  // A submit request this soon after a click belongs to that click's submission instead of starting a new one.
  const INTENT_REQUEST_WINDOW_MS = 30 * 1000;
  // Back-to-back submissions from different editor tabs each keep their own snapshot. Beyond this many, the oldest is dropped.
  const MAX_PENDING = 3;
  // Dispatched submission ids are remembered this long so repeated poll responses for one submission never sync twice.
  const DISPATCHED_MEMORY_MS = 2 * 60 * 1000;
  const PENDING_KEY = '__tufhub_pending_submissions__';
  const LEGACY_ARM_KEY = '__tufhub_arm_state__';

  // Ids under these keys are specific enough to reject a verdict that carries a different value. Generic keys such as id can only confirm a match.
  const SPECIFIC_ID_KEYS = ['submission_id', 'submissionId', 'submission_token'];
  const SUBMISSION_ID_KEYS = SPECIFIC_ID_KEYS.concat(['token', 'id', '_id']);
  // TUF's own POST /judge/submit body sends the solution as 'usercode' (confirmed live alongside problem_id, language, mode, slug).
  const REQUEST_CODE_KEYS = ['usercode', 'code', 'source_code', 'sourceCode', 'solution', 'userCode', 'user_code', 'src', 'program'];
  const REQUEST_LANGUAGE_KEYS = ['language', 'lang', 'languageId', 'language_id', 'languageName'];
  const VERDICT_CODE_KEYS = ['code', 'solution', 'source_code', 'sourceCode'];

  // NOTE: TUF stops polling a submission's verdict as soon as the user submits again, so the earlier submission's result never crosses the network on its own (confirmed live).
  // NOTE: An older pending submission whose id has gone unpolled this long is polled by the interceptor itself, with the page's own check-submit request shape.
  const ORPHAN_IDLE_MS = 3000;
  const ORPHAN_POLL_MS = 2000;
  const ORPHAN_MAX_POLLS = 45;
  // Verdict strings that mean the judge is still working, so a self-polled submission keeps waiting instead of being discarded.
  const IN_PROGRESS_VERDICT = /PEND|QUEUE|RUNNING|PROCESS|JUDG|WAIT|PROGRESS|EVALUAT|COMPILING|SUBMITTED/;

  console.log(`%c[TUFHub Interceptor v${TUFHUB_VERSION}] 🚀 MAIN world fetch/XHR hook active.`, 'color: #22c55e; font-weight: bold; font-size: 13px;');

  // Liveness marker on documentElement readable from isolated world content scripts across re-renders.
  function markAlive() {
    try {
      if (document.documentElement.getAttribute('data-tufhub-interceptor') !== TUFHUB_VERSION) {
        document.documentElement.setAttribute('data-tufhub-interceptor', TUFHUB_VERSION);
      }
    } catch (e) {}
  }
  markAlive();

  let cachedProblemDescription = '';
  let cachedProblemDescriptionSlug = '';
  let cachedProblemTitle = '';
  let cachedProblemSlug = '';
  let cachedProblemDifficulty = '';
  let cachedProblemDifficultySlug = '';
  let loggedRequestKeys = false;
  let recentlyDispatched = [];
  // The page's last check-submit request (URL and headers), held in memory and not in sessionStorage. Abandoned submissions are polled with it at that same endpoint.
  let pollTemplate = null;
  let orphanTimer = null;
  let latestSubmissionAt = 0;

  // Keyed by track ('dsa', 'sql', ...): slug -> { mainTopic, subTopic }, built from TUF's own syllabus API.
  // NOTE: This backend syllabus tree provides ground truth hierarchy directly from the server.
  // NOTE: Sidebar DOM scraping and title keyword guessing both failed when the site revamp removed the problem-page sidebar.
  let syllabusMaps = {};

  function currentProblemSlug() {
    try {
      const parts = window.location.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    } catch (e) {
      return '';
    }
  }

  // Second URL segment: /practice/<track>/<slug> -> 'dsa' | 'sql' | ...
  function currentTrackKey() {
    try {
      const parts = window.location.pathname.split('/').filter(Boolean);
      return (parts[1] || '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  /**
   * Flattens a syllabus API response tree into slug -> {mainTopic, subTopic}.
   * mainTopic represents the top-level category label.
   * subTopic represents the immediate parent category label, left blank when the problem sits directly under the top level.
   */
  function buildSyllabusMap(syllabusTree) {
    const map = new Map();
    function walk(nodes, categoryChain) {
      for (const node of (nodes || [])) {
        if (node.type === 'problem' && node.slug && categoryChain.length > 0) {
          const mainTopic = categoryChain[0];
          const immediateParent = categoryChain[categoryChain.length - 1];
          map.set(node.slug, { mainTopic, subTopic: immediateParent !== mainTopic ? immediateParent : '' });
        } else if (node.children && node.children.length) {
          walk(node.children, categoryChain.concat(node.label || ''));
        }
      }
    }
    walk(syllabusTree, []);
    return map;
  }

  // The syllabus response names its track (info.key) independently of the URL segment, so an exact miss falls back to a key containing the segment as a whole token.
  function lookupSyllabus(track, slug) {
    if (!track || !slug) return null;
    let map = syllabusMaps[track];
    if (!map) {
      const alias = Object.keys(syllabusMaps).find(key => key.split(/[^a-z0-9]+/).includes(track));
      map = alias ? syllabusMaps[alias] : null;
    }
    return map ? map.get(slug) || null : null;
  }

  // Fallback title derived from URL slug when no h1 exists on the page (such as the Solution tab).
  function titleFromSlug(slug) {
    if (!slug) return '';
    return slug
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * Identifies the active editor tab using ARIA tab semantics (role="tab" and aria-selected).
   * Strips the close button subtree to isolate the clean tab display name.
   * A lone tab renders no close control at all (nothing to close), so it is trusted
   * on its own instead of being filtered away as if it were some unrelated page tab.
   * Returns { label: '', count: 0 } on failure so callers degrade gracefully to solution.<ext>.
   */
  function getActiveTabInfo() {
    try {
      const all = Array.from(document.querySelectorAll('[role="tab"]'));
      if (all.length === 0) return { label: '', count: 0 };

      // The close control can render as a descendant of the tab button or as a sibling inside a shared wrapper, so both are checked to match either shape TUF may use.
      const hasCloseButton = (tab) =>
        !!(tab.querySelector('button[aria-label^="Close "]') ||
           (tab.parentElement && tab.parentElement.querySelector('button[aria-label^="Close "]')));
      const withClose = all.filter(hasCloseButton);
      // Falls back to trusting the whole set only when it is a single element, so an unrelated stray role="tab" elsewhere on the page can never be mistaken for the editor tab.
      const tabs = withClose.length ? withClose : (all.length === 1 ? all : []);
      if (tabs.length === 0) return { label: '', count: 0 };

      const labelOf = (tab) => {
        const contentDiv = tab.children[1] || tab;
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll('button').forEach(b => b.remove());
        return clone.textContent.trim();
      };

      const active = tabs.find(t => t.getAttribute('aria-selected') === 'true');
      const label = labelOf(active || tabs[0]);
      return label ? { label, count: tabs.length } : { label: '', count: 0 };
    } catch (e) {
      return { label: '', count: 0 };
    }
  }

  function diag(stage, reasonCode, detail, persist = true) {
    try {
      console.log(`[TUFHub Interceptor] ${stage}${reasonCode ? ' :: ' + reasonCode : ''}`, detail || '');
    } catch (e) {}
    if (!persist) return;
    try {
      window.dispatchEvent(new CustomEvent('TUFHUB_DIAG', {
        detail: { stage, reasonCode: reasonCode || '', detail: detail == null ? '' : String(detail) }
      }));
    } catch (e) {}
  }

  function newToken() {
    return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // Returns the first non-empty string (or number, when allowed) found under any of the given keys.
  function firstField(obj, keys, allowNumbers = false) {
    if (!isPlainObject(obj)) return '';
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (allowNumbers && typeof value === 'number') return String(value);
    }
    return '';
  }

  // -------------------------------------------------------------
  // Editor, language, and problem metadata readers
  // -------------------------------------------------------------

  /**
   * Picks the editor holding the user's solution when TUF mounts more than one Monaco instance.
   * NOTE: getEditors() is ordered by creation, so index 0 is only reliable while the page mounts a single editor that swaps models per tab.
   * NOTE: Read-only instances (submission viewers, editorial code) are skipped, then focus and visibility decide between the rest.
   */
  function pickActiveEditor(monaco) {
    const editors = monaco.editor.getEditors();
    if (editors.length <= 1) return editors[0] || null;
    const readOnlyOption = monaco.editor.EditorOption ? monaco.editor.EditorOption.readOnly : undefined;
    const isWritable = (ed) => {
      try {
        return !(readOnlyOption !== undefined ? ed.getOption(readOnlyOption) : (ed.getRawOptions && ed.getRawOptions().readOnly));
      } catch (e) {
        return true;
      }
    };
    const isVisible = (ed) => {
      try {
        const node = ed.getDomNode();
        return !!(node && node.isConnected && node.offsetWidth > 0 && node.offsetHeight > 0);
      } catch (e) {
        return false;
      }
    };
    const withModel = editors.filter(ed => ed.getModel && ed.getModel());
    const writable = withModel.filter(isWritable);
    const pool = writable.length ? writable : withModel;
    return pool.find(ed => ed.hasTextFocus && ed.hasTextFocus())
      || pool.find(ed => ed.hasWidgetFocus && ed.hasWidgetFocus())
      || pool.find(isVisible)
      || pool[0]
      || null;
  }

  // Monaco positions line nodes absolutely and recycles them while scrolling, so DOM order is not line order and has to be sorted by offset.
  function readRenderedLines(scope) {
    try {
      const containers = Array.from((scope || document).querySelectorAll('.view-lines'));
      const container = containers.find(c => c.offsetParent !== null) || containers[0];
      if (!container) return '';
      const text = Array.from(container.querySelectorAll('.view-line'))
        .map(el => ({ top: parseFloat(el.style.top) || 0, text: (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ') }))
        .sort((a, b) => a.top - b.top)
        .map(line => line.text)
        .join('\n');
      return text.trim() ? text : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Returns { code, languageId, source } for the editor the user is submitting from.
   * The rendered-lines fallback only sees lines inside the viewport, so it is reported as a separate, degraded source.
   */
  function readActiveEditor() {
    try {
      const monaco = window.monaco;
      if (monaco && monaco.editor) {
        let model = null;
        if (monaco.editor.getEditors) {
          const editor = pickActiveEditor(monaco);
          model = editor ? editor.getModel() : null;
        } else {
          // Older Monaco without getEditors(): a lone model is unambiguous, while several would repeat the creation-order bug.
          const models = monaco.editor.getModels ? monaco.editor.getModels() : [];
          model = models.length === 1 ? models[0] : null;
        }
        const code = model ? model.getValue() : '';
        if (code && code.trim()) {
          const languageId = model.getLanguageId ? model.getLanguageId() : (model.getModeId ? model.getModeId() : '');
          return { code, languageId: languageId || '', source: 'monaco' };
        }
      }
    } catch (e) {}

    const code = readRenderedLines(null);
    return { code, languageId: '', source: code ? 'dom-lines' : '' };
  }

  // Last-resort language guess for when Monaco reports no language id. Returns '' so the category default applies instead of a wrong guess.
  function extractLanguageFromDOM() {
    try {
      const langSelectors = document.querySelectorAll('button, div, span, select');
      for (const el of langSelectors) {
        const txt = (el.innerText || '').trim().toLowerCase();
        if (txt === 'c++' || txt === 'cpp') return 'cpp';
        if (txt === 'java') return 'java';
        if (txt === 'python' || txt === 'python3' || txt === 'py') return 'py';
        if (txt === 'javascript' || txt === 'js') return 'js';
        if (txt === 'typescript' || txt === 'ts') return 'ts';
        if (txt === 'c#' || txt === 'csharp') return 'cs';
        if (txt === 'go' || txt === 'golang') return 'go';
        if (txt === 'rust') return 'rs';
        if (txt === 'sql') return 'sql';
      }
    } catch (e) {}
    return '';
  }

  function extractDescriptionFromDOM() {
    try {
      const h1 = document.querySelector('h1');
      const panel =
        document.querySelector('[data-tuf-ai-selectable="true"]') ||
        document.querySelector('.problem-statement')?.closest('div.overflow-y-auto') ||
        document.querySelector('.problem-statement')?.parentElement?.parentElement ||
        document.querySelector('[class*="problem-statement"]')?.parentElement ||
        // Matches scrollable panel under h1 for revamped site layout where legacy classes are absent.
        (h1 && h1.closest('[class*="scrollable"]'));

      if (panel) {
        const clone = panel.cloneNode(true);
        const removeSelectors = [
          'button',
          'svg',
          '.difficulty-badge',
          '[class*="accordion"]',
          '[class*="hints"]',
          '[class*="sticky"]',
          '[class*="pointer-events-none"]'
        ];
        removeSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));

        const html = clone.innerHTML;
        if (html && html.trim().length > 30) {
          return html;
        }
      }
    } catch (e) {}

    if (cachedProblemDescription && cachedProblemDescriptionSlug === currentProblemSlug() && cachedProblemDescription.length > 20) {
      return cachedProblemDescription;
    }

    return '';
  }

  /**
   * Extracts difficulty tier from the header button group adjacent to the problem title.
   * Scoped to the h1 parent container to avoid matching unrelated account badges on the page.
   * Falls back to the problem API's own difficulty, then 'Unspecified' rather than guessing when tier elements are absent.
   */
  function extractDifficultyFromDOM() {
    try {
      const h1 = document.querySelector('h1');
      const headerButtons = h1 && h1.parentElement ? Array.from(h1.parentElement.querySelectorAll('button')) : [];
      const tierBtn = headerButtons.find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t && t !== 'hints' && !t.startsWith('companies');
      });
      if (tierBtn) return tierBtn.innerText.trim();

      // Kept in case TUF ever reintroduces a literal difficulty class.
      const diffElem = document.querySelector('[class*="difficulty"]');
      if (diffElem) return diffElem.innerText.trim();
    } catch (e) {}
    if (cachedProblemDifficulty && cachedProblemDifficultySlug === currentProblemSlug()) return cachedProblemDifficulty;
    return 'Unspecified';
  }

  // -------------------------------------------------------------
  // Submission snapshots (taken once, at submit intent)
  // -------------------------------------------------------------

  /**
   * Freezes everything a sync needs about the submission, read at the instant of submit intent.
   * NOTE: While the judge runs, TUF switches to the Submissions panel and the user can change editor tabs or pages, so any later read can describe a different tab or a panel with no problem statement.
   * NOTE: Fields that load later (syllabus topic, API title) are filled by this snapshot's own frozen slug and track in refreshSnapshot(), never by the page's current URL.
   */
  function takeSnapshot(token, source) {
    const slug = currentProblemSlug();
    const track = currentTrackKey();
    const tabInfo = getActiveTabInfo();
    const editor = readActiveEditor();
    const h1Elem = document.querySelector('h1');
    const h1Title = h1Elem ? (h1Elem.innerText || '').trim() : '';
    const apiTitleFresh = !!cachedProblemTitle && cachedProblemSlug === slug;
    const syllabusEntry = lookupSyllabus(track, slug);
    return {
      token,
      source,
      at: Date.now(),
      url: window.location.href,
      slug,
      track,
      code: editor.code,
      codeSource: editor.source,
      languageId: editor.languageId,
      requestLanguage: '',
      domLanguage: editor.languageId ? '' : extractLanguageFromDOM(),
      tabLabel: tabInfo.label,
      tabCount: tabInfo.count,
      title: apiTitleFresh ? cachedProblemTitle : (h1Title || titleFromSlug(slug)),
      titleSource: apiTitleFresh ? 'api' : (h1Title ? 'h1' : 'slug'),
      difficulty: extractDifficultyFromDOM(),
      description: extractDescriptionFromDOM(),
      syllabusMainTopic: syllabusEntry ? syllabusEntry.mainTopic : '',
      syllabusSubTopic: syllabusEntry ? syllabusEntry.subTopic : ''
    };
  }

  // Fills fields that may have loaded after intent, keyed strictly by the snapshot's own slug and track.
  function refreshSnapshot(snapshot) {
    const s = Object.assign({}, snapshot);
    if (!s.syllabusMainTopic) {
      const entry = lookupSyllabus(s.track, s.slug);
      if (entry) {
        s.syllabusMainTopic = entry.mainTopic;
        s.syllabusSubTopic = entry.subTopic;
      }
    }
    if (s.titleSource !== 'api' && cachedProblemTitle && cachedProblemSlug === s.slug) {
      s.title = cachedProblemTitle;
      s.titleSource = 'api';
    }
    if ((!s.description || s.description.trim().length <= 30) && cachedProblemDescription.length > 20 && cachedProblemDescriptionSlug === s.slug) {
      s.description = cachedProblemDescription;
    }
    if (/^\s*(unspecified)?\s*$/i.test(s.difficulty || '') && cachedProblemDifficulty && cachedProblemDifficultySlug === s.slug) {
      s.difficulty = cachedProblemDifficulty;
    }
    return s;
  }

  function loadPending() {
    try {
      sessionStorage.removeItem(LEGACY_ARM_KEY);
      const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(p => p && p.snapshot) : [];
    } catch (e) {
      return [];
    }
  }

  // sessionStorage preserves pending submissions across tab discard-and-restore, bfcache, and background freeze.
  let pending = loadPending();

  function savePending() {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch (e) {}
  }

  // Drops expired submissions, and unbound ones whose problem page the user has left, since only a submission id can still match those safely.
  function prunePending() {
    const now = Date.now();
    const slug = currentProblemSlug();
    const kept = pending.filter(p => now - (p.at || 0) <= PENDING_MAX_AGE_MS && (p.slug === slug || !!p.submissionId));
    if (kept.length !== pending.length) {
      diag('DISARMED', 'PRUNED', `${pending.length - kept.length} expired or navigated away`, false);
      pending = kept;
      savePending();
    }
  }

  // Shares the frozen snapshot with content.js so its DOM-watcher backup channel syncs exactly the same data as this channel.
  function dispatchSnapshot(entry) {
    try {
      window.dispatchEvent(new CustomEvent('TUFHUB_SUBMISSION_SNAPSHOT', {
        detail: { token: entry.token, snapshot: entry.snapshot }
      }));
    } catch (e) {}
  }

  function beginSubmission(source, token) {
    markAlive();
    prunePending();
    const snapshot = takeSnapshot(token || newToken(), source);
    const entry = { token: snapshot.token, slug: snapshot.slug, at: snapshot.at, requestAt: 0, submissionId: '', idKey: '', snapshot };
    latestSubmissionAt = Math.max(latestSubmissionAt, entry.at);
    pending.push(entry);
    while (pending.length > MAX_PENDING) pending.shift();
    savePending();
    diag('ARMED', source, `slug=${snapshot.slug} tab=${snapshot.tabLabel}(${snapshot.tabCount}) code=${snapshot.codeSource || 'none'}`);
    dispatchSnapshot(entry);
    return entry;
  }

  // A submit request that failed never reached the judge, so its snapshot must not be matched to a later submission's verdict.
  function discardSubmission(entry, reason) {
    const before = pending.length;
    pending = pending.filter(p => p !== entry);
    if (pending.length !== before) {
      savePending();
      diag('DISARMED', reason, `slug=${entry.slug}`);
    }
  }

  // content.js detects the Submit click or Ctrl+Enter in the capture phase, before the page's own handler reads the editor.
  window.addEventListener('TUFHUB_USER_SUBMIT_CLICKED', (event) => {
    beginSubmission('USER_SUBMIT_CLICK', event && typeof event.detail === 'string' ? event.detail : '');
  });

  function isJudgeSubmitUrl(url) {
    return String(url || '').toLowerCase().includes('/judge/submit');
  }

  // Source code virtually always contains spaces or punctuation, so a lone identifier under a code-like key (a language code, an id) is rejected.
  function looksLikeSource(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length >= 10 && !/^[\w.-]+$/.test(trimmed);
  }

  /**
   * Merges the outgoing submit request's own code and language into the snapshot, since they are exactly what the judge evaluates.
   * Logs only the body's key names (never values) once per page, so a TUF API change stays diagnosable from the popup.
   */
  function applyRequestBody(entry, bodyText) {
    if (typeof bodyText !== 'string' || !bodyText) return false;
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      return false;
    }
    const candidates = [body, body && body.data, body && body.submission, body && body.payload].filter(isPlainObject);
    if (candidates.length === 0) return false;
    if (!loggedRequestKeys) {
      loggedRequestKeys = true;
      diag('SUBMIT_REQUEST', 'BODY_KEYS', candidates.map(c => Object.keys(c).join(',')).join(' | '));
    }
    const code = candidates.map(c => firstField(c, REQUEST_CODE_KEYS)).find(looksLikeSource) || '';
    const language = candidates.map(c => firstField(c, REQUEST_LANGUAGE_KEYS, true)).find(Boolean) || '';
    if (code) {
      entry.snapshot.code = code;
      entry.snapshot.codeSource = 'request';
    }
    if (language) entry.snapshot.requestLanguage = language;
    return !!(code || language);
  }

  // Binds the outgoing submit request to the click that caused it, or snapshots right now when no click was detected (icon-only button, unrecognized shortcut).
  function onJudgeSubmitRequest(bodyText) {
    prunePending();
    const slug = currentProblemSlug();
    const now = Date.now();
    let entry = null;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.slug === slug && !p.requestAt && now - p.at <= INTENT_REQUEST_WINDOW_MS) {
        entry = p;
        break;
      }
    }
    if (!entry) entry = beginSubmission('POST_JUDGE_SUBMIT_REQUEST', '');
    entry.requestAt = now;
    applyRequestBody(entry, bodyText);
    savePending();
    dispatchSnapshot(entry);
    return entry;
  }

  // Runs before the page's request leaves, which is the only moment the submit body (the exact code being judged) can be read.
  function inspectOutgoingRequest(url, method, input, init) {
    try {
      if (method !== 'POST' || !isJudgeSubmitUrl(url)) return null;
      const body = init && init.body;
      const entry = onJudgeSubmitRequest(typeof body === 'string' ? body : '');
      // Request objects expose their body only as a stream, so it is cloned before the page consumes it and merged into this same snapshot once read.
      if (!body && typeof Request !== 'undefined' && input instanceof Request) {
        input.clone().text().then((text) => {
          if (applyRequestBody(entry, text)) {
            savePending();
            dispatchSnapshot(entry);
          }
        }).catch(() => {});
      }
      return entry;
    } catch (e) {
      return null;
    }
  }

  // Walks { status, data } envelopes and returns the first submission id found, preferring specific keys over generic ones.
  function extractSubmissionId(obj) {
    const candidates = [];
    let cursor = obj;
    for (let depth = 0; depth < 3 && isPlainObject(cursor); depth++) {
      candidates.push(cursor);
      if (isPlainObject(cursor.submission)) candidates.push(cursor.submission);
      cursor = cursor.data;
    }
    for (const key of SUBMISSION_ID_KEYS) {
      for (const candidate of candidates) {
        const value = candidate[key];
        if ((typeof value === 'string' && value) || typeof value === 'number') return { key, value: String(value) };
      }
    }
    return null;
  }

  // Records the submission id from the POST /judge/submit response without re-reading the snapshot.
  // NOTE: The user can switch editor tabs during this round trip, so reading the editor on the response would attach the other tab's code and name.
  function confirmSubmission(data, entry) {
    let target = entry && pending.includes(entry) ? entry : null;
    if (!target && !entry) {
      prunePending();
      target = pending.find(p => p.requestAt && !p.submissionId) || null;
      if (!target) {
        // Reached only if the outgoing request slipped past both request hooks, so this late snapshot is the best available.
        target = beginSubmission('POST_JUDGE_SUBMIT_RESPONSE', '');
        target.requestAt = Date.now();
      }
    }
    if (!target) return;
    const idInfo = extractSubmissionId(data);
    if (idInfo) {
      target.submissionId = idInfo.value;
      target.idKey = idInfo.key;
      ensureOrphanWatch();
    }
    savePending();
    diag('CONFIRMED', idInfo ? 'SUBMISSION_ID' : 'NO_SUBMISSION_ID', idInfo ? `${idInfo.key}=${idInfo.value}` : `slug=${target.slug}`);
  }

  // Finds the object carrying a known submission id anywhere in a verdict payload, so a list response matches the right row instead of the first one.
  function findEntryWithId(node, key, id, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) {
        const hit = findEntryWithId(item, key, id, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (node[key] != null && String(node[key]) === id) return node;
    for (const child of [node.data, node.submissions, node.submission, node.result]) {
      const hit = findEntryWithId(child, key, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // Poll endpoints often carry the id in the URL itself. It must appear as a whole path segment or query value, not as an incidental substring.
  function urlMentionsId(urlStr, id) {
    const escaped = String(id).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`[/=]${escaped}(?:[&/?#]|$)`).test(urlStr);
  }

  /**
   * Pairs an accepted verdict with the pending submission it belongs to.
   * Returns { entry, bound } where bound means a submission id proved the pairing, or null when the verdict belongs to some other submission.
   */
  function matchPending(targetObj, urlStr) {
    let rejectedById = false;
    for (const p of pending) {
      if (!p.submissionId) continue;
      if (urlMentionsId(urlStr, p.submissionId)) return { entry: p, bound: true };
      const value = p.idKey ? targetObj[p.idKey] : undefined;
      if (value == null || value === '') continue;
      if (String(value) === p.submissionId) return { entry: p, bound: true };
      if (SPECIFIC_ID_KEYS.includes(p.idKey)) rejectedById = true;
    }
    if (rejectedById) return null;
    // Without a comparable id, the oldest in-flight submission on this page is the one the judge resolves first.
    const slug = currentProblemSlug();
    const onPage = pending.filter(p => p.slug === slug);
    const entry = onPage.find(p => p.requestAt) || onPage[onPage.length - 1] || null;
    return entry ? { entry, bound: false } : null;
  }

  // Only specific id keys are compared here, because a generic id field can hold the problem's id and would wrongly mark the next submission as a repeat.
  function specificIdsOf(obj) {
    if (!isPlainObject(obj)) return [];
    return SPECIFIC_ID_KEYS
      .filter(key => obj[key] != null && obj[key] !== '')
      .map(key => `${key}=${obj[key]}`);
  }

  function wasRecentlyDispatched(targetObj) {
    const now = Date.now();
    recentlyDispatched = recentlyDispatched.filter(r => now - r.at <= DISPATCHED_MEMORY_MS);
    const ids = specificIdsOf(targetObj);
    return ids.length > 0 && recentlyDispatched.some(r => r.ids.some(id => ids.includes(id)));
  }

  function rememberDispatched(entry, targetObj) {
    const ids = specificIdsOf(targetObj);
    if (entry.submissionId && SPECIFIC_ID_KEYS.includes(entry.idKey)) ids.push(`${entry.idKey}=${entry.submissionId}`);
    if (ids.length) recentlyDispatched.push({ ids, at: Date.now() });
  }

  // -------------------------------------------------------------
  // Abandoned-submission polling
  // -------------------------------------------------------------

  // Records which pending submission a check-submit poll was for, so only submissions the page has stopped polling get polled by the interceptor.
  function notePoll(url, urlStr) {
    const now = Date.now();
    pending.forEach((p) => {
      if (p.submissionId && urlMentionsId(urlStr, p.submissionId)) {
        p.lastPolledAt = now;
        p.pollUrl = String(url);
      }
    });
  }

  function rememberPollTemplate(url, via, headers, withCredentials) {
    try {
      pollTemplate = { url: new URL(String(url), window.location.href).toString(), via, headers: headers || {}, withCredentials: !!withCredentials };
    } catch (e) {}
  }

  // Builds the poll URL for an abandoned submission: its own last poll URL when one was seen, otherwise the page's template with this submission's id and slug.
  function orphanPollUrl(p) {
    if (p.pollUrl) return new URL(p.pollUrl, window.location.href).toString();
    if (!pollTemplate) return '';
    const url = new URL(pollTemplate.url);
    const idParam = [p.idKey, 'submission_id', 'submissionId'].find(key => key && url.searchParams.has(key));
    if (!idParam) return '';
    url.searchParams.set(idParam, p.submissionId);
    if (url.searchParams.has('slug')) url.searchParams.set('slug', p.slug);
    if (url.searchParams.has('language') && p.snapshot.requestLanguage) url.searchParams.set('language', p.snapshot.requestLanguage);
    return url.toString();
  }

  // Sends the poll through the page's own (hooked) transport, so the response flows through processPayload exactly like a poll the page made.
  function pollOrphan(p) {
    const url = orphanPollUrl(p);
    if (!url || !pollTemplate) return;
    p.selfPolls = (p.selfPolls || 0) + 1;
    p.lastPolledAt = Date.now();
    if (p.selfPolls === 1) diag('SELF_POLL', 'ABANDONED_BY_PAGE', `slug=${p.slug}`);
    try {
      if (pollTemplate.via === 'xhr') {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = pollTemplate.withCredentials;
        Object.entries(pollTemplate.headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
        xhr.send();
      } else {
        window.fetch(url, { method: 'GET', headers: pollTemplate.headers, credentials: pollTemplate.withCredentials ? 'include' : 'same-origin' }).catch(() => {});
      }
    } catch (e) {}
  }

  function checkOrphans() {
    prunePending();
    if (!pending.some(p => p.submissionId)) {
      clearInterval(orphanTimer);
      orphanTimer = null;
      return;
    }
    const now = Date.now();
    pending.forEach((p) => {
      // Skip the latest submission because the page still polls it (it may already be dispatched and gone from pending). Only superseded submissions are at risk.
      if (!p.submissionId || (p.at || 0) >= latestSubmissionAt) return;
      if ((p.selfPolls || 0) >= ORPHAN_MAX_POLLS) return;
      if (now - (p.lastPolledAt || p.requestAt || p.at) < ORPHAN_IDLE_MS) return;
      pollOrphan(p);
    });
  }

  // TUF's check-submit reports completed: true once judging is over, even with an empty status (seen live for an abandoned submission's expired result).
  function reportsCompleted(data) {
    return [data, data && data.data].some(o => isPlainObject(o) && o.completed === true);
  }

  function selfPolledFor(urlStr) {
    return pending.find(p => p.selfPolls && p.submissionId && urlMentionsId(urlStr, p.submissionId)) || null;
  }

  function ensureOrphanWatch() {
    if (!orphanTimer) orphanTimer = setInterval(checkOrphans, ORPHAN_POLL_MS);
  }

  function dispatchAccepted(entry, targetObj, bound, passed, total) {
    const snap = refreshSnapshot(entry.snapshot);

    // A verdict proven to belong to this submission carries the server's own copy of the judged code. An unproven one could be a history row for another tab.
    const serverCode = bound ? firstField(targetObj, VERDICT_CODE_KEYS) : '';
    let code = serverCode || snap.code;
    let codeSource = serverCode ? 'verdict' : snap.codeSource;
    if (!code || !code.trim()) {
      // Last resorts when nothing was captured at intent: an unproven verdict's code, then a live editor read that may reflect a tab switch.
      const unboundCode = firstField(targetObj, VERDICT_CODE_KEYS);
      code = unboundCode || readActiveEditor().code;
      codeSource = unboundCode ? 'verdict-unbound' : 'late-editor-read';
      diag('WARNING', 'CODE_NOT_SNAPSHOTTED', codeSource);
    }
    const language = (bound ? firstField(targetObj, ['language', 'lang'], true) : '') ||
      snap.requestLanguage || snap.languageId || snap.domLanguage || '';

    pending = pending.filter(p => p !== entry);
    savePending();
    rememberDispatched(entry, targetObj);

    console.log('%c[TUFHub Interceptor] 🎉 100% PASSED ACCEPTED SUBMISSION CONFIRMED!', 'color: #3b82f6; font-weight: bold; font-size: 13px;', { passed, total, bound, codeSource });
    diag('VERDICT_ACCEPTED', bound ? 'DISPATCHING_BOUND' : 'DISPATCHING', `${snap.slug} ${passed}/${total} code=${codeSource}`);

    window.dispatchEvent(new CustomEvent('TUFHUB_ACCEPTED_SUBMISSION', {
      detail: {
        token: entry.token,
        code,
        codeSource,
        language,
        title: snap.title,
        titleSource: snap.titleSource,
        difficulty: snap.difficulty,
        description: snap.description,
        url: snap.url,
        timestamp: Date.now(),
        tabLabel: snap.tabLabel || '',
        tabCount: snap.tabCount || 0,
        syllabusMainTopic: snap.syllabusMainTopic || '',
        syllabusSubTopic: snap.syllabusSubTopic || '',
        bound
      }
    }));
  }

  function findSubmissionObject(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      if (obj.length > 0) return findSubmissionObject(obj[0]);
      return null;
    }

    if (Array.isArray(obj.submissions) && obj.submissions.length > 0) {
      return findSubmissionObject(obj.submissions[0]);
    }

    // Unambiguous verdict fields win outright.
    if (obj.verdict || obj.submission_status || obj.status_text) {
      return obj;
    }

    // A bare status is ambiguous because REST envelopes wrap results in {status: 'success', data: {...}}.
    // Downstream treats SUCCESS as an accepted verdict, so unpack nested data before checking bare status.
    if (obj.data) {
      const nested = findSubmissionObject(obj.data);
      if (nested) return nested;
    }

    if (obj.status) {
      return obj;
    }

    return null;
  }

  function processPayload(method, url, data, submitEntry) {
    if (!data) return;

    markAlive();
    const urlStr = url.toString().toLowerCase();

    // Cache the authoritative syllabus tree (topic/subtopic per slug) the page itself fetches on load.
    // NOTE: Must run before the generic '/track' ignore-list check below, which would otherwise swallow it.
    if (urlStr.includes('/syllabus/track')) {
      try {
        const info = data.data && data.data.info;
        const tree = data.data && data.data.syllabus;
        if (info && info.key && Array.isArray(tree)) {
          const trackKey = String(info.key).toLowerCase();
          syllabusMaps[trackKey] = buildSyllabusMap(tree);
          console.log(`[TUFHub Interceptor] 🗺️ Cached ${info.key} syllabus (${syllabusMaps[trackKey].size} problems indexed).`);
          // Covers the race where a submission was snapshotted before this fetch resolved. Each snapshot is filled by its own frozen track and slug.
          let filled = false;
          pending.forEach((p) => {
            if (p.snapshot.syllabusMainTopic) return;
            const entry = lookupSyllabus(p.snapshot.track, p.snapshot.slug);
            if (!entry) return;
            p.snapshot.syllabusMainTopic = entry.mainTopic;
            p.snapshot.syllabusSubTopic = entry.subTopic;
            filled = true;
            dispatchSnapshot(p);
          });
          if (filled) savePending();
        }
      } catch (e) {}
      return;
    }

    // Cache Problem Details on page load
    if (urlStr.includes('/problem') && !urlStr.includes('/judge/')) {
      try {
        const prob = data.data || data.problem || data;
        const respSlug = currentProblemSlug();
        // Binds cached problem metadata directly to the active problem slug.
        // NOTE: Prevents single-page application navigation from leaking previous problem titles into subsequent syncs.
        if (prob.description) {
          cachedProblemDescription = prob.description;
          cachedProblemDescriptionSlug = respSlug;
        }
        if (prob.title || prob.name) {
          cachedProblemTitle = prob.title || prob.name;
          cachedProblemSlug = respSlug;
        }
        const difficulty = firstField(prob, ['difficulty', 'difficultyLevel', 'tier']);
        if (difficulty) {
          cachedProblemDifficulty = difficulty.trim();
          cachedProblemDifficultySlug = respSlug;
        }
        console.log('[TUFHub Interceptor] 📝 Cached problem metadata:', { title: cachedProblemTitle, slug: cachedProblemSlug, descLength: cachedProblemDescription.length });
      } catch (e) {}
      return;
    }

    // Ignore non-judge endpoints
    if (
      urlStr.includes('/drafts') ||
      urlStr.includes('/run') ||
      urlStr.includes('/track') ||
      urlStr.includes('/tabs')
    ) {
      return;
    }

    // Allowlist includes /judge/check-submit to capture poll responses from async SQL evaluations.
    if (
      !urlStr.includes('/judge/submit') &&
      !urlStr.includes('/judge/submissions') &&
      !urlStr.includes('/judge/check-submit') &&
      !urlStr.includes('/submission/result')
    ) {
      // Logs near-miss candidate endpoints to diagnostics so API changes remain visible.
      // Known routine traffic (credit balance, Run-button polls, AI review) is skipped because it fills the 50-entry log after every submission.
      const routine = urlStr.includes('/judge/credits') || urlStr.includes('/judge/check-run') || urlStr.includes('/ai/submission-review');
      if (!routine && (urlStr.includes('judge') || urlStr.includes('verdict') || urlStr.includes('submission'))) {
        diag('UNMATCHED_ENDPOINT', 'ENDPOINT_NOT_IN_ALLOWLIST', `${method} ${urlStr}`);
      }
      return;
    }

    if (urlStr.includes('/judge/check-submit')) notePoll(url, urlStr);

    // POST /judge/submit carries queued submission metadata rather than a verdict. Evaluating it directly risks false positives.
    if (method === 'POST' && urlStr.includes('/judge/submit')) {
      confirmSubmission(data, submitEntry);
      return;
    }

    // GATE: ignore page-load history fetches unless a submission is pending.
    prunePending();
    if (pending.length === 0) {
      diag('IGNORED', 'NOT_ARMED', 'No pending submission (page-load history fetch).', false);
      return;
    }

    console.log('[TUFHub Interceptor] 📡 Judge API Payload Intercepted:', { method, url: urlStr, data });

    // A list payload is searched for the row carrying a known submission id before falling back to the generic first-row picker.
    let targetObj = null;
    let match = null;
    for (const p of pending) {
      if (!p.submissionId || !p.idKey) continue;
      const hit = findEntryWithId(data, p.idKey, p.submissionId);
      if (hit) {
        targetObj = hit;
        match = { entry: p, bound: true };
        break;
      }
    }
    if (!targetObj) targetObj = findSubmissionObject(data);
    if (!targetObj) {
      const orphan = selfPolledFor(urlStr);
      if (orphan && reportsCompleted(data)) discardSubmission(orphan, 'SELF_POLL_NO_RESULT');
      diag('WAITING', 'NO_SUBMISSION_OBJECT', `${method} ${urlStr}`, false);
      return;
    }

    const rawVerdict = (targetObj.verdict || targetObj.status || targetObj.submission_status || '').toString().trim().toUpperCase();

    if (!rawVerdict.includes('ACCEPTED') && rawVerdict !== 'SUCCESS') {
      // Drop a self-polled submission once it reaches a final non-accepted verdict (wrong answer, TLE) so polling stops. A submission the page polls itself keeps waiting.
      const orphan = (match && match.entry.selfPolls ? match.entry : null) || selfPolledFor(urlStr);
      const finished = (rawVerdict && !IN_PROGRESS_VERDICT.test(rawVerdict)) || reportsCompleted(data);
      if (orphan && finished) discardSubmission(orphan, `SELF_POLL_${rawVerdict || 'NO_RESULT'}`);
      diag('WAITING', 'VERDICT_NOT_ACCEPTED', rawVerdict, false);
      return;
    }

    const passed = targetObj.passed_test_cases ?? targetObj.passedTestCases ?? targetObj.passed;
    const total = targetObj.total_test_cases ?? targetObj.totalTestCases ?? targetObj.total;

    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      diag('DROPPED', 'PARTIAL_TEST_CASES', `${passed}/${total}`);
      return;
    }

    if (wasRecentlyDispatched(targetObj)) {
      diag('DROPPED', 'DUPLICATE_SUBMISSION_ID', specificIdsOf(targetObj).join(','));
      return;
    }

    if (!match) match = matchPending(targetObj, urlStr);
    if (!match) {
      diag('IGNORED', 'OTHER_SUBMISSION', `${method} ${urlStr} ${specificIdsOf(targetObj).join(',')}`);
      return;
    }

    dispatchAccepted(match.entry, targetObj, match.bound, passed, total);
  }

  // -------------------------------------------------------------
  // Self-healing fetch hook
  // -------------------------------------------------------------
  function requestMeta(input, init) {
    let url = '';
    let method = 'GET';
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        // Extracts url and method directly from Request instances where String(input) yields '[object Request]'.
        // NOTE: Direct property extraction ensures Request-style fetch calls remain visible to the payload matcher.
        url = input.url;
        method = input.method || 'GET';
      } else {
        url = input ? input.toString() : '';
      }
      if (init && init.method) method = init.method;
    } catch (e) {}
    return { url, method: (method || 'GET').toUpperCase() };
  }

  function wrapFetch(target) {
    if (typeof target !== 'function' || target.__tufhubWrapped) return target;

    const wrapped = function (...args) {
      const { url, method } = requestMeta(args[0], args[1]);
      const submitEntry = inspectOutgoingRequest(url, method, args[0], args[1]);
      if (method === 'GET' && String(url).toLowerCase().includes('/judge/check-submit')) {
        const init = args[1] || {};
        rememberPollTemplate(url, 'fetch', init.headers, init.credentials === 'include');
      }
      return target.apply(this, args).then((response) => {
        try {
          if (submitEntry && !response.ok) discardSubmission(submitEntry, `HTTP_${response.status}`);
          response.clone().json().then((data) => {
            processPayload(method, url, data, submitEntry);
          }).catch(() => {});
        } catch (e) {}
        return response;
      }, (err) => {
        if (submitEntry) discardSubmission(submitEntry, 'NETWORK_ERROR');
        throw err;
      });
    };
    wrapped.__tufhubWrapped = true;
    wrapped.__tufhubOriginal = target;
    return wrapped;
  }

  let installedFetch = wrapFetch(window.fetch);

  try {
    // Property descriptor setter re-wraps subsequent assignments to window.fetch so the hook persists.
    // NOTE: Direct assignments can be clobbered by lazy polyfills or analytics SDKs, blinding detection for the document lifetime.
    // NOTE: The setter re-wraps any subsequent reassignment so the interception hook reliably survives.
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return installedFetch;
      },
      set(next) {
        installedFetch = wrapFetch(next);
        diag('FETCH_REWRAPPED', 'PAGE_REASSIGNED_FETCH', '');
      }
    });
  } catch (e) {
    window.fetch = installedFetch;
  }

  // Hook XMLHttpRequest
  const originalXOpen = XMLHttpRequest.prototype.open;
  const originalXSend = XMLHttpRequest.prototype.send;
  const originalXSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._tufhub_method = method ? method.toUpperCase() : 'GET';
    this._tufhub_url = url;
    this._tufhub_headers = {};
    return originalXOpen.apply(this, arguments);
  };

  // Track headers per request so an abandoned submission can be polled with the same headers the page sends.
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this._tufhub_headers) this._tufhub_headers[name] = value;
    } catch (e) {}
    return originalXSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    let submitEntry = null;
    try {
      if (this._tufhub_method === 'POST' && isJudgeSubmitUrl(this._tufhub_url)) {
        submitEntry = onJudgeSubmitRequest(typeof body === 'string' ? body : '');
      }
      if (this._tufhub_method === 'GET' && String(this._tufhub_url || '').toLowerCase().includes('/judge/check-submit')) {
        rememberPollTemplate(this._tufhub_url, 'xhr', this._tufhub_headers, this.withCredentials);
      }
    } catch (e) {}
    if (submitEntry) {
      const discard = () => discardSubmission(submitEntry, 'NETWORK_ERROR');
      this.addEventListener('error', discard);
      this.addEventListener('abort', discard);
    }
    this.addEventListener('load', function () {
      try {
        if (submitEntry && (this.status < 200 || this.status >= 300)) discardSubmission(submitEntry, `HTTP_${this.status}`);
        if (this.responseText) {
          const data = JSON.parse(this.responseText);
          processPayload(this._tufhub_method, this._tufhub_url, data, submitEntry);
        }
      } catch (e) {}
    });
    return originalXSend.apply(this, arguments);
  };

})();
