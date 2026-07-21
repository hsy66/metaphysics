// ==UserScript==
// @name         阳光学堂自动看视频助手
// @namespace    http://tampermonkey.net/
// @version      10.3.2
// @description  播放页严格v5.4；课内全「已完成」才算完课；自动考试(修冷却卡死/手动考试清锁/正式开考)；默认禁止自动回跳路径。仅测试自用。
// @author       You
// @match        https://xue.sinosig.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 防止重复注入
  if (window.__xueAutoWatchV10Loaded) {
    console.log('[学堂助手] 已加载，跳过重复注入');
    return;
  }
  window.__xueAutoWatchV10Loaded = true;

  const VER = '10.3.4';
  const TAG = '[学堂助手]';
  const STORE_KEY = 'xue_auto_watch_v10';
  const LOG_KEY = 'xue_auto_watch_v10_logs';
  const ANS_KEY = 'xue_auto_exam_answers_v10';
  const BOOT_AT = Date.now();
  const PAGE_ID = Math.random().toString(36).slice(2, 8);

  // 你的规则：待考试 / 重新学习 = 这门课视频已看完（不再自动点）
  // 待考试 / 开始考试 / 重新考试 = 需要考试
  // 有时钟图标 = 已有考试记录（可看答案，正式考）；无图标 = 首次盲答
  const PATH_DONE = ['待考试', '重新学习', '已完成', '已学完', '开始考试', '重新考试'];
  const PATH_TODO = ['开始学习', '继续学习', '学习中'];
  const PATH_EXAM = ['待考试', '开始考试', '重新考试'];

  const CFG = {
    // 用户负责打开「我的学习→专属成长计划→具体任务」；脚本默认不自动点计划卡片
    autoOpenPlan: false,
    // 路径页：默认不自动点「开始/继续学习」（防连环开课/弹窗重定向）
    // 需要自动开课：面板点「开下一门」，或把此项改为 true
    autoOpenFromPath: false,
    openNextOnlyAfterCourseDone: true,
    // 同时只开一门视频课
    oneCourseAtATime: true,
    pathScanMs: 8000,
    playerAdvanceMs: 2000,
    doneWaitMs: 8000,
    pathOpenCooldownMs: 15000,
    playerHeartbeatTimeoutSec: 90,
    // 绝对不要关标签（闪退主因之一）
    closePlayerWhenDone: false,
    // 禁止 history.back / 乱 reload
    allowHistoryBack: false,
    allowPathReload: false,
    // 关键：默认禁止播放页自动 location 回路径（这是“学着学着又回课程选择”的主因）
    // 完课后只写状态+日志；你在路径页点「开下一门」或手动回去
    autoReturnToPath: false,
    // 进入播放页后至少停留这么久，才允许判定完课（防刚进已完成目录就回跳）
    minStayBeforeFinishMs: 20000,
    // 详细日志
    verboseLog: true,
    maxLogEntries: 400,
    // 自动考试：盲答交卷 → 看答案记忆 → 再考一次用记忆答案
    autoExam: true,
    // 路径页：视频都学完后，是否自动点「待考试/开始考试/重新考试」
    autoOpenExamFromPath: true,
    // 考试页轮询
    examScanMs: 4000,
    // 开考/开记录冷却（防连环开窗）
    examOpenCooldownMs: 45000,
    examHistoryCooldownMs: 60000,
    // 首次盲答（无时钟图标）：交白卷延迟
    examBlindSubmitDelayMs: 3000,
    // 正式考试（有时钟图标/有答案）：交卷延迟 ≥1分钟
    examFormalSubmitDelayMs: 65000,
    // 兼容旧字段
    examSubmitDelayMs: 65000,
    // 正式考答题间隔；盲答可更快
    examAnswerGapMs: 1200,
    examBlindAnswerGapMs: 200,
    // 弹窗操作后等待
    examModalWaitMs: 2500,
    // 结果页记完答案后回路径等待
    examResultReturnMs: 8000,
    // 考试进行中锁（路径页别再点）
    examLockMs: 8 * 60 * 1000,
  };

  function currentExamSubmitDelayMs() {
    const st = loadState();
    // 有答案图标/正式模式 → 长延迟；首次盲答 → 3s
    if (st.examMode === 'blind' || st.examHasHistory === false) {
      return CFG.examBlindSubmitDelayMs || 3000;
    }
    return CFG.examFormalSubmitDelayMs || CFG.examSubmitDelayMs || 65000;
  }
  function currentExamAnswerGapMs() {
    const st = loadState();
    if (st.examMode === 'blind' || st.examHasHistory === false) {
      return CFG.examBlindAnswerGapMs || 200;
    }
    return CFG.examAnswerGapMs || 1200;
  }

  let __xueClicking = false;
  const logBuf = [];
  try {
    const old = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    if (Array.isArray(old)) old.slice(-80).forEach((x) => logBuf.push(x));
  } catch (e) {}

  function ts() {
    const d = new Date();
    return d.toISOString().replace('T', ' ').replace('Z', '');
  }
  function pushLog(level, msg, data) {
    const row = {
      t: ts(),
      ms: Date.now() - BOOT_AT,
      pageId: PAGE_ID,
      level: level,
      page: (function () {
        try {
          return pageType();
        } catch (e) {
          return '?';
        }
      })(),
      href: String(location.href || '').slice(0, 180),
      msg: String(msg || ''),
      data: data === undefined ? null : data,
    };
    logBuf.push(row);
    while (logBuf.length > CFG.maxLogEntries) logBuf.shift();
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(logBuf.slice(-120)));
    } catch (e) {}
    try {
      window.__xueLogs = logBuf.slice();
      window.__xueLastLog = row;
    } catch (e2) {}
    const line = TAG + '[' + level + '][#' + PAGE_ID + '][+'+ row.ms + 'ms] ' + msg;
    try {
      if (level === 'ERROR') console.error(line, data === undefined ? '' : data);
      else if (level === 'WARN') console.warn(line, data === undefined ? '' : data);
      else if (level === 'NAV') console.info('%c' + line, 'color:#f59e0b;font-weight:bold', data === undefined ? '' : data);
      else if (CFG.verboseLog || level === 'INFO' || level === 'ACTION')
        console.log(line, data === undefined ? '' : data);
    } catch (e3) {}
    return row;
  }
  const Log = (msg, data) => pushLog('INFO', msg, data);
  const LogA = (msg, data) => pushLog('ACTION', msg, data);
  const LogW = (msg, data) => pushLog('WARN', msg, data);
  const LogE = (msg, data) => pushLog('ERROR', msg, data);
  const LogN = (msg, data) => pushLog('NAV', msg, data);

  function dumpLogsText() {
    return logBuf
      .map(function (r) {
        return (
          r.t +
          ' | ' +
          r.level +
          ' | #' +
          r.pageId +
          ' | ' +
          r.page +
          ' | +' +
          r.ms +
          'ms | ' +
          r.msg +
          (r.data != null ? ' | ' + (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : '') +
          ' | ' +
          r.href
        );
      })
      .join('\n');
  }
  function copyLogs() {
    const text = dumpLogsText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            LogA('日志已复制到剪贴板', { lines: logBuf.length });
            setPanel('日志已复制到剪贴板\n共 ' + logBuf.length + ' 条\n请粘贴发给我');
          },
          function () {
            window.prompt('复制下面日志发给我：', text.slice(0, 15000));
          }
        );
        return;
      }
    } catch (e) {}
    window.prompt('复制下面日志发给我：', text.slice(0, 15000));
  }
  try {
    window.__xueDumpLogs = dumpLogsText;
    window.__xueCopyLogs = copyLogs;
  } catch (e) {}

  const qs = (s, r) => (r || document).querySelector(s);
  const qsa = (s, r) => Array.from((r || document).querySelectorAll(s));
  const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  function pageType() {
    const href = location.href;
    const hash = location.hash || '';
    if (/#person\/exam\/train/.test(href) || /#person\/exam\/train/.test(hash) || /\/exam\/train/.test(href))
      return 'exam';
    if (/#person\/exam\/result/.test(href) || /#person\/exam\/result/.test(hash) || /\/exam\/result/.test(href))
      return 'exam_result';
    if (/courseDetail\//.test(href)) return 'player';
    if (/study-path\/study-view/.test(href) || /study-path\/study-view/.test(hash)) return 'path';
    if (/\/person\/study/.test(location.pathname)) return 'study';
    return 'other';
  }

  function loadAnswers() {
    try {
      return JSON.parse(localStorage.getItem(ANS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveAnswers(map) {
    try {
      localStorage.setItem(ANS_KEY, JSON.stringify(map || {}));
    } catch (e) {}
    return map;
  }
  function normalizeQTitle(t) {
    return String(t || '')
      .replace(/\s+/g, ' ')
      .replace(/[\(（]\s*\d+\s*分\s*[\)）]/g, '')
      .replace(/^\d+[\.、\s]*/, '')
      .trim()
      .slice(0, 160);
  }
  function parseAnswerLetters(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    // 标准答案：C / 标准答案： 正确 / 标准答案：AB / 标准答案：A,B
    let m = s.match(/标准答案[：:]\s*([A-Da-d正确错误对否是]+(?:\s*[,，、\/]\s*[A-Da-d正确错误对否是]+)*)/);
    let part = m ? m[1] : s;
    part = part.replace(/标准答案[：:]/g, '').trim();
    if (/正确|对|是/.test(part) && !/[A-Da-d]/.test(part)) return ['正确'];
    if (/错误|否|错/.test(part) && !/[A-Da-d]/.test(part)) return ['错误'];
    const letters = part.match(/[A-Da-d]/g);
    if (letters && letters.length) return letters.map((x) => x.toUpperCase());
    return [];
  }
  function optionLetterFromText(optText) {
    const m = String(optText || '')
      .trim()
      .match(/^([A-Da-d])[\.、．\s]/);
    return m ? m[1].toUpperCase() : '';
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveState(patch) {
    const prev = loadState();
    const next = Object.assign({}, prev, patch, { updatedAt: Date.now() });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch (e) {}
    if (CFG.verboseLog && patch) {
      const keys = Object.keys(patch);
      if (keys.some((k) => k !== 'playerHeartbeatAt' && k !== 'updatedAt')) {
        Log('saveState', {
          patch: patch,
          phase: next.phase,
          activeCourseId: next.activeCourseId,
          lastAction: next.lastAction,
          allowOpenNext: next.allowOpenNext,
        });
      }
    }
    return next;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch (e) {
      return true;
    }
  }

  function safeClick(el, reason) {
    if (!el || __xueClicking) {
      LogW('safeClick跳过', { reason: reason, hasEl: !!el, clicking: __xueClicking });
      return false;
    }
    __xueClicking = true;
    try {
      el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (e) {}
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 10, top: 10, width: 20, height: 20 };
      const x = r.left + Math.max(r.width / 2, 1);
      const y = r.top + Math.max(r.height / 2, 1);
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      };
      LogA('safeClick开始', {
        reason: reason || text(el).slice(0, 40),
        tag: el.tagName,
        id: el.id || '',
        className: String(el.className || '').slice(0, 80),
        text: text(el).slice(0, 80),
      });
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        try {
          const ev = new MouseEvent(type, opts);
          try {
            Object.defineProperty(ev, '__xueSynthetic', { value: true });
          } catch (e2) {}
          el.dispatchEvent(ev);
        } catch (e) {}
      });
      try {
        if (typeof el.click === 'function') el.click();
      } catch (e) {}
      LogA('safeClick完成', reason || text(el).slice(0, 40));
      return true;
    } catch (e) {
      LogE('点击失败', e && e.message);
      return false;
    } finally {
      __xueClicking = false;
    }
  }

  function courseIdFromUrl(url) {
    const m = String(url || location.href).match(/courseDetail\/(\d+)/);
    return m ? m[1] : '';
  }
  function parseCourseIdFromBtnId(id) {
    if (!id) return '';
    const parts = String(id).replace(/^v\d+studyBtn-/, '').split('_');
    return parts[parts.length - 1] || '';
  }

  function hasLivePlayerLock(st) {
    if (!CFG.oneCourseAtATime || !st) return false;
    if (st.phase !== 'playing') return false;
    const now = Date.now();
    const hb = st.playerHeartbeatAt || 0;
    const opened = st.activeOpenedAt || 0;
    if (hb && now - hb < CFG.playerHeartbeatTimeoutSec * 1000) return true;
    if (opened && now - opened < Math.max(CFG.playerHeartbeatTimeoutSec, 30) * 1000) return true;
    return false;
  }

  // =========================
  // 面板（仅状态展示，不改播放）
  // =========================
  function ensurePanel() {
    if (!document.body) return null;
    let box = qs('#xue-auto-panel');
    // 旧注入可能留下无「复制日志」的面板，强制重建
    if (box && (!qs('#xue-auto-copy-log', box) || box.getAttribute('data-ver') !== VER)) {
      try {
        box.remove();
      } catch (e) {}
      box = null;
    }
    if (box) return box;
    box = document.createElement('div');
    box.id = 'xue-auto-panel';
    box.setAttribute('data-ver', VER);
    box.setAttribute('data-page-id', PAGE_ID);
    box.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.88);color:#fff;padding:10px 12px;border-radius:8px;font:12px/1.45 sans-serif;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,.35);white-space:pre-wrap;';
    box.innerHTML =
      '<div style="font-weight:700;margin-bottom:4px">学堂自动看课 v' +
      VER +
      ' <span style="opacity:.7">#' +
      PAGE_ID +
      '</span></div>' +
      '<div id="xue-auto-panel-body">初始化...</div>' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<button id="xue-auto-force-next" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#10b981;color:#fff">开下一门</button>' +
      '<button id="xue-auto-exam" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#f59e0b;color:#fff">自动考试</button>' +
      '<button id="xue-auto-copy-log" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#3b82f6;color:#fff">复制日志</button>' +
      '<button id="xue-auto-reset" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#6b7280;color:#fff">重置状态</button>' +
      '</div>';
    document.body.appendChild(box);
    qs('#xue-auto-force-next', box).onclick = () => {
      LogA('面板点击：开下一门');
      saveState({
        phase: 'path_running',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'manual_next',
        allowOpenNext: true,
        forceOpenOnce: true,
      });
      setPanel('手动：允许开下一门（仅一次）\n路径页会自动点第一门未学完课');
      if (pageType() === 'path') setTimeout(function () { pathLoop(true); }, 300);
    };
    qs('#xue-auto-exam', box).onclick = () => {
      LogA('面板点击：自动考试');
      CFG.autoExam = true;
      CFG.autoOpenExamFromPath = true;
      // 清掉残留冷却/锁，避免卡死在「操作冷却中」
      saveState({
        lastAction: 'manual_exam',
        allowOpenExam: true,
        forceExamOnce: true,
        examPhase: '',
        phase: 'path_running',
        examOpenedAt: 0,
        lastExamOpenAt: 0,
        lastExamHistoryAt: 0,
        lastExamWindowAt: 0,
      });
      setPanel('手动：开启自动考试\n已清除冷却锁\n将点「待考试/开始考试/重新考试」');
      if (pageType() === 'path') setTimeout(function () { pathLoop(true); }, 300);
      if (pageType() === 'exam') setTimeout(function () { examLoop(); }, 300);
      if (pageType() === 'exam_result') setTimeout(function () { examResultLoop(); }, 300);
    };
    qs('#xue-auto-copy-log', box).onclick = () => {
      LogA('面板点击：复制日志');
      copyLogs();
    };
    qs('#xue-auto-reset', box).onclick = () => {
      LogA('面板点击：重置状态');
      localStorage.removeItem(STORE_KEY);
      setPanel('状态已重置，请刷新页面\n日志仍保留，可点「复制日志」\n答案库未清空');
    };
    return box;
  }
  function setPanel(msg) {
    try {
      ensurePanel();
      const body = qs('#xue-auto-panel-body');
      if (body) body.textContent = msg;
    } catch (e) {}
  }

  // =====================================================================
  // 播放页：严格使用你验证过的 v5.4 原逻辑（不擅自改核心）
  // 来源：阳光学堂防切屏助手（静音版）v5.4
  // =====================================================================
  function installV54PlayerCore() {
    if (window.__xueV54Installed) return;
    window.__xueV54Installed = true;

    // ========== 核心1：保留上报拦截（放行进度，拦截暂停） ==========
    (function interceptReporting() {
      const originalFetch = window.fetch;

      function isPauseReport(url, body) {
        const str = (String(url) + ' ' + String(body || '')).toLowerCase();
        return str.includes('"pause"') || str.includes('suspend') || str.includes('stopstudy');
      }

      window.fetch = function (url, options) {
        const urlStr = String(url);
        // 绝对放行进度保存
        if (urlStr.includes('saveStudyLocation') || urlStr.includes('saveProgress')) {
          Log('放行进度保存', urlStr);
          return originalFetch.apply(this, arguments);
        }
        // 拦截暂停
        if (isPauseReport(url, options && options.body)) {
          Log('拦截暂停上报');
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ code: 200 }),
          });
        }
        return originalFetch.apply(this, arguments);
      };
    })();

    // ========== 核心2：防切屏（保留原逻辑） ==========
    (function antiBlur() {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      const originalAddEventListener = document.addEventListener;
      document.addEventListener = function (type, listener, options) {
        if (String(type || '').includes('visibility')) return;
        return originalAddEventListener.call(this, type, listener, options);
      };
      document.hasFocus = () => true;
    })();

    // ========== 核心3：控制栏常显+自动播放+强制静音 ==========
    setInterval(() => {
      // 保持控制栏显示
      document.querySelectorAll('.vjs-control-bar').forEach((bar) => {
        bar.classList.remove('vjs-hidden');
        bar.style.opacity = '1';
      });

      // 自动播放 + 强制静音
      const video = document.querySelector('video');
      if (video && video.readyState >= 2) {
        // 强制静音（每次循环都检查，确保无法手动开启声音）
        if (!video.muted) {
          video.muted = true;
          Log('已自动静音');
        }

        // 自动播放
        if (video.paused) {
          video.play().catch((err) => {
            Log('自动播放被阻止', err && err.message);
          });
        }
      }
    }, 2000);

    // ========== 核心4：自动关闭课程评价弹窗 ==========
    (function autoCloseEvaluation() {
      const observer = new MutationObserver(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        dialogs.forEach((dialog) => {
          const ariaLabel = dialog.getAttribute('aria-label') || '';
          const titleEl = dialog.querySelector('.el-dialog__title');
          const titleText = titleEl ? titleEl.textContent : '';

          if (ariaLabel.includes('课程怎么样') || (titleText && titleText.includes('课程怎么样'))) {
            const closeBtn = dialog.querySelector('.el-dialog__headerbtn, .el-icon-close');
            if (closeBtn) {
              closeBtn.click();
              Log('已自动关闭课程评价弹窗（点击关闭按钮）');
            } else {
              dialog.remove();
              const modal = document.querySelector('.v-modal, .el-dialog__wrapper');
              if (modal) modal.remove();
              Log('已移除课程评价弹窗DOM');
            }
          }
        });
      });

      function startObs() {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        else setTimeout(startObs, 50);
      }
      startObs();

      setInterval(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        dialogs.forEach((dialog) => {
          const title = dialog.querySelector('.el-dialog__title');
          if (title && title.textContent && title.textContent.includes('课程怎么样')) {
            const closeBtn = dialog.querySelector('.el-dialog__headerbtn');
            if (closeBtn && closeBtn.offsetParent !== null) {
              closeBtn.click();
              Log('兜底检测：已关闭评价弹窗');
            }
          }
        });
      }, 3000);
    })();

    // ========== 核心5：HLS网络错误自动刷新 ==========
    (function hlsErrorAutoReload() {
      const ERROR_KEYWORD = '网络错误导致视频下载中途失败';
      let reloadTriggered = false;

      function checkAndReload() {
        if (reloadTriggered) return;
        const errorDialogs = document.querySelectorAll('.vjs-errors-dialog, .vjs-modal-dialog-content');
        for (const dialog of errorDialogs) {
          const t = dialog.innerText || '';
          if (t.includes(ERROR_KEYWORD)) {
            reloadTriggered = true;
            Log('检测到HLS网络错误，3秒后自动刷新页面...');
            setTimeout(() => location.reload(), 3000);
            return;
          }
        }
      }

      const observer = new MutationObserver(() => checkAndReload());
      function startObs() {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        else setTimeout(startObs, 50);
      }
      startObs();
      setInterval(checkAndReload, 3000);
      Log('HLS错误自动刷新监控已启动');
    })();

    Log('防切屏助手已加载 v5.4（新增HLS错误自动刷新）');
  }

  // =====================================================================
  // 编排层（仅此部分新增）：判定视频播完 → 下一视频 → 本课完 → 下一课
  // =====================================================================

  // ---------- 路径页 ----------
  function installOpenGuard() {
    if (window.__xueOpenGuardedV10) return;
    window.__xueOpenGuardedV10 = true;
    const rawOpen = window.open.bind(window);
    const recentExamOpens = {};
    window.open = function (url, name, specs) {
      const st = loadState();
      const urlStr = String(url || '');
      const cid = courseIdFromUrl(urlStr);
      const isExamUrl = /exam\/(train|result)/.test(urlStr);
      LogN('window.open调用', {
        url: urlStr.slice(0, 200),
        name: name,
        cid: cid,
        phase: st.phase,
        active: st.activeCourseId,
      });
      if (cid && hasLivePlayerLock(st) && st.activeCourseId && cid !== st.activeCourseId) {
        LogW('拦截并发开课', { url: urlStr, active: st.activeCourseId, tryCid: cid });
        setPanel('已有课程播放中，拦截并发打开\nactive=' + st.activeCourseId);
        return null;
      }
      // 考试/结果页：短时间防重复；结果与正式考试用不同窗口名，避免 SPA 串台
      if (isExamUrl) {
        const key = urlStr.replace(/#.*$/, '') + '#' + (urlStr.match(/exam\/(?:train|result)[^?]*/)||[''])[0];
        const now = Date.now();
        if (recentExamOpens[key] && now - recentExamOpens[key] < 30000) {
          LogW('拦截重复考试窗口', { url: urlStr.slice(0, 120), ago: now - recentExamOpens[key] });
          return null;
        }
        recentExamOpens[key] = now;
        const isResult = /exam\/result/.test(urlStr);
        saveState({
          lastExamWindowAt: now,
          lastAction: isResult ? 'window_open_exam_result' : 'window_open_exam',
        });
        const winName = isResult ? '_xue_exam_result' : '_xue_exam_train';
        try {
          return rawOpen(urlStr, winName, specs);
        } catch (e) {
          return rawOpen(urlStr, name || '_blank', specs);
        }
      }
      if (cid) {
        saveState({
          activeCourseId: cid,
          activeOpenedAt: Date.now(),
          playerHeartbeatAt: Date.now(),
          phase: 'playing',
          pathUrl: pageType() === 'path' ? location.href : loadState().pathUrl,
          lastAction: 'window_open_course',
        });
      }
      return rawOpen(url, name || '_blank', specs);
    };
  }

  function installNavWatch() {
    if (window.__xueNavWatchV10) return;
    window.__xueNavWatchV10 = true;
    try {
      window.addEventListener('beforeunload', function (e) {
        LogN('beforeunload 页面即将离开/关闭', {
          href: location.href,
          title: document.title,
          state: loadState(),
          stack: (new Error('nav-stack')).stack,
        });
      });
      window.addEventListener('pagehide', function () {
        LogN('pagehide', { href: location.href });
      });
      window.addEventListener('unload', function () {
        LogN('unload', { href: location.href });
      });
      const rawPush = history.pushState && history.pushState.bind(history);
      const rawReplace = history.replaceState && history.replaceState.bind(history);
      if (rawPush) {
        history.pushState = function () {
          LogN('history.pushState', { args0: arguments[2] || arguments[0] });
          return rawPush.apply(history, arguments);
        };
      }
      if (rawReplace) {
        history.replaceState = function () {
          LogN('history.replaceState', { args0: arguments[2] || arguments[0] });
          return rawReplace.apply(history, arguments);
        };
      }
      window.addEventListener('hashchange', function () {
        LogN('hashchange', { href: location.href });
      });
      window.addEventListener('popstate', function () {
        LogN('popstate', { href: location.href });
      });
      Log('导航监控已安装(beforeunload/history/hash)');
    } catch (e) {
      LogE('导航监控安装失败', e && e.message);
    }
  }

  function findEnrollButton() {
    const candidates = qsa('button, a, .btn, [role="button"]').filter((el) => {
      const t = text(el);
      if (!t) return false;
      if (!(t === '我要学习' || t === '立即学习' || t === '报名学习' || t === '参加学习')) return false;
      return isVisible(el);
    });
    return (
      candidates.find((el) => el.tagName === 'BUTTON' && !el.disabled && el.getAttribute('disabled') == null) ||
      candidates.find((el) => el.tagName === 'BUTTON') ||
      candidates[0] ||
      null
    );
  }

  function clickEnrollIfNeeded() {
    const btn = findEnrollButton();
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute('disabled') != null || /disabled|is-disabled/.test(btn.className || '')) {
      return false;
    }
    setPanel('路径页：检测到未报名\n>>> 点击「我要学习」');
    Log('点击我要学习');
    saveState({ lastAction: 'click_enroll', pathUrl: location.href, phase: 'path_running' });
    safeClick(btn, '我要学习');
    return true;
  }

  function scanPathCourses() {
    let rows = qsa('.course-catalog');
    if (!rows.length) {
      const btns = qsa('button').filter((b) =>
        /开始学习|继续学习|待考试|重新学习|学习中|已完成|开始考试|重新考试/.test(text(b))
      );
      rows = Array.from(
        new Set(
          btns
            .map((b) => b.closest('.course-catalog, .course-item, li, tr, .list-item, .item') || b.parentElement)
            .filter(Boolean)
        )
      );
    }
    return rows
      .map((row) => {
        const btn =
          qs('button.btn', row) ||
          qsa('button', row).find((b) =>
            /开始学习|继续学习|待考试|重新学习|学习中|已完成|开始考试|重新考试/.test(text(b))
          );
        const status = btn ? text(btn) : '';
        const titleEl = qs('strong, .title strong, .f14', row) || qs('.title', row);
        const title = text(titleEl) || text(row).slice(0, 40);
        const courseId = parseCourseIdFromBtnId(btn && btn.id);
        const needExam = PATH_EXAM.some((s) => status.includes(s));
        const isExamOnly =
          (/在线考试/.test(text(row)) && !/在线课程/.test(text(row))) ||
          status.includes('开始考试') ||
          status.includes('重新考试');
        const examHistoryLink =
          qs('a[id*="examHistory"]', row) ||
          (qs('.glyphicon-time', row) && qs('.glyphicon-time', row).closest('a')) ||
          null;
        // 时钟图标 = 已有考试记录（可查看答案）
        const hasExamHistory = !!(examHistoryLink || qs('.glyphicon-time', row));
        const examJudge = (btn && btn.getAttribute('examjudge')) || '';
        const examIdMatch = examJudge.match(/ToExam#([0-9a-zA-Z]+)/);
        let examId = examIdMatch ? examIdMatch[1] : '';
        // 从考试记录 a 的 id 里兜底解析 examId
        if (!examId && examHistoryLink && examHistoryLink.id) {
          const hm = String(examHistoryLink.id).match(/examHistory-([0-9a-zA-Z]+)/);
          if (hm) examId = hm[1];
        }
        return {
          row,
          btn,
          status,
          title,
          courseId,
          isExam: isExamOnly,
          needExam,
          examHistoryLink,
          hasExamHistory,
          examId,
        };
      })
      .filter((x) => x.btn && x.status);
  }

  function isPathDone(status) {
    return PATH_DONE.some((s) => status.includes(s));
  }
  function isPathTodo(status) {
    if (isPathDone(status)) return false;
    return PATH_TODO.some((s) => status.includes(s));
  }

  let lastPathOpenAt = 0;
  let lastEnrollClickAt = 0;

  function saneTs(ts, now) {
    const n = Number(ts) || 0;
    if (!n) return 0;
    // 未来时间 / 异常超大时间戳 → 视为无效
    if (n > now + 5000) return 0;
    // 超过 24h 的旧时间也不再参与冷却
    if (now - n > 24 * 60 * 60 * 1000) return 0;
    return n;
  }

  function pathTryExam(list, summary, forceOpen) {
    if (!CFG.autoExam) return false;
    let st = loadState();
    const examTodos = list.filter((x) => x.needExam);
    if (!examTodos.length) {
      if (!list.filter((x) => isPathTodo(x.status)).length) {
        saveState({ phase: 'path_all_done', lastAction: 'path_all_done_no_exam' });
        setPanel(summary + '\n视频已学完，待考试=0\n路径处理完毕');
      }
      return false;
    }

    const now = Date.now();
    // 清洗异常时间戳（日志里出现过“未来时间”导致永久冷却）
    const fixedOpen = saneTs(st.lastExamOpenAt, now);
    const fixedHist = saneTs(st.lastExamHistoryAt, now);
    const fixedOpened = saneTs(st.examOpenedAt, now);
    if (fixedOpen !== (st.lastExamOpenAt || 0) || fixedHist !== (st.lastExamHistoryAt || 0) || fixedOpened !== (st.examOpenedAt || 0)) {
      LogW('清洗异常考试时间戳', {
        lastExamOpenAt: st.lastExamOpenAt,
        lastExamHistoryAt: st.lastExamHistoryAt,
        examOpenedAt: st.examOpenedAt,
        now: now,
      });
      st = saveState({
        lastExamOpenAt: fixedOpen,
        lastExamHistoryAt: fixedHist,
        examOpenedAt: fixedOpened,
        lastAction: 'sanitize_exam_ts',
      });
    }

    const force = !!(forceOpen || st.forceExamOnce);
    const lockMs = CFG.examLockMs || 8 * 60 * 1000;

    // 手动强制：直接清锁
    if (force) {
      st = saveState({
        phase: 'path_running',
        examOpenedAt: 0,
        lastExamOpenAt: 0,
        lastExamHistoryAt: 0,
        allowOpenExam: true,
        lastAction: 'force_exam_clear_lock',
      });
    }

    // 考试中/记答案中：路径页只等待，绝不重复开窗（强制模式跳过）
    if (
      !force &&
      (st.phase === 'exam_running' || st.phase === 'exam_learning' || st.phase === 'exam_submitting') &&
      st.examOpenedAt &&
      now - st.examOpenedAt < lockMs
    ) {
      const left = Math.ceil((lockMs - (now - st.examOpenedAt)) / 1000);
      setPanel(
        summary +
          '\n考试流程中：' +
          (st.examTitle || '') +
          '\nphase=' +
          st.phase +
          '\n请勿重复开窗（锁' +
          left +
          's）\n可点「自动考试」强制解锁'
      );
      return true;
    }
    if (
      (st.phase === 'exam_running' || st.phase === 'exam_learning' || st.phase === 'exam_submitting') &&
      (!st.examOpenedAt || now - st.examOpenedAt >= lockMs)
    ) {
      st = saveState({
        phase: 'path_running',
        examOpenedAt: 0,
        allowOpenExam: true,
        lastAction: 'exam_timeout_unlock',
      });
    }

    const canExamAuto = !!(CFG.autoOpenExamFromPath || force || st.allowOpenExam);
    if (!canExamAuto) {
      setPanel(
        summary +
          '\n待考试 ' +
          examTodos.length +
          '\n自动考试：关\n请点面板「自动考试」'
      );
      return true;
    }

    const ansMap = loadAnswers();
    function hasReadyBank(x) {
      const bank = (x.examId && ansMap[x.examId]) || ansMap[normalizeQTitle(x.title)];
      return !!(bank && bank.ready && bank.questions && Object.keys(bank.questions).length);
    }

    // 优先：有时钟且无答案库 → 先看考试记录记答案
    // 其次：有答案库 → 正式开考（延迟≥1分钟）
    // 再次：无时钟 = 首次盲答（3s交白卷）
    const needLearn = examTodos.find((x) => x.hasExamHistory && !hasReadyBank(x));
    const readyExam = examTodos.find((x) => hasReadyBank(x));
    // 首次：无时钟图标
    const firstBlind = examTodos.find((x) => !x.hasExamHistory);
    const nextExam = readyExam || (!needLearn ? firstBlind || examTodos[0] : null);

    // 冷却：强制模式跳过；有答案库时开考冷却缩短
    if (!force) {
      const lastOpen = saneTs(st.lastExamOpenAt, now);
      const lastHist = saneTs(st.lastExamHistoryAt, now);
      const openCd = readyExam ? Math.min(CFG.examOpenCooldownMs || 45000, 15000) : CFG.examOpenCooldownMs || 45000;
      const histCd = readyExam ? 0 : CFG.examHistoryCooldownMs || 60000;
      const openLeft = lastOpen ? openCd - (now - lastOpen) : 0;
      const histLeft = lastHist && histCd > 0 ? histCd - (now - lastHist) : 0;
      if (openLeft > 0 || histLeft > 0) {
        const left = Math.ceil(Math.max(openLeft, histLeft) / 1000);
        Log('考试操作冷却中', { left: left, openLeft: openLeft, histLeft: histLeft, ready: !!readyExam });
        setPanel(summary + '\n待考试 ' + examTodos.length + '\n操作冷却中 ' + left + 's...\n可点「自动考试」跳过');
        return true;
      }
    }

    if (needLearn && !readyExam) {
      // 先写锁再点击，防止 pathLoop 下一次扫描重复点
      saveState({
        pathUrl: location.href,
        phase: 'exam_learning',
        examTitle: needLearn.title,
        examId: needLearn.examId || '',
        examOpenedAt: now,
        lastExamHistoryAt: now,
        examHasHistory: true,
        lastAction: 'open_exam_history',
        forceExamOnce: false,
        allowOpenExam: false,
      });
      setPanel(summary + '\n>>> 打开考试记录(时钟)\n课程：' + needLearn.title + '\n记忆标准答案后正式重考');
      LogA('打开考试记录', { title: needLearn.title, examId: needLearn.examId });
      setTimeout(function () {
        safeClick(needLearn.examHistoryLink || qs('.glyphicon-time', needLearn.row), '考试记录:' + needLearn.title);
      }, 800);
      return true;
    }

    if (!nextExam) {
      setPanel(summary + '\n等待考试记录页记忆答案...');
      return true;
    }

    // 无时钟图标 = 首次盲答；有答案库/有时钟 = 正式考
    const isFirstBlind = !nextExam.hasExamHistory && !hasReadyBank(nextExam);
    const mode = isFirstBlind ? 'blind' : 'known';
    const modeText = isFirstBlind
      ? '首次盲答(无时钟) 3s交白卷'
      : hasReadyBank(nextExam)
        ? '正式考试(有答案) ≥1分钟交卷'
        : '正式考试(有时钟) ≥1分钟交卷';
    saveState({
      pathUrl: location.href,
      phase: 'exam_running',
      examTitle: nextExam.title,
      examId: nextExam.examId || '',
      examOpenedAt: now,
      lastExamOpenAt: now,
      examMode: mode,
      examHasHistory: !!nextExam.hasExamHistory,
      lastAction: 'open_exam',
      allowOpenExam: false,
      forceExamOnce: false,
    });
    setPanel(summary + '\n>>> 点击「' + nextExam.status + '」\n' + nextExam.title + '\n' + modeText);
    LogA('路径开始考试', {
      status: nextExam.status,
      title: nextExam.title,
      examId: nextExam.examId,
      mode: mode,
      hasExamHistory: !!nextExam.hasExamHistory,
      modeText: modeText,
    });
    setTimeout(function () {
      safeClick(nextExam.btn, '考试:' + nextExam.status + ':' + nextExam.title);
    }, 1000);
    return true;
  }

  function pathLoop(forceOpen) {
    if (!document.body) return;
    installOpenGuard();
    installNavWatch();

    const st0 = loadState();
    saveState({
      pathUrl: location.href,
      phase:
        st0.phase === 'playing'
          ? 'playing'
          : st0.phase === 'course_done'
            ? 'course_done'
            : st0.phase === 'exam_running' || st0.phase === 'exam_learning'
              ? st0.phase
              : 'path_running',
    });

    // 未报名先点「我要学习」
    if (Date.now() - lastEnrollClickAt > 2500 && clickEnrollIfNeeded()) {
      lastEnrollClickAt = Date.now();
      LogA('路径页点击我要学习');
      return;
    }

    const list = scanPathCourses();
    if (!list.length) {
      setPanel('路径页：未扫到课程\n请确认已进入具体成长计划');
      LogW('路径页未扫到课程按钮');
      return;
    }

    // 视频课 todo：不是待考试/重新学习/开始考试/重新考试
    const videoList = list.filter((x) => !x.isExam && !/开始考试|重新考试|待考试/.test(x.status));
    const done = videoList.filter((x) => isPathDone(x.status));
    const todo = videoList.filter((x) => isPathTodo(x.status));
    const examTodos = list.filter((x) => x.needExam);
    const summary =
      '路径视频课 共' +
      videoList.length +
      ' | 已看完' +
      done.length +
      ' | 待学' +
      todo.length +
      ' | 待考试' +
      examTodos.length;
    Log('路径扫描', {
      total: list.length,
      video: videoList.length,
      done: done.length,
      todo: todo.length,
      exam: examTodos.length,
      todos: todo.map((x) => x.status + ':' + x.title).slice(0, 8),
      exams: examTodos.map((x) => x.status + ':' + x.title).slice(0, 8),
      forceOpen: !!forceOpen,
      autoOpenFromPath: CFG.autoOpenFromPath,
      autoExam: CFG.autoExam,
    });
    const st = loadState();

    // 刚完成一门：只清锁，不强制 reload
    if (st.phase === 'course_done') {
      LogA('一门课完成，准备开下一门', st.lastFinishedTitle || st.lastFinishedCourseId);
      saveState({
        phase: 'path_running',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'course_done_ack',
        allowOpenNext: true,
      });
      if (CFG.allowPathReload) {
        LogN('将执行 path reload（CFG.allowPathReload=true）');
        setPanel(summary + '\n刚完成一门，刷新列表后继续...');
        setTimeout(() => location.reload(), 1500);
        return;
      }
      setPanel(summary + '\n刚完成一门\n' + (CFG.autoOpenFromPath ? '将打开下一门' : '请点面板「开下一门」'));
    }

    if (hasLivePlayerLock(st)) {
      const ago = st.playerHeartbeatAt ? Math.round((Date.now() - st.playerHeartbeatAt) / 1000) : -1;
      setPanel(summary + '\n播放中：' + (st.activeTitle || st.activeCourseId) + '\n心跳 ' + ago + 's前 (只开1门)\n不会自动关标签');
      return;
    }

    // 心跳丢失：只清锁，不自动跳别的页
    if (st.phase === 'playing' && !hasLivePlayerLock(st)) {
      LogW('播放心跳丢失，允许重新开课', st.activeCourseId);
      saveState({
        phase: 'path_running',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'heartbeat_lost_retry',
        allowOpenNext: true,
      });
    }

    // 视频都学完 → 自动考试
    if (!todo.length) {
      if (pathTryExam(list, summary, forceOpen)) return;
      saveState({
        phase: 'path_done',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'path_all_done',
        allowOpenNext: false,
      });
      setPanel(summary + '\n本路径视频课已全部学完\n待考试也已处理完');
      return;
    }

    // 默认不自动开课：除非 CFG.autoOpenFromPath=true，或面板点了「开下一门」(forceOpen/forceOpenOnce)
    const st2 = loadState();
    const canAuto = !!(CFG.autoOpenFromPath || forceOpen || st2.forceOpenOnce);
    if (!canAuto) {
      setPanel(
        summary +
          '\n自动开课：关闭（防闪退/重定向）\n请手动点「开始/继续学习」\n或点面板「开下一门」\n考试可点「自动考试」'
      );
      return;
    }

    if (CFG.openNextOnlyAfterCourseDone && !forceOpen && !st2.forceOpenOnce && !st2.allowOpenNext) {
      const firstEntry = !st2.activeCourseId && !st2.lastFinishedCourseId && !st2.playerHeartbeatAt;
      if (!firstEntry && st2.phase === 'playing') {
        setPanel(summary + '\n等待当前播放页全部小视频「已完成」\n完成后才会开下一门');
        return;
      }
    }

    if (Date.now() - lastPathOpenAt < CFG.pathOpenCooldownMs) {
      setPanel(summary + '\n即将打开：' + todo[0].title + '\n(防抖中，防连环开课...)');
      Log('路径开课防抖中', { leftMs: CFG.pathOpenCooldownMs - (Date.now() - lastPathOpenAt) });
      return;
    }

    const next = todo[0];
    lastPathOpenAt = Date.now();
    saveState({
      pathUrl: location.href,
      activeCourseId: next.courseId || '',
      activeTitle: next.title,
      activeOpenedAt: Date.now(),
      playerHeartbeatAt: Date.now(),
      phase: 'playing',
      lastAction: 'open_course',
      allowOpenNext: false,
      forceOpenOnce: false,
    });
    setPanel(summary + '\n>>> 点击「' + next.status + '」\n课程：' + next.title + '\n(课内所有小视频都要「已完成」才算完)');
    LogA('路径开始学习', { status: next.status, title: next.title, courseId: next.courseId, forceOpen: !!forceOpen });
    safeClick(next.btn, '路径:' + next.status + ':' + next.title);
  }

  // ---------- 播放页：章节/视频完成判定（v5.4 之外的唯一附加） ----------
  let lastSrc = '';
  let lastTime = 0;
  let lastAdvanceAt = Date.now();
  let finishTriggered = false;
  let sectionClickAt = 0;

  function getVideo() {
    return document.querySelector('video');
  }

  function sectionItems() {
    // 真实目录项：.course-list__item（现场 DOM 已验证）
    let items = qsa('.course-list__item');
    if (!items.length) {
      items = qsa('.catalog-item, .course-catalog-item, .section-item');
    }
    return items.filter((el) => {
      const t = text(el);
      if (!t || t.length > 220) return false;
      return (
        t.includes('.mp4') ||
        t.includes('上次学习') ||
        t.includes('学习中') ||
        t.includes('已完成') ||
        t.includes('未完成') ||
        /\d{2}:\d{2}(:\d{2})?/.test(t)
      );
    });
  }

  function sectionStats() {
    const items = sectionItems();
    let done = 0;
    let unfinished = 0;
    items.forEach((el) => {
      const statusEl = el.querySelector('.category-info__status, .status');
      const statusText = text(statusEl);
      const cls = (statusEl && statusEl.className) || '';
      const rowText = text(el);
      // 现场对照：
      // - 已看完课：status=已完成 + class 含 completed（不是 incomplete）
      // - 未看完：学习中 / 未开始 / 未完成 / incomplete
      // 注意：incomplete 字符串里含 complete，不能用 /complete/ 粗匹配
      const isComplete =
        statusText === '已完成' ||
        statusText === '已学完' ||
        ((/completed|finished/.test(cls) || /\bcomplete\b/.test(cls)) && !/incomplete/.test(cls)) ||
        (/已完成|已学完/.test(rowText) && !/未完成|学习中|未开始|incomplete/.test(rowText + ' ' + cls));
      if (isComplete) done += 1;
      else unfinished += 1;
    });
    return { total: items.length, done: done, unfinished: unfinished, items: items };
  }

  function isVideoFinished(video) {
    if (!video) return false;
    if (video.ended) return true;
    const d = video.duration || 0;
    const t = video.currentTime || 0;
    // 接近片尾（1.5s 内）视为完成
    if (d > 0 && t > 0 && d - t < 1.5) return true;
    return false;
  }

  function isSectionComplete(el) {
    if (!el) return false;
    const statusEl = el.querySelector('.category-info__status, .status');
    const statusText = text(statusEl);
    const cls = (statusEl && statusEl.className) || '';
    if (statusText === '已完成' || statusText === '已学完') return true;
    if ((/completed|finished/.test(cls) || /\bcomplete\b/.test(cls)) && !/incomplete/.test(cls)) return true;
    return false;
  }

  function clickNextSectionIfNeeded(video) {
    if (!video || !isVideoFinished(video)) return false;
    if (Date.now() - sectionClickAt < 3000) return false;

    const items = sectionItems();
    if (!items.length) return false;

    // 找当前「学习中/上次学习/active」项，再找其后第一个非「已完成」小视频
    let currentIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const t = text(items[i]);
      const active = /active/.test(items[i].className || '');
      if (active || t.includes('学习中') || t.includes('上次学习') || t.includes('未开始')) {
        // 优先 active；否则第一个学习中/上次学习
        if (active || currentIdx < 0) currentIdx = i;
        if (active) break;
      }
    }

    const start = currentIdx >= 0 ? currentIdx + 1 : 0;
    for (let i = start; i < items.length; i++) {
      const el = items[i];
      if (isSectionComplete(el)) continue;
      const t = text(el);
      const clickable =
        el.querySelector('.category-name, .course-list__item__right, a, button, .title, .name') || el;
      Log('切下一小视频', t.slice(0, 60));
      sectionClickAt = Date.now();
      lastAdvanceAt = Date.now();
      lastTime = 0;
      lastSrc = '';
      safeClick(clickable, '下一小视频');
      setPanel('当前小视频播完\n>>> 切换下一小视频\n' + t.slice(0, 50) + '\n未全部「已完成」前不换下一门课');
      return true;
    }
    // 若当前后面没有，再从头找第一个未完成
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (isSectionComplete(el)) continue;
      const t = text(el);
      const clickable =
        el.querySelector('.category-name, .course-list__item__right, a, button, .title, .name') || el;
      Log('切未完成小视频', t.slice(0, 60));
      sectionClickAt = Date.now();
      lastAdvanceAt = Date.now();
      lastTime = 0;
      lastSrc = '';
      safeClick(clickable, '未完成小视频');
      setPanel('还有未完成小视频\n>>> ' + t.slice(0, 50) + '\n全部「已完成」后才换下一门课');
      return true;
    }
    return false;
  }

  // 严格规则：课内每一个小视频都必须是「已完成」才允许换下一门课
  function isCourseFullyDone() {
    const stats = sectionStats();
    if (stats.total <= 0) return false;
    return stats.unfinished === 0 && stats.done === stats.total;
  }

  function finishCurrentCourse(reason) {
    if (finishTriggered) return;
    // 二次校验：目录未全部「已完成」绝不离开
    if (!isCourseFullyDone()) {
      Log('拒绝提前完课（仍有未完成小视频）', sectionStats());
      finishTriggered = false;
      return;
    }
    finishTriggered = true;
    const cid = courseIdFromUrl(location.href) || loadState().activeCourseId || '';
    const st = loadState();
    const finished = Array.isArray(st.finishedCourseIds) ? st.finishedCourseIds.slice() : [];
    if (cid && !finished.includes(cid)) finished.push(cid);
    saveState({
      phase: 'course_done',
      lastFinishedCourseId: cid,
      lastFinishedTitle: st.activeTitle || document.title,
      finishedCourseIds: finished,
      activeCourseId: '',
      activeTitle: '',
      playerHeartbeatAt: 0,
      lastAction: 'finish:' + reason,
      allowOpenNext: true,
    });
    Log('课程完成', reason + ' ' + cid);
    setPanel(
      '本课全部小视频已「已完成」\n' +
        reason +
        '\n' +
        CFG.doneWaitMs / 1000 +
        's 后回路径页开下一门\n不会关闭标签'
    );
    setTimeout(() => {
      // 绝不 window.close
      const pathUrl = loadState().pathUrl;
      if (pathUrl) {
        try {
          location.href = pathUrl;
          return;
        } catch (e) {}
      }
      if (CFG.allowHistoryBack) {
        try {
          history.back();
        } catch (e2) {}
      } else {
        setPanel('本课已完成，但没有路径页地址\n请手动回到成长计划路径页');
      }
    }, CFG.doneWaitMs);
  }

  function playerAdvanceTick() {
    if (!document.body) return;
    const video = getVideo();
    const stats = sectionStats();
    const cid = courseIdFromUrl(location.href);

    // 心跳：告诉路径页「有课在播，别再开一门」
    saveState({
      phase: 'playing',
      activeCourseId: cid || loadState().activeCourseId || '',
      activeOpenedAt: loadState().activeOpenedAt || Date.now(),
      activeTitle: loadState().activeTitle || document.title,
      pathUrl: loadState().pathUrl || '',
      playerHeartbeatAt: Date.now(),
      lastAction: 'player_heartbeat',
      allowOpenNext: false,
    });

    // 跟踪 src 变化（切章后）
    if (video) {
      const src = video.currentSrc || video.src || '';
      const t = video.currentTime || 0;
      if (src && src !== lastSrc) {
        lastSrc = src;
        lastTime = t;
        lastAdvanceAt = Date.now();
        finishTriggered = false;
      } else if (!video.paused && Math.abs(t - lastTime) > 0.2) {
        lastTime = t;
        lastAdvanceAt = Date.now();
      }
    }

    // 1) 当前小视频播完 → 只切课内下一视频，绝不因此离开课程
    if (video && isVideoFinished(video)) {
      const switched = clickNextSectionIfNeeded(video);
      if (switched) {
        setPanel(
          '当前小视频播完\n已切下一视频\n目录完成 ' +
            stats.done +
            '/' +
            (stats.total || '?') +
            '\n必须全部「已完成」才换下一门课'
        );
        return;
      }
      // 找不到下一节时：只有目录全部「已完成」才完课
      if (isCourseFullyDone()) {
        finishCurrentCourse('全部小视频已完成 ' + stats.done + '/' + stats.total);
      } else {
        setPanel(
          '当前视频结束，但目录仍有未完成\n完成 ' +
            stats.done +
            '/' +
            (stats.total || '?') +
            ' 未完成' +
            (stats.unfinished || 0) +
            '\n等待状态变「已完成」或手动点下一节\n不会离开本课'
        );
      }
      return;
    }

    // 2) 目录全部「已完成」→ 才回路径开下一课
    if (isCourseFullyDone()) {
      finishCurrentCourse('目录全部已完成 ' + stats.done + '/' + stats.total);
      return;
    }

    const playState = video
      ? 'video: paused=' +
        video.paused +
        ' t=' +
        (video.currentTime || 0).toFixed(1) +
        '/' +
        (video.duration || 0).toFixed(0) +
        ' mute=' +
        video.muted
      : 'video: 未找到';
    setPanel(
      '播放页 = v5.4 原逻辑\n' +
        (document.title || '').slice(0, 28) +
        '\n小视频完成 ' +
        stats.done +
        '/' +
        (stats.total || '?') +
        ' 未完成' +
        (stats.unfinished || 0) +
        '\n' +
        playState +
        '\n规则：全部已完成才换下一门课\n不会关标签/不会乱跳'
    );
  }

  // ---------- 学习列表页（可选，默认关闭自动点计划） ----------
  function studyHintLoop() {
    setPanel(
      '我的学习页\n请手动进入：专属成长计划 → 具体任务\n（例如：集团财务条线…）\n进入路径后脚本会自动开未学完课程'
    );
  }

  // ---------- 自动考试 ----------
  let examSubmitStarted = false;
  let examAnsweredAt = 0;
  let examResultHandled = false;
  let examAnswering = false;
  let examAnswerProgress = { idx: 0, matched: 0, blind: 0, total: 0 };
  let lastModalActionAt = 0;
  let lastModalKind = '';

  function examIdFromUrl(url) {
    const m = String(url || location.href).match(/exam\/(?:train|result)-nf\/([0-9a-zA-Z]+)/);
    return m ? m[1] : '';
  }

  function getExamTitle() {
    const h = qs('h1, h2, h3, .exam-title, .paper-title, .title');
    const t = text(h) || document.title || '';
    return t.replace(/【课后考试】/g, '').trim().slice(0, 80);
  }

  function collectExamItems() {
    return qsa('dl.test-item');
  }

  function clickOptionByLetters(item, letters) {
    if (!item || !letters || !letters.length) return 0;
    const want = letters.map((x) => String(x).trim());
    let hit = 0;
    const labels = qsa('div.choice label, .choice label', item);
    labels.forEach((lab) => {
      const t = text(lab).trim();
      const letter = t.match(/^([A-D])$/) ? t : /正确|错误/.test(t) ? t : '';
      if (want.some((w) => w === letter || w === t)) {
        const input = qs('input', lab);
        if (input && !input.checked) {
          try {
            lab.click();
          } catch (e) {
            try {
              input.click();
            } catch (e2) {}
          }
        } else if (input && input.checked) {
          // already
        } else {
          safeClick(lab, '选项:' + t);
        }
        hit += 1;
      }
    });
    // 多选可能点 option 文本
    if (!hit) {
      qsa('div.option', item).forEach((opt) => {
        const L = optionLetterFromText(text(opt));
        if (L && want.includes(L)) {
          safeClick(opt, 'option:' + L);
          hit += 1;
        }
      });
    }
    return hit;
  }

  function buildGlobalQuestionBank() {
    const ansMap = loadAnswers();
    const qBank = {};
    Object.keys(ansMap).forEach((k) => {
      const bank = ansMap[k];
      if (!bank || !bank.questions) return;
      Object.keys(bank.questions).forEach((qk) => {
        if (!qBank[qk]) qBank[qk] = bank.questions[qk];
      });
    });
    return qBank;
  }

  function answerOneItem(item, qBank) {
    const title = text(qs('dt h5', item) || qs('h5', item));
    const qKey = normalizeQTitle(title);
    let known = qBank[qKey];
    if (!known) {
      const keys = Object.keys(qBank);
      for (let i = 0; i < keys.length; i++) {
        if (qKey.includes(keys[i].slice(0, 24)) || keys[i].includes(qKey.slice(0, 24))) {
          known = qBank[keys[i]];
          break;
        }
      }
    }
    const radios = qsa('input[type=radio]', item);
    const checks = qsa('input[type=checkbox]', item);
    if (known && known.letters && known.letters.length) {
      const n = clickOptionByLetters(item, known.letters);
      if (n > 0) return 'matched';
    }
    if (radios.length) {
      const lab = radios[0].closest('label') || radios[0];
      try {
        lab.click();
      } catch (e) {
        try {
          radios[0].click();
        } catch (e2) {}
      }
    } else if (checks.length) {
      const lab = checks[0].closest('label') || checks[0];
      try {
        lab.click();
      } catch (e) {
        try {
          checks[0].click();
        } catch (e2) {}
      }
    }
    return known ? 'matched' : 'blind';
  }

  // 逐题慢速答题；完成后才设 examAnsweredAt
  function tickSlowAnswer() {
    if (examAnswering) return false;
    if (examAnsweredAt) return true;
    const items = collectExamItems();
    if (!items.length) return false;

    const st = loadState();
    const examId = examIdFromUrl() || st.examId || '';
    const examTitle = getExamTitle() || st.examTitle || '';
    const ansMap = loadAnswers();
    const bank = (examId && ansMap[examId]) || ansMap[normalizeQTitle(examTitle)] || { questions: {} };
    const qBank = Object.assign({}, buildGlobalQuestionBank(), bank.questions || {});

    if (!examAnswerProgress.total) {
      examAnswerProgress = {
        idx: 0,
        matched: 0,
        blind: 0,
        total: items.length,
        examId: examId,
        examTitle: examTitle,
        hasBank: !!(bank && bank.ready),
      };
      examAnswering = true;
      LogA('开始答题', {
        total: items.length,
        gapMs: currentExamAnswerGapMs(),
        submitDelayMs: currentExamSubmitDelayMs(),
        mode: loadState().examMode,
        hasHistory: loadState().examHasHistory,
      });
    }

    const i = examAnswerProgress.idx;
    if (i >= items.length) {
      examAnswering = false;
      examAnsweredAt = Date.now();
      examSubmitStarted = false;
      const st0 = loadState();
      // 保留路径页写入的 examMode/examHasHistory；仅在完全未知时兜底
      const keepMode = st0.examMode || (examAnswerProgress.matched > 0 ? 'known' : 'blind');
      saveState({
        phase: 'exam_running',
        examId: examAnswerProgress.examId || examId,
        examTitle: examAnswerProgress.examTitle || examTitle,
        examOpenedAt: st0.examOpenedAt || Date.now(),
        lastAction: keepMode === 'known' ? 'exam_answer_known' : 'exam_answer_blind',
        examMode: keepMode,
        examHasHistory: st0.examHasHistory,
      });
      LogA('考试答题完成', Object.assign({}, examAnswerProgress, { submitDelayMs: currentExamSubmitDelayMs() }));
      setPanel(
        '考试页：已答完\n共' +
          examAnswerProgress.total +
          ' 命中' +
          examAnswerProgress.matched +
          ' 盲答' +
          examAnswerProgress.blind +
          '\n模式：' +
          (keepMode === 'blind' ? '首次盲答' : '正式考试') +
          '\n' +
          Math.round(currentExamSubmitDelayMs() / 1000) +
          's 后交卷'
      );
      return true;
    }

    examAnswering = true;
    const kind = answerOneItem(items[i], qBank);
    if (kind === 'matched') examAnswerProgress.matched += 1;
    else examAnswerProgress.blind += 1;
    examAnswerProgress.idx += 1;
    const delaySec = Math.round(currentExamSubmitDelayMs() / 1000);
    setPanel(
      '考试答题中...\n' +
        examAnswerProgress.idx +
        '/' +
        examAnswerProgress.total +
        ' 命中' +
        examAnswerProgress.matched +
        ' 盲答' +
        examAnswerProgress.blind +
        '\n答完后 ' +
        delaySec +
        's 交卷'
    );
    setTimeout(function () {
      examAnswering = false;
    }, currentExamAnswerGapMs());
    return false;
  }

  function findVisibleModalButton(names) {
    const btns = qsa('button, a.btn, .btn, .modal .btn, #v40confirm, #v40cancel');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isVisible(b) && !(b.offsetParent || (b.getClientRects && b.getClientRects().length))) continue;
      const t = text(b);
      if (names.some((n) => t === n || t.includes(n))) return b;
    }
    // id shortcuts
    const byId = qs('#v40confirm');
    if (byId && names.some((n) => n === '确认' || n === '确定')) return byId;
    return null;
  }

  function handleExamModals() {
    // 弹窗操作节流：避免反复点确认/关闭
    if (lastModalActionAt && Date.now() - lastModalActionAt < (CFG.examModalWaitMs || 2500)) {
      return lastModalKind || 'wait';
    }
    const confirmBtn = findVisibleModalButton(['确认', '确定']);
    const modalText = qsa('.modal, .modal-dialog, [role=dialog]')
      .filter((m) => isVisible(m) || getComputedStyle(m).display === 'block')
      .map((m) => text(m))
      .join(' ');
    if (confirmBtn && /交卷|提交|无法更改|是否确定/.test(modalText + text(confirmBtn.parentElement || document.body))) {
      LogA('考试确认交卷弹窗', modalText.slice(0, 80));
      lastModalActionAt = Date.now();
      lastModalKind = 'confirm';
      // 稍等再点确认，别秒点
      setTimeout(function () {
        safeClick(confirmBtn, '确认交卷');
      }, 1200);
      return 'confirm';
    }
    // 结果弹窗：通过/未通过
    if (/通过考试|未通过考试|得分为|恭喜|遗憾/.test(modalText)) {
      const closeBtn = findVisibleModalButton(['关闭']);
      const failed = /未通过|遗憾|不及格/.test(modalText);
      LogA('考试结果弹窗', modalText.slice(0, 100));
      lastModalActionAt = Date.now();
      lastModalKind = 'result_close';
      saveState({
        lastAction: 'exam_result_modal',
        lastExamResultText: modalText.slice(0, 120),
        examPhase: failed ? 'failed' : 'passed',
        phase: failed ? 'exam_failed' : 'exam_passed',
        // 保持锁一会儿，避免路径页立刻又开
        examOpenedAt: Date.now(),
        allowOpenExam: true,
        lastExamOpenAt: Date.now(),
      });
      if (closeBtn) {
        setTimeout(function () {
          safeClick(closeBtn, '关闭结果');
        }, 1500);
        // 慢一点再回路径
        setTimeout(function () {
          const pathUrl = loadState().pathUrl;
          if (pathUrl && pageType() === 'exam') {
            try {
              location.href = pathUrl;
            } catch (e) {}
          }
        }, CFG.examResultReturnMs || 8000);
        return 'result_close';
      }
    }
    // 通用关闭
    const close2 = findVisibleModalButton(['关闭']);
    if (close2 && modalText) {
      lastModalActionAt = Date.now();
      lastModalKind = 'close';
      setTimeout(function () {
        safeClick(close2, '关闭弹窗');
      }, 1000);
      return 'close';
    }
    return '';
  }

  function submitExamPaper() {
    const btn =
      qs('#v36submitBtn') ||
      qsa('button').find((b) => text(b).includes('我要交卷'));
    if (!btn) {
      LogW('未找到我要交卷按钮');
      return false;
    }
    if (!isVisible(btn) && btn.offsetParent === null) {
      return false;
    }
    LogA('点击我要交卷');
    saveState({ phase: 'exam_submitting', lastAction: 'click_submit' });
    safeClick(btn, '我要交卷');
    return true;
  }

  function examLoop() {
    if (!document.body || !CFG.autoExam) return;
    // SPA：已离开考试页则停
    if (pageType() !== 'exam') return;
    if (examPageMode && examPageMode !== 'exam') return;
    // 进入正式考试页时，取消结果页可能残留的回跳定时器
    clearExamResultReturnTimer();

    ensurePanel();
    installNavWatch();
    installOpenGuard();

    // 先处理弹窗
    const modalAct = handleExamModals();
    if (modalAct === 'result_close' || modalAct === 'close' || modalAct === 'wait') {
      setPanel('考试结果/弹窗处理中...\n请稍候，勿重复开窗');
      return;
    }
    if (modalAct === 'confirm') {
      setPanel('已点确认交卷\n等待评分结果...');
      return;
    }

    const items = collectExamItems();
    if (!items.length) {
      setPanel('考试页：等待试卷加载...');
      return;
    }

    const submitBtn = qs('#v36submitBtn') || qsa('button').find((b) => text(b).includes('我要交卷'));
    const submitVisible = submitBtn && (isVisible(submitBtn) || submitBtn.offsetParent !== null);

    // 慢速逐题答题
    if (!examAnsweredAt) {
      tickSlowAnswer();
      return;
    }

    const submitDelay = currentExamSubmitDelayMs();
    if (!examSubmitStarted && Date.now() - examAnsweredAt >= submitDelay) {
      if (submitVisible) {
        examSubmitStarted = true;
        submitExamPaper();
        setPanel('已点「我要交卷」\n等待确认弹窗...');
      } else {
        setPanel('试卷已提交或按钮不可见\n等待结果弹窗...');
      }
    } else if (!examSubmitStarted) {
      const left = Math.ceil((submitDelay - (Date.now() - examAnsweredAt)) / 1000);
      const stMode = loadState().examMode === 'blind' ? '首次盲答' : '正式考试';
      setPanel('已答完，倒计时交卷\n模式：' + stMode + '\n剩余 ' + left + 's / ' + Math.round(submitDelay / 1000) + 's');
    } else {
      setPanel('交卷流程中...\n处理确认/结果弹窗');
    }
  }

  function learnAnswersFromResultPage() {
    const items = collectExamItems();
    if (!items.length) return { count: 0 };
    const st = loadState();
    const examId = examIdFromUrl() || st.examId || '';
    const examTitle = getExamTitle() || st.examTitle || '';
    const titleKey = normalizeQTitle(examTitle);
    const ansMap = loadAnswers();
    const bank = ansMap[examId] || ansMap[titleKey] || { questions: {}, ready: false };
    bank.questions = bank.questions || {};
    bank.examId = examId || bank.examId || '';
    bank.examTitle = examTitle || bank.examTitle || '';
    bank.updatedAt = Date.now();
    let count = 0;

    items.forEach((item) => {
      const title = text(qs('dt h5', item) || qs('h5', item));
      const qKey = normalizeQTitle(title);
      const ansDd = qs('dd.answer', item);
      const ansText = text(ansDd);
      let letters = parseAnswerLetters(ansText);
      if (!letters.length) {
        const green = text(qs('p.green, .green', item));
        letters = parseAnswerLetters(green || ansText);
      }
      if (!letters.length) return;
      // 多选：标准答案可能是 AB / A,B
      const options = qsa('div.option', item).map((o) => text(o));
      bank.questions[qKey] = {
        title: title.slice(0, 200),
        letters: letters,
        options: options.slice(0, 8),
      };
      count += 1;
    });

    if (count > 0) {
      bank.ready = true;
      bank.questionCount = count;
      if (examId) ansMap[examId] = bank;
      if (titleKey) ansMap[titleKey] = bank;
      // 也用课程标题粗 key
      if (st.examTitle) ansMap[normalizeQTitle(st.examTitle)] = bank;
      saveAnswers(ansMap);
    }
    return { count: count, examId: examId, examTitle: examTitle, bank: bank };
  }

  let examResultReturnTimer = null;
  let examPageMode = ''; // 'exam' | 'exam_result' | ''  当前标签实际应跑的模式

  function clearExamResultReturnTimer() {
    if (examResultReturnTimer) {
      try {
        clearTimeout(examResultReturnTimer);
      } catch (e) {}
      examResultReturnTimer = null;
    }
  }

  function safeReturnToPathFromResult(reason) {
    // 仅当当前仍是结果页时才跳回，避免正式考试被误关
    if (pageType() !== 'exam_result') {
      LogW('取消回路径：当前已不是结果页', { reason: reason, href: location.href, type: pageType() });
      return;
    }
    const pathUrl = loadState().pathUrl;
    LogA('结果页回路径', { reason: reason, pathUrl: pathUrl });
    if (pathUrl) {
      try {
        location.href = pathUrl;
        return;
      } catch (e) {}
    }
    try {
      history.back();
    } catch (e2) {
      setPanel('答案已记，请手动回路径页点「重新考试」');
    }
  }

  function examResultLoop() {
    if (!document.body || !CFG.autoExam) return;
    // SPA：若已离开结果页，立刻停手（关键修复：不再把正式考试页踢回路径）
    if (pageType() !== 'exam_result') {
      clearExamResultReturnTimer();
      return;
    }
    if (examPageMode && examPageMode !== 'exam_result') return;

    ensurePanel();
    installNavWatch();

    // 关闭可能残留弹窗
    handleExamModals();

    if (examResultHandled) {
      setPanel('答案已记忆，等待返回路径页重考...');
      return;
    }

    const items = collectExamItems();
    // 结果页有时先出成绩表、后渲染题目
    if (!items.length) {
      // 若 localStorage 已有本卷答案，直接回路径（仍须确认仍在结果页）
      const eid = examIdFromUrl();
      const ansMap = loadAnswers();
      if (eid && ansMap[eid] && ansMap[eid].ready) {
        examResultHandled = true;
        saveState({
          phase: 'exam_learned',
          examId: eid,
          allowOpenExam: true,
          lastAction: 'exam_already_learned',
          // 注意：不要刷新 lastExamOpenAt 成“刚开考”，否则路径页会误判冷却/锁
          lastExamHistoryAt: Date.now(),
          examOpenedAt: 0,
        });
        setPanel('本卷答案库已存在\n' + Math.round((CFG.examResultReturnMs || 8000) / 1000) + 's后回路径重考');
        clearExamResultReturnTimer();
        examResultReturnTimer = setTimeout(function () {
          safeReturnToPathFromResult('already_learned');
        }, CFG.examResultReturnMs || 8000);
        return;
      }
      setPanel('考试结果页：等待题目/答案加载...');
      return;
    }

    const learned = learnAnswersFromResultPage();
    if (!learned.count) {
      setPanel('结果页题目已出，但未解析到标准答案\n稍后重试...');
      return;
    }
    examResultHandled = true;
    LogA('已从结果页记忆答案', learned);
    saveState({
      phase: 'exam_learned',
      examId: learned.examId || loadState().examId || '',
      examTitle: learned.examTitle || loadState().examTitle || '',
      lastAction: 'exam_learn_answers',
      allowOpenExam: true,
      examPhase: 'learned',
      // 记答案完成：解开 exam 锁，允许路径页正式开考；仅保留 history 冷却
      examOpenedAt: 0,
      lastExamHistoryAt: Date.now(),
      // 不写 lastExamOpenAt，避免挡住紧接着的正式开考
    });
    setPanel(
      '考试结果：已记忆答案\n题目数 ' +
        learned.count +
        '\n' +
        (learned.examTitle || '') +
        '\n' +
        Math.round((CFG.examResultReturnMs || 8000) / 1000) +
        's后回路径页正式重考'
    );

    clearExamResultReturnTimer();
    examResultReturnTimer = setTimeout(function () {
      safeReturnToPathFromResult('learned');
    }, CFG.examResultReturnMs || 8000);
  }

  // =========================
  // 启动
  // =========================
  function boot() {
    const type = pageType();
    installNavWatch();
    LogA('自动看课助手 v' + VER + ' 启动', {
      type: type,
      href: location.href,
      title: document.title,
      cfg: {
        autoOpenFromPath: CFG.autoOpenFromPath,
        autoReturnToPath: CFG.autoReturnToPath,
        closePlayerWhenDone: CFG.closePlayerWhenDone,
        minStayBeforeFinishMs: CFG.minStayBeforeFinishMs,
        autoExam: CFG.autoExam,
        autoOpenExamFromPath: CFG.autoOpenExamFromPath,
      },
      state: loadState(),
    });
    ensurePanel();

    if (type === 'study') {
      setPanel('页面：我的学习\n请点「专属成长计划」并进入具体任务\n脚本不会替你乱点计划卡片\n可点「复制日志」');
      setInterval(studyHintLoop, 8000);
      return;
    }

    if (type === 'path') {
      setPanel(
        '路径页 v' +
          VER +
          '\n待考试/开始考试/重新考试=需考\n无时钟=首次盲答3s\n有时钟=看答案后正式考≥1分钟\n自动开课：' +
          (CFG.autoOpenFromPath ? '开' : '关') +
          ' 自动考试：' +
          (CFG.autoExam ? '开' : '关')
      );
      setTimeout(function () { pathLoop(false); }, 800);
      setTimeout(function () { pathLoop(false); }, 2000);
      setInterval(function () { pathLoop(false); }, CFG.pathScanMs);
      window.addEventListener('hashchange', () => setTimeout(function () { pathLoop(false); }, 800));
      return;
    }

    if (type === 'player') {
      // 1) 严格加载你验证过的 v5.4
      installV54PlayerCore();
      // 2) 仅附加：播完判定与下一课编排（默认不自动回路径）
      setInterval(playerAdvanceTick, CFG.playerAdvanceMs);
      setPanel(
        '播放页已加载 v5.4 原逻辑\n附加：播完切下一小视频\n全部「已完成」才算完课\n禁止自动回跳路径\n可点「复制日志」'
      );
      Log('播放页编排已启动', { autoReturnToPath: CFG.autoReturnToPath });
      return;
    }

    if (type === 'exam' || type === 'exam_result') {
      // 统一挂载：SPA 下 result ↔ train 会在同一标签切换，必须按 pageType 分流
      examPageMode = type;
      examSubmitStarted = false;
      examAnsweredAt = 0;
      examAnswering = false;
      examAnswerProgress = { idx: 0, matched: 0, blind: 0, total: 0 };
      examResultHandled = false;
      lastModalActionAt = 0;
      lastModalKind = '';
      clearExamResultReturnTimer();

      if (type === 'exam') {
        setPanel(
          '考试页 v' +
            VER +
            '\n首次盲答(无时钟): 3s交白卷\n正式考试(有时钟/答案): ≥' +
            Math.round((CFG.examFormalSubmitDelayMs || 65000) / 1000) +
            's交卷\n单窗口防刷'
        );
      } else {
        setPanel('考试结果页 v' + VER + '\n读取标准答案并记忆\n慢速回路径');
      }

      function examUnifiedTick() {
        const t = pageType();
        if (t === 'exam') {
          if (examPageMode !== 'exam') {
            // 从结果页切到正式考试：重置答题状态，并取消结果页回跳
            examPageMode = 'exam';
            examSubmitStarted = false;
            examAnsweredAt = 0;
            examAnswering = false;
            examAnswerProgress = { idx: 0, matched: 0, blind: 0, total: 0 };
            lastModalActionAt = 0;
            lastModalKind = '';
            clearExamResultReturnTimer();
            LogA('SPA切换：结果页→正式考试页，停止结果回跳');
          }
          examLoop();
        } else if (t === 'exam_result') {
          if (examPageMode !== 'exam_result') {
            examPageMode = 'exam_result';
            examResultHandled = false;
            LogA('SPA切换：进入考试结果页');
          }
          examResultLoop();
        } else if (t === 'path') {
          examPageMode = '';
          clearExamResultReturnTimer();
        }
      }

      setTimeout(examUnifiedTick, type === 'exam' ? 3000 : 2500);
      setInterval(examUnifiedTick, CFG.examScanMs);
      window.addEventListener('hashchange', function () {
        const t = pageType();
        LogN('exam标签 hashchange', { type: t, href: location.href });
        if (t === 'exam') {
          examPageMode = 'exam';
          examSubmitStarted = false;
          examAnsweredAt = 0;
          examAnswering = false;
          examAnswerProgress = { idx: 0, matched: 0, blind: 0, total: 0 };
          lastModalActionAt = 0;
          lastModalKind = '';
          clearExamResultReturnTimer();
          setTimeout(examUnifiedTick, 3000);
        } else if (t === 'exam_result') {
          examPageMode = 'exam_result';
          examResultHandled = false;
          setTimeout(examUnifiedTick, 2500);
        } else {
          examPageMode = '';
          clearExamResultReturnTimer();
        }
      });
      return;
    }

    setPanel('当前页非路径/播放/考试页\n请打开成长计划路径或课程播放页');
  }

  function startWhenReady() {
    if (document.body) boot();
    else {
      const iv = setInterval(() => {
        if (document.body) {
          clearInterval(iv);
          boot();
        }
      }, 50);
      document.addEventListener('DOMContentLoaded', () => {
        clearInterval(iv);
        boot();
      });
    }
  }

  startWhenReady();
})();
