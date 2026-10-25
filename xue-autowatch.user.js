// ==UserScript==
// @name         阳光学堂自动看视频助手
// @namespace    http://tampermonkey.net/
// @version      11.9.3
// @description  合并版：自动看课+内置倍速引擎(面板可选 关/2/4/8/16x，仅播放页生效)；片尾最后8秒自动降1倍速自然播完+等平台确认完成(根治来回跳)；一键自动学习(跨页面带路+列表页直接判断未完成任务)；自动考试开关全局持久化。仅测试自用。
// @author       You
// @match        https://xue.sinosig.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/hsy66/metaphysics/main/xue-autowatch.user.js
// @downloadURL  https://raw.githubusercontent.com/hsy66/metaphysics/main/xue-autowatch.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 防止重复注入
  if (window.__xueAutoWatchV10Loaded) {
    console.log('[学堂助手] 已加载，跳过重复注入');
    return;
  }
  window.__xueAutoWatchV10Loaded = true;

  const VER = '11.9.3';
  const TAG = '[学堂助手]';
  const STORE_KEY = 'xue_auto_watch_v10';
  const LOG_KEY = 'xue_auto_watch_v10_logs';
  const ANS_KEY = 'xue_auto_exam_answers_v10';
  const BOOT_AT = realNow();
  const PAGE_ID = Math.random().toString(36).slice(2, 8);
  // 跨标签真实时钟：16倍速脚本会把播放页的 Date.now 改快，导致各标签时间戳不可比
  // （心跳/冷却/租约全部错乱）。16倍速脚本会在 window.__xueRealNow 暴露真实时间；
  // 未开启倍速脚本时退回 Date.now（本页没被加速，同样是真实时间）。
  function realNow() {
    try {
      if (typeof window.__xueRealNow === 'function') return window.__xueRealNow();
    } catch (e) {}
    return Date.now();
  }
  // 本标签启动时的页面类型（SPA 类型切换检测用）
  let bootPageType = '';

  // =====================================================================
  // 内置倍速引擎（由独立「16倍速」脚本合并而来，v11.0.0 起无需单独安装）
  // - 仅在课程播放页挂钩计时器/Date：路径/考试/结果页保持原生节奏，
  //   不干扰考试的答题间隔与≥1分钟交卷延迟，也不打乱脚本冷却判断
  // - 面板可选 关/2/4/8/16x，选择存 localStorage（跨标签即时生效）
  // - 片尾最后8秒由播放编排层通过 speedTailOverride 联动降为1倍速自然播完
  // =====================================================================
  const SPEED_KEY = 'xue_speed_cfg_v11';
  let speedInstalled = false;
  let speedOrigSetInterval = null;
  let speedOrigSetTimeout = null;
  let speedOrigDateNow = null;
  // >0 时视频临时用该倍速（片尾1倍速自然播完），优先于用户设置
  let speedTailOverride = 0;

  function loadSpeedCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(SPEED_KEY));
      if (c && typeof c === 'object') return { on: !!c.on, rate: Number(c.rate) || 16 };
    } catch (e) {}
    return { on: true, rate: 16 };
  }
  function saveSpeedCfg(c) {
    try {
      localStorage.setItem(SPEED_KEY, JSON.stringify(c));
    } catch (e) {}
    return c;
  }
  function getSpeedRate() {
    const c = loadSpeedCfg();
    return c.on ? c.rate : 0;
  }
  function isPlayerUrl() {
    return /courseDetail\//.test(location.href);
  }
  function currentTargetRate() {
    if (speedTailOverride > 0) return speedTailOverride;
    const r = getSpeedRate();
    return r > 0 ? r : 1;
  }

  function installSpeedHooks() {
    if (speedInstalled) return;
    speedInstalled = true;
    speedOrigSetInterval = window.setInterval.bind(window);
    speedOrigSetTimeout = window.setTimeout.bind(window);
    speedOrigDateNow = Date.now.bind(Date);
    // 计时器加速：倍速选择动态读取，改设置不用重挂
    window.setInterval = function (fn, delay, ...args) {
      if (typeof delay === 'number' && delay > 0) {
        const r = getSpeedRate();
        if (r > 0) delay = Math.max(1, Math.floor(delay / r));
      }
      return speedOrigSetInterval(fn, delay, ...args);
    };
    window.setTimeout = function (fn, delay, ...args) {
      if (typeof delay === 'number' && delay > 0) {
        const r = getSpeedRate();
        if (r > 0) delay = Math.max(1, Math.floor(delay / r));
      }
      return speedOrigSetTimeout(fn, delay, ...args);
    };
    // 页面时间加速；同时把真实时间暴露在 window.__xueRealNow，
    // realNow() 统一用它做跨标签时间戳（心跳/冷却/租约）
    let lastReal = speedOrigDateNow();
    let lastFake = lastReal;
    Date.now = function () {
      const now = speedOrigDateNow();
      const diff = now - lastReal;
      lastReal = now;
      const r = getSpeedRate();
      lastFake += diff * (r > 0 ? r : 1);
      return lastFake;
    };
    try {
      window.__xueRealNow = speedOrigDateNow;
    } catch (e) {}
    Log('倍速引擎已挂钩', loadSpeedCfg());
  }

  function restoreSpeedHooks() {
    if (!speedInstalled) return;
    try {
      if (speedOrigSetInterval) window.setInterval = speedOrigSetInterval;
      if (speedOrigSetTimeout) window.setTimeout = speedOrigSetTimeout;
      if (speedOrigDateNow) Date.now = speedOrigDateNow;
    } catch (e) {}
    speedInstalled = false;
    speedTailOverride = 0;
    try {
      window.__xueRealNow = undefined;
    } catch (e) {}
    Log('倍速引擎已还原（计时器/时钟恢复原生）');
  }

  function hackVideoSpeed() {
    if (!isPlayerUrl()) return;
    const rate = getSpeedRate();
    if (rate <= 0 && speedTailOverride <= 0) return; // 倍速关闭时不干预播放器
    const target = currentTargetRate();
    try {
      qsa('video').forEach(function (video) {
        if (video.playbackRate !== target) {
          // 高倍速个别浏览器/视频会拒绝，逐级回落
          for (const r of [target, 8, 4, 2, 1]) {
            if (r > target) continue;
            try {
              video.playbackRate = r;
              break;
            } catch (e) {}
          }
        }
      });
    } catch (e) {}
  }

  // 面板切换倍速后的立即生效逻辑
  function applySpeedNow() {
    const c = loadSpeedCfg();
    if (c.on && isPlayerUrl()) {
      installSpeedHooks();
      hackVideoSpeed();
    } else if (!c.on) {
      if (speedInstalled) restoreSpeedHooks();
      try {
        qsa('video').forEach(function (v) {
          try {
            v.playbackRate = 1;
          } catch (e) {}
        });
      } catch (e) {}
    }
    refreshSpeedRowUI();
  }

  function refreshSpeedRowUI() {
    try {
      const box = qs('#xue-auto-panel');
      if (!box) return;
      const c = loadSpeedCfg();
      qsa('.xue-speed-btn', box).forEach(function (b) {
        const r = Number(b.getAttribute('data-rate')) || 0;
        const active = c.on ? c.rate === r : r === 0;
        b.style.background = active ? '#10b981' : '#374151';
      });
    } catch (e) {}
  }

  // 动作按钮（复制日志/重置状态）点击反馈：执行时闪绿，随后恢复统一底色
  function flashButton(btn, ms) {
    if (!btn) return;
    try {
      btn.style.background = '#10b981';
      setTimeout(function () {
        btn.style.background = '#374151';
      }, ms || 800);
    } catch (e) {}
  }

  // 功能按钮配色与倍速按钮一致：未开启=黑色(#374151)，开启=绿色(#10b981)
  // 「自动考试」「自动学习」都是全局持久化开关：点开即绿、再点停止变黑
  function refreshToggleButtons() {
    try {
      const box = qs('#xue-auto-panel');
      if (!box) return;
      const bExam = qs('#xue-auto-exam', box);
      if (bExam) bExam.style.background = isAutoExamOn() ? '#10b981' : '#374151';
      const bStart = qs('#xue-auto-start', box);
      if (bStart) bStart.style.background = isAutoLearnOn() ? '#10b981' : '#374151';
    } catch (e) {}
  }

  // 你的规则：待考试 / 重新学习 = 这门课视频已看完（不再自动点）
  // 待考试 / 开始考试 / 重新考试 = 需要考试
  // 有时钟图标 = 已有考试记录（可看答案，正式考）；无图标 = 首次盲答
  const PATH_DONE = ['待考试', '重新学习', '已完成', '已学完', '开始考试', '重新考试'];
  const PATH_TODO = ['开始学习', '继续学习', '学习中'];
  const PATH_EXAM = ['待考试', '开始考试', '重新考试'];

  const CFG = {
    // 用户负责打开「我的学习→专属成长计划→具体任务」；脚本默认不自动点计划卡片
    autoOpenPlan: false,
    // 路径页：默认自动点「开始/继续学习」自动刷课
    // 如需改回手动（防连环开课/弹窗重定向），把此项改为 false，或用面板「自动学习」
    autoOpenFromPath: true,
    openNextOnlyAfterCourseDone: true,
    // 同时只开一门视频课
    oneCourseAtATime: true,
    pathScanMs: 8000,
    playerAdvanceMs: 2000,
    doneWaitMs: 8000,
    pathOpenCooldownMs: 15000,
    playerHeartbeatTimeoutSec: 90,
    // 播放页关闭(pagehide)后，超过此宽限期仍无新心跳 → 立即释放播放锁（不用等满90s）
    // 宽限期内刷新/重载会恢复心跳覆盖此信号，不会误杀
    playerGoneGraceMs: 8000,
    // 同一门课短时间内重复 window.open 去重（网站一次点击会开两次）
    courseOpenDedupMs: 6000,
    // 绝对不要关标签（闪退主因之一）
    closePlayerWhenDone: false,
    // 禁止 history.back / 乱 reload
    allowHistoryBack: false,
    allowPathReload: false,
    // 关键：默认禁止播放页自动 location 回路径（这是“学着学着又回课程选择”的主因）
    // 完课后只写状态+日志；路径操作标签会自动开下一门
    autoReturnToPath: false,
    // 进入播放页后至少停留这么久，才允许判定完课（防刚进已完成目录就回跳）
    minStayBeforeFinishMs: 20000,
    // 详细日志
    verboseLog: true,
    maxLogEntries: 400,
    // 自动考试：盲答交卷 → 看答案记忆 → 再考一次用记忆答案（已关闭，仅自动看课不自动考试）
    autoExam: false,
    // 路径页：视频都学完后，是否自动点「待考试/开始考试/重新考试」（已关闭）
    autoOpenExamFromPath: false,
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
      ms: realNow() - BOOT_AT,
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
    const next = Object.assign({}, prev, patch, { updatedAt: realNow() });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch (e) {}
    if (CFG.verboseLog && patch) {
      const keys = Object.keys(patch);
      if (keys.some((k) => k !== 'playerHeartbeatAt' && k !== 'updatedAt' && k !== 'pathWorker')) {
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

  // ============ 跨标签公共辅助 ============
  // 自动考试开关持久化：考试流程跨多个标签（路径→考试→结果），只改本标签内存 CFG 会在
  // 新开的考试/结果标签里全部失效（旧版考试流程断链的根本原因）。开关写入 localStorage，
  // 所有标签读同一个值；面板「自动考试」按钮切换，「重置状态」清除。
  function isAutoExamOn() {
    if (CFG.autoExam) return true;
    try {
      return !!loadState().autoExamOn;
    } catch (e) {
      return false;
    }
  }

  // 自动学习总开关（全局持久化）：开启后才会自动开课/自动换任务；关闭=纯手动浏览
  function isAutoLearnOn() {
    try {
      return !!loadState().autoLearnOn;
    } catch (e) {
      return false;
    }
  }

  // 路径「操作标签」租约：播放页/考试页回到路径后会产生多个路径标签，若都执行点击
  // 会重复开课/开考。全站同一时刻只允许一个标签（持租约者）执行点击，其余仅监控。
  const WORKER_LEASE_MS = 20000;
  function amPathWorker(st) {
    const s = st || loadState();
    const lease = s.pathWorker || {};
    const now = realNow();
    if (lease.id === PAGE_ID || !lease.id || now - (lease.at || 0) > WORKER_LEASE_MS) {
      if (lease.id !== PAGE_ID) Log('接管路径操作权', { prevId: lease.id, prevAt: lease.at });
      saveState({ pathWorker: { id: PAGE_ID, at: now } });
      return true;
    }
    return false;
  }
  function claimPathWorker() {
    saveState({ pathWorker: { id: PAGE_ID, at: realNow() } });
  }

  // 记录已通过的考试：路径页DOM状态不刷新时，防止对已通过考试无限重考
  function recordExamPassed(src) {
    const st = loadState();
    const id = st.examId || examIdFromUrl() || '';
    const title = normalizeQTitle(st.examTitle || getExamTitle());
    if (!id && !title) return;
    const passed = Array.isArray(st.passedExams) ? st.passedExams.slice() : [];
    if (passed.some((p) => (p.id && p.id === id) || (p.title && p.title === title))) return;
    passed.push({ id: id, title: title, at: realNow() });
    saveState({ passedExams: passed, lastAction: 'exam_passed:' + src });
    LogA('记录考试通过，后续不再自动重考', { id: id, title: title, src: src });
  }
  function detectResultPass() {
    try {
      const t = text(document.body).slice(0, 5000);
      if (/未通过|不及格|遗憾/.test(t)) return false;
      if (/通过考试|考试通过|恭喜通过/.test(t)) return true;
      const m = t.match(/(\d+(?:\.\d+)?)\s*分/);
      if (m && parseFloat(m[1]) >= 60) return true;
    } catch (e) {}
    return false;
  }

  // SPA 页面类型切换 → 整页重启：hash 路由切换不会重载脚本，旧页面类型的定时器
  // （心跳/回跳/轮询）会残留成“僵尸”，把新页面的状态搅乱。检测到类型变化直接 reload。
  let __typeReloadAt = 0;
  function maybeReloadOnTypeChange(prevType) {
    try {
      const nt = pageType();
      if (!prevType || nt === prevType) return;
      if (['path', 'player', 'exam', 'exam_result', 'study'].indexOf(nt) < 0) return;
      if (realNow() - __typeReloadAt < 5000) return;
      __typeReloadAt = realNow();
      LogN('SPA页面类型切换 ' + prevType + ' → ' + nt + '，400ms后整页重启（清理旧页面残留定时器）');
      setTimeout(function () {
        location.reload();
      }, 400);
    } catch (e) {}
  }

  // ============ 一键「自动学习」跨页面引导 ============
  // 点「自动学习」后无论在哪个页面，自动带路到成长计划路径页并开始学习：
  //   路径页 → 直接开始；我的学习页 → 自动点「专属成长计划」→ 点具体任务；
  //   其它页面 → 回上次的路径页（若已学完则去我的学习页找新任务）。
  // 状态存 localStorage，跨页面跳转后继续；90秒未到达自动放弃并给出指引。
  const BOOT_KEY = 'xue_bootstrap_v11';
  const STUDY_URL = 'https://xue.sinosig.com/xue-student-web/person/study';
  const BOOT_TIMEOUT_MS = 180000;

  function loadBootstrap() {
    try {
      return JSON.parse(localStorage.getItem(BOOT_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function saveBootstrap(b) {
    try {
      if (b) localStorage.setItem(BOOT_KEY, JSON.stringify(b));
      else localStorage.removeItem(BOOT_KEY);
    } catch (e) {}
    return b;
  }

  // 按文本找可点元素：文本最短的最精确（恰是按钮本身，而不是包含它的大卡片）；
  // excludeArr 传入「已学完任务的入口文本」，用于逐个换下一个任务
  function findClickableByText(regex, maxLen, excludeArr) {
    const ex = Array.isArray(excludeArr) ? excludeArr : [];
    const cands = qsa('a, button, [role="button"], .item, .card, li, span, p, div').filter(function (el) {
      const t = text(el);
      if (!t || t.length > (maxLen || 40)) return false;
      if (!regex.test(t)) return false;
      if (ex.indexOf(t) >= 0) return false;
      return isVisible(el);
    });
    cands.sort(function (a, b) {
      return text(a).length - text(b).length;
    });
    return cands[0] || null;
  }

  // 「专属成长计划」任务卡片扫描：默认「全部」页签直接判断哪些任务没学完。
  // 现场验证过的容器：.course-item（带100%进度）、.plan-item（计划视图分组头/卡片）；
  // 标题不依赖固定类名——在容器后代里找「含任务特征词的最长文本」，
  // 并排除"目标天数/已注册"这类元信息（曾因此把"目标天数：无1973人已注册"当成任务名）
  function scanStudyTaskCards() {
    const cards = [];
    const seen = {};
    const TASK_RE = /【.+】|条线|必修|季度|计划|任务|培训|教育|课程|学习/;
    const META_RE = /目标天数|已注册|已报名|人已学|学习进度/;
    function cardFinished(cardText) {
      // 明确「已完成/已学完/100%」且无未完成字样 → 学完；进度分子<分母 → 未学完
      let fin = /已完成|已学完|100%/.test(cardText) && !/未完成|学习中|进行中|未开始|未学习/.test(cardText);
      const pm = cardText.match(/(\d+)\s*\/\s*(\d+)/);
      if (pm && Number(pm[1]) < Number(pm[2])) fin = false;
      return fin;
    }
    const containers = qsa('.course-item, .common-item, .task-item, .plan-item');
    containers.forEach(function (card) {
      if (!isVisible(card)) return;
      const cardText = text(card);
      // 短文本是"学习任务/IDP课程"这类分组头，不是任务卡
      if (!cardText || cardText.length < 10) return;
      // 后代里找标题：优先含任务特征词的最长 6-80 字文本；元信息文本不参与
      let hitEl = null;
      let hitText = '';
      let anyEl = null;
      let anyText = '';
      qsa('*', card).forEach(function (el2) {
        const tt = text(el2);
        if (tt.length < 6 || tt.length > 80 || tt === cardText) return;
        if (META_RE.test(tt)) return;
        if (tt.length > anyText.length) {
          anyText = tt;
          anyEl = el2;
        }
        if (TASK_RE.test(tt) && tt.length > hitText.length) {
          hitText = tt;
          hitEl = el2;
        }
      });
      const title = (hitText || anyText || cardText).slice(0, 60);
      const clickEl = hitEl || anyEl || card;
      if (seen[title]) return;
      seen[title] = true;
      cards.push({
        el: clickEl,
        title: title,
        cardText: cardText.slice(0, 150),
        finished: cardFinished(cardText.slice(0, 150)),
      });
    });
    return cards;
  }

  function bootstrapFail(msg, stay) {
    saveBootstrap(null);
    // 引导结束：自动学习回到关闭状态（按钮变黑）
    saveState({ autoLearnOn: false, lastAction: 'bootstrap_fail' });
    LogW('自动学习引导结束：' + msg);
    const st = loadState();
    setPanel(
      msg +
        '\n自动学习已结束（按钮变黑）\n' +
        (stay
          ? '如需重试请再点「自动学习」'
          : st.pathUrl
            ? '2.5s后回到上次的路径页\n可再点「自动学习」重试'
            : '可再点「自动学习」重试')
    );
    if (!stay && st.pathUrl) {
      setTimeout(function () {
        location.href = st.pathUrl;
      }, 2500);
    }
  }

  function startBootstrap() {
    saveBootstrap({ active: true, step: 'start', startedAt: realNow(), tries: 0 });
    bootstrapTick();
  }

  function bootstrapTick() {
    const b = loadBootstrap();
    if (!b || !b.active) return;
    if (!document.body) return;
    if (realNow() - (b.startedAt || 0) > BOOT_TIMEOUT_MS) {
      bootstrapFail('3分钟内未到达路径页');
      return;
    }
    const t = pageType();
    const st = loadState();

    // ① 已在路径页：到达（或本路径已学完 → 换下一个任务）
    if (t === 'path') {
      // 刚标记完“本路径已学完”，正在等跳去我的学习页找下一个任务
      if (b.step === 'goto_study') {
        saveBootstrap(b);
        return;
      }
      const finList = Array.isArray(st.finishedPathUrls) ? st.finishedPathUrls : [];
      if (finList.indexOf(pathKey(location.href)) >= 0) {
        // 又进了一个已学完的路径：把刚才点的任务记为“试过”，回去换下一个
        const tried = Array.isArray(b.triedTasks) ? b.triedTasks.slice() : [];
        if (b.lastTaskText && tried.indexOf(b.lastTaskText) < 0) tried.push(b.lastTaskText);
        saveBootstrap({
          active: true,
          step: 'goto_study',
          startedAt: b.startedAt,
          tries: (b.tries || 0) + 1,
          triedTasks: tried,
          lastTaskText: '',
        });
        LogW('自动学习：这个任务的视频已全部学完，回学习页换下一个');
        setPanel('这个任务的视频已学完\n>>> 回「我的学习」换下一个任务…');
        setTimeout(function () {
          location.href = STUDY_URL;
        }, 1200);
        return;
      }
      // 记住刚点进来的任务名：本路径学完后回学习页要跳过它（triedTasks 的种子，
      // 否则引导被清空、任务名丢失 → 回列表后反复点进同一个已学完的任务）
      if (b.lastTaskText) saveState({ lastTaskEntered: b.lastTaskText });
      saveBootstrap(null);
      claimPathWorker();
      saveState({
        phase: 'path_running',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'bootstrap_arrived',
        allowOpenNext: true,
        forceOpenOnce: true,
      });
      LogA('自动学习：已到达路径页，开始自动学习');
      setPanel('✓ 已进入成长计划路径页\n开始自动学习');
      setTimeout(function () {
        pathLoop(true);
      }, 600);
      return;
    }

    // 已在播放页：已经在学习中，无需引导
    if (t === 'player') {
      saveBootstrap(null);
      setPanel('已在课程播放页学习中\n播完会自动开下一门');
      return;
    }

    // 考试页：别乱动，取消引导
    if (t === 'exam' || t === 'exam_result') {
      saveBootstrap(null);
      return;
    }

    // ② 我的学习页：先进入「专属成长计划」，再从任务列表挑「未完成」的任务。
    //    完成状态在列表页就能判断（已完成/100%/进度），已完成的任务绝不点进去
    if (t === 'study') {
      if (b.step === 'start' || b.step === 'goto_study') {
        b.step = 'find_plan';
        b.planTries = 0;
        LogN('自动学习步骤：find_plan（我的学习页）');
      }

      // 1) 先进入「专属成长计划」：入口未激活就点它（冷却+次数上限），别急着点卡片
      const plan = findClickableByText(/专属成长计划/, 20) || findClickableByText(/成长计划/, 20);
      const planActive = plan ? /active|current|selected/.test(String(plan.className || '')) : false;
      if (plan && !planActive) {
        if ((b.planTries || 0) >= 5) {
          bootstrapFail('点了「专属成长计划」但页面没有切换');
          return;
        }
        if (b.lastPlanClickAt && realNow() - b.lastPlanClickAt < 5000) {
          saveBootstrap(b);
          setPanel('自动学习引导中…\n等待「专属成长计划」展开…');
          return;
        }
        b.planTries = (b.planTries || 0) + 1;
        b.noTaskTicks = 0;
        b.lastPlanClickAt = realNow();
        saveBootstrap(b);
        LogA('自动学习：点击「专属成长计划」入口', { tries: b.planTries });
        setPanel('自动学习引导中…\n① 进入「专属成长计划」');
        safeClick(plan, '自动学习:成长计划入口');
        return;
      }

      // 2) 已在成长计划视图：默认「全部」页签本身就展示所有任务，
      //    直接扫卡片判断完成状态即可（已完成的绝不点，不逐个翻分类页签）
      const triedTasks = Array.isArray(b.triedTasks) ? b.triedTasks : [];
      const cards = scanStudyTaskCards();
      const target =
        cards.find(function (c) {
          return !c.finished && triedTasks.indexOf(c.title) < 0;
        }) || null;

      if (target) {
        if ((b.taskTries || 0) > 15) {
          bootstrapFail('点了任务卡片但没进入路径页');
          return;
        }
        // 点击冷却：刚点过任务就等页面跳转，不重复点、不开第二个标签
        if (b.lastTaskClickAt && realNow() - b.lastTaskClickAt < 8000) {
          saveBootstrap(b);
          setPanel('已点击任务，等待进入…\n' + target.title.slice(0, 40));
          return;
        }
        b.taskTries = (b.taskTries || 0) + 1;
        b.noTaskTicks = 0;
        b.lastTaskClickAt = realNow();
        b.lastTaskText = target.title;
        saveBootstrap(b);
        LogA('自动学习：点击未完成任务', {
          tries: b.taskTries,
          text: target.title.slice(0, 30),
          任务总数: cards.length,
        });
        setPanel('自动学习引导中…\n② 点击未完成任务\n' + target.title.slice(0, 40));
        safeClick(target.el, '自动学习:未完成任务入口');
        return;
      }

      // 3) 没有未完成任务：等几拍复查 → 无课可学
      //    判定前输出完整现场诊断（含卡片容器原始文字），杜绝"读错界面/漏识别看不出"
      b.noTaskTicks = (b.noTaskTicks || 0) + 1;
      if (b.noTaskTicks < 4) {
        saveBootstrap(b);
        const rawContainers = qsa('.course-item, .common-item, .task-item, .plan-item');
        setPanel(
          cards.length
            ? '任务共 ' + cards.length + ' 项，均已完成/已试过\n稍等复查…'
            : '等待任务列表加载…\n(检测到卡片容器 ' + rawContainers.length + ' 个)'
        );
        return;
      }
      LogW('任务卡片扫描结果(无课判定依据)', {
        卡片数: cards.length,
        明细: cards.map(function (c) {
          return { 任务: c.title.slice(0, 24), 已完成: c.finished, 卡面: c.cardText.slice(0, 60) };
        }),
        容器原文: qsa('.course-item, .common-item, .task-item, .plan-item')
          .slice(0, 6)
          .map(function (el) {
            return (String(el.className) + ' | ' + text(el)).slice(0, 120);
          }),
        已试过: triedTasks.length,
        顶部菜单: qsa('.top-bar-menu__item')
          .map(function (el) {
            return text(el) + (/active|current|selected/.test(String(el.className || '')) ? '(激活)' : '');
          })
          .slice(0, 8),
        页签: qsa('.tab-item')
          .map(function (el) {
            return text(el) + (/active|current|selected/.test(String(el.className || '')) ? '(当前)' : '');
          })
          .join('/'),
        页面摘要: String((document.body && document.body.innerText) || '')
          .replace(/\s+/g, ' ')
          .slice(0, 200),
      });
      bootstrapFail(
        cards.length
          ? '无课可学：任务列表里的任务都已完成'
          : '无课可学：没识别到任务卡片（详见日志容器原文）',
        true
      );
      return;
    }

    // ③ 其它页面（首页等）：上条路径已学完 → 去我的学习页找新任务；
    //    否则直接回上次的路径页最快
    if (b.step === 'start') {
      const prevDone = st.phase === 'path_done' || st.phase === 'path_all_done';
      if (st.pathUrl && !prevDone) {
        b.step = 'goto_path';
        saveBootstrap(b);
        LogN('自动学习：前往上次的路径页', st.pathUrl);
        setPanel('自动学习引导中…\n前往上次的成长计划路径页…');
        location.href = st.pathUrl;
      } else {
        b.step = 'goto_study';
        saveBootstrap(b);
        LogN('自动学习：前往我的学习页');
        setPanel('自动学习引导中…\n前往「我的学习」页找任务…');
        location.href = STUDY_URL;
      }
      return;
    }
    // 跳转途中：等页面加载
    saveBootstrap(b);
  }

  // 路径地址归一化（去掉查询串），用于 finishedPathUrls 比对
  function pathKey(url) {
    return String(url || '').replace(/\?.*$/, '').replace(/#$/, '');
  }

  // 本路径视频全部学完（没开自动考试，或已无可考项）→ 记录该路径已完成，
  // 自动回「我的学习」找下一个任务继续学（剩余考试留待手动/自动考试处理）
  function markPathFinishedAndNext(summary, examLeft) {
    // 未开启「自动学习」：只是手动翻看到已学完的路径页，停留原地，绝不自动跳走
    if (!isAutoLearnOn()) {
      saveState({
        phase: 'path_done',
        activeCourseId: '',
        activeTitle: '',
        playerHeartbeatAt: 0,
        lastAction: 'path_done_idle',
        allowOpenNext: false,
      });
      setPanel(summary + '\n本路径视频已全部学完\n（未开启自动学习，停留在此页）\n点「自动学习」可自动去下一个任务');
      return;
    }
    const bb = loadBootstrap();
    if (bb && bb.active) return; // 已在引导流程中，避免重复触发
    const st = loadState();
    const key = pathKey(location.href);
    const fin = Array.isArray(st.finishedPathUrls) ? st.finishedPathUrls.slice() : [];
    if (key && fin.indexOf(key) < 0) fin.push(key);
    saveState({
      finishedPathUrls: fin,
      phase: 'path_done',
      activeCourseId: '',
      activeTitle: '',
      playerHeartbeatAt: 0,
      lastAction: 'auto_next_task',
      allowOpenNext: false,
    });
    saveBootstrap({
      active: true,
      step: 'goto_study',
      startedAt: realNow(),
      tries: 0,
      triedTasks: (function () {
        // 种子：引导里已有的排除名单 + 刚点进来刚学完的任务名（防重复点入）
        const seed = Array.isArray(bb.triedTasks) ? bb.triedTasks.slice() : [];
        const last = st.lastTaskEntered || '';
        if (last && seed.indexOf(last) < 0) seed.push(last);
        return seed;
      })(),
      lastTaskText: '',
    });
    LogA('本路径视频已全部学完，自动寻找下一个任务', { examLeft: examLeft || 0, finishedPaths: fin.length });
    setPanel(
      summary +
        '\n本路径视频已全部学完' +
        (examLeft ? '\n剩余考试 ' + examLeft + ' 项：未开自动考试，留待手动' : '') +
        '\n>>> 1.5s后自动前往下一个任务…'
    );
    setTimeout(function () {
      location.href = STUDY_URL;
    }, 1500);
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
    // 课程ID可能是纯数字(2074399...)或十六进制(8a4896977f88...)，不能只匹配 \d+
    const m = String(url || location.href).match(/courseDetail\/([0-9a-zA-Z_-]+)/);
    return m ? m[1] : '';
  }
  function parseCourseIdFromBtnId(id) {
    if (!id) return '';
    const parts = String(id).replace(/^v\d+studyBtn-/, '').split('_');
    return parts[parts.length - 1] || '';
  }

  // 跨标签页心跳观察：视频加速工具会改 Date，各标签页时钟不同步，时间戳直接比大小不可靠，
  // 所以判断播放页死活以「心跳值是否还在变」为准（用本页时钟计时）
  let hbSeenValue = -1;
  let hbSeenAt = 0;
  let hbChangedEver = false;

  function hasLivePlayerLock(st) {
    if (!CFG.oneCourseAtATime || !st) return false;
    if (st.phase !== 'playing') return false;
    const now = realNow();
    const hb = st.playerHeartbeatAt || 0;
    const opened = st.activeOpenedAt || 0;
    const gone = st.playerUnloadAt || 0;

    if (hb !== hbSeenValue) {
      if (hbSeenValue !== -1) hbChangedEver = true;
      hbSeenValue = hb;
      hbSeenAt = now;
    }

    // 播放页已明确关闭且宽限期内心跳没再变 → 锁立即失效，不用等心跳超时
    if (gone && gone >= hb && now - hbSeenAt > (CFG.playerGoneGraceMs || 8000)) return false;

    // 心跳值持续不变超过超时时间 → 播放页已死
    if (now - hbSeenAt > CFG.playerHeartbeatTimeoutSec * 1000) return false;

    // 本页亲眼观察到心跳在跳 → 一定活着，无视时间戳大小
    if (hbChangedEver) return true;

    // 本页刚打开、还观察不出变化：按时间戳粗判；心跳来自「未来」=对方时钟被加速，先按活处理
    if (hb && (hb > now || now - hb < CFG.playerHeartbeatTimeoutSec * 1000)) return true;
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
      '<button id="xue-auto-start" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#374151;color:#fff">自动学习</button>' +
      '<button id="xue-auto-exam" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#374151;color:#fff">自动考试</button>' +
      '<button id="xue-auto-copy-log" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#374151;color:#fff">复制日志</button>' +
      '<button id="xue-auto-reset" style="cursor:pointer;border:0;border-radius:4px;padding:4px 8px;background:#374151;color:#fff">重置状态</button>' +
      '</div>' +
      '<div style="margin-top:6px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">' +
      '<span style="opacity:.8">倍速</span>' +
      '<button class="xue-speed-btn" data-rate="0" style="cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;background:#374151">关</button>' +
      '<button class="xue-speed-btn" data-rate="2" style="cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;background:#374151">2x</button>' +
      '<button class="xue-speed-btn" data-rate="4" style="cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;background:#374151">4x</button>' +
      '<button class="xue-speed-btn" data-rate="8" style="cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;background:#374151">8x</button>' +
      '<button class="xue-speed-btn" data-rate="16" style="cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;background:#374151">16x</button>' +
      '</div>';
    document.body.appendChild(box);
    qs('#xue-auto-start', box).onclick = () => {
      // 真开关：点一下开启（绿）并立即开始带路；再点一下停止（黑）
      const turnOn = !loadState().autoLearnOn;
      claimPathWorker();
      if (turnOn) {
        LogA('面板点击：开启自动学习（全局）');
        saveState({ autoLearnOn: true, lastAction: 'manual_learn_on' });
        setPanel('自动学习：已开启（全局记忆）\n正在带路/接管学习中...');
        startBootstrap();
      } else {
        LogA('面板点击：停止自动学习（全局）');
        saveBootstrap(null);
        saveState({ autoLearnOn: false, lastAction: 'manual_learn_off', forceOpenOnce: false });
        setPanel('自动学习：已停止\n当前视频会播完，但不再自动开新课/换任务\n再点一次可重新开始');
      }
    };
    qs('#xue-auto-exam', box).onclick = () => {
      // 全局持久化开关：考试流程跨多个标签（路径→考试→结果），必须所有标签读到同一个值
      const turnOn = !loadState().autoExamOn;
      claimPathWorker();
      if (turnOn) {
        LogA('面板点击：开启自动考试（全局）');
        CFG.autoExam = true;
        CFG.autoOpenExamFromPath = true;
        // 清掉残留冷却/锁，避免卡死在「操作冷却中」
        saveState({
          autoExamOn: true,
          lastAction: 'manual_exam_on',
          allowOpenExam: true,
          forceExamOnce: true,
          examPhase: '',
          phase: 'path_running',
          examOpenedAt: 0,
          lastExamOpenAt: 0,
          lastExamHistoryAt: 0,
          lastExamWindowAt: 0,
        });
        setPanel('自动考试：已开启（全局记忆）\n已清除冷却锁并接管操作权\n将点「待考试/开始考试/重新考试」\n再点一次可关闭');
      } else {
        LogA('面板点击：关闭自动考试（全局）');
        CFG.autoExam = false;
        CFG.autoOpenExamFromPath = false;
        saveState({ autoExamOn: false, lastAction: 'manual_exam_off', forceExamOnce: false });
        setPanel('自动考试：已关闭（全局）\n考试/结果标签将停止自动操作');
      }
      if (pageType() === 'path') setTimeout(function () { pathLoop(true); }, 300);
      if (pageType() === 'exam') setTimeout(function () { examLoop(); }, 300);
      if (pageType() === 'exam_result') setTimeout(function () { examResultLoop(); }, 300);
    };
    const bCopy = qs('#xue-auto-copy-log', box);
    bCopy.onclick = () => {
      flashButton(bCopy, 900);
      LogA('面板点击：复制日志');
      copyLogs();
    };
    const bReset = qs('#xue-auto-reset', box);
    bReset.onclick = () => {
      flashButton(bReset, 900);
      LogA('面板点击：重置状态');
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(BOOT_KEY);
      setPanel('状态已重置，请刷新页面\n自动考试/自动学习开关恢复为关\n已完成任务清单已清空\n倍速设置保留\n日志仍保留，可点「复制日志」\n答案库未清空');
    };
    // 倍速行：关 / 2x / 4x / 8x / 16x（全局记忆，所有标签即时生效）
    qsa('.xue-speed-btn', box).forEach((b) => {
      b.onclick = () => {
        const r = Number(b.getAttribute('data-rate')) || 0;
        const c = loadSpeedCfg();
        c.on = r > 0;
        if (r > 0) c.rate = r;
        saveSpeedCfg(c);
        LogA('面板设置倍速', c);
        applySpeedNow();
        setPanel(
          '倍速：' + (c.on ? c.rate + 'x（立即生效，全局记忆）' : '已关闭（1x自然播放）') +
            (c.on ? '\n片尾最后8秒自动降为1x自然播完' : '')
        );
      };
    });
    refreshSpeedRowUI();
    refreshToggleButtons();
    return box;
  }
  function setPanel(msg) {
    try {
      ensurePanel();
      const body = qs('#xue-auto-panel-body');
      if (body) body.textContent = msg;
      refreshToggleButtons();
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
            text: () => Promise.resolve(''),
          });
        }
        return originalFetch.apply(this, arguments);
      };
    })();

    // ========== 核心2：防切屏（保留原逻辑；改写失败只降级不抛错） ==========
    // 实测有的环境 document 实例上已有不可配置的 hidden 属性，直接 defineProperty 会抛
    // TypeError 把后面所有核心（自动播放/切课编排）一起带崩 —— 必须逐项兜底
    (function antiBlur() {
      [
        ['hidden', function () { return false; }],
        ['visibilityState', function () { return 'visible'; }],
      ].forEach(function (pair) {
        try {
          Object.defineProperty(document, pair[0], { get: pair[1], configurable: true });
        } catch (e1) {
          try {
            Object.defineProperty(Object.getPrototypeOf(document), pair[0], { get: pair[1], configurable: true });
          } catch (e2) {
            LogW('防切屏：document.' + pair[0] + ' 无法改写（跳过该子项）', String(e2).slice(0, 60));
          }
        }
      });
      try {
        const originalAddEventListener = document.addEventListener;
        document.addEventListener = function (type, listener, options) {
          if (String(type || '').includes('visibility')) return;
          return originalAddEventListener.call(this, type, listener, options);
        };
        document.hasFocus = () => true;
      } catch (e3) {}
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

        // 自动播放（本课已完课时不拉起：平台会把已完成的视频自动循环重播）
        if (video.paused && !finishTriggered) {
          video.play().catch((err) => {
            Log('自动播放被阻止', err && err.message);
          });
        }
      }
    }, 2000);

    // ========== 核心4：自动关闭课程评价弹窗 ==========
    (function autoCloseEvaluation() {
      // 节流+可见性判断：关闭动作至少间隔3s；弹窗关闭后元素常留在DOM里(隐藏)，
      // 不可见的不点（旧版每1.5s重复点一次隐藏弹窗的关闭按钮）
      let lastEvalCloseAt = 0;
      const observer = new MutationObserver(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        dialogs.forEach((dialog) => {
          if (!isVisible(dialog) && dialog.offsetParent === null) return;
          const ariaLabel = dialog.getAttribute('aria-label') || '';
          const titleEl = dialog.querySelector('.el-dialog__title');
          const titleText = titleEl ? titleEl.textContent : '';

          if (ariaLabel.includes('课程怎么样') || (titleText && titleText.includes('课程怎么样'))) {
            if (realNow() - lastEvalCloseAt < 3000) return;
            lastEvalCloseAt = realNow();
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
      // 命中任一关键词即视为播放失败，自动 F5
      const ERROR_KEYWORDS = [
        '网络错误导致视频下载中途失败',
        '请求超时',
        '请稍后再试',
      ];
      let reloadTriggered = false;

      function checkAndReload() {
        if (reloadTriggered) return;
        const errorDialogs = document.querySelectorAll(
          '.vjs-errors-dialog, .vjs-modal-dialog-content, .vjs-errors-message'
        );
        for (const dialog of errorDialogs) {
          const t = dialog.innerText || dialog.textContent || '';
          if (ERROR_KEYWORDS.some((kw) => t.includes(kw))) {
            reloadTriggered = true;
            Log('检测到播放错误，3秒后自动刷新页面...', t.slice(0, 60));
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
    const recentCourseOpens = {};
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
      // 双保险：cid 相等或 URL 本身含 activeCourseId 都视为“正在开当前这门课”，放行
      if (cid && hasLivePlayerLock(st) && st.activeCourseId && cid !== st.activeCourseId && urlStr.indexOf(st.activeCourseId) === -1) {
        LogW('拦截并发开课', { url: urlStr, active: st.activeCourseId, tryCid: cid });
        setPanel('已有课程播放中，拦截并发打开\nactive=' + st.activeCourseId);
        return null;
      }
      // 考试/结果页：短时间防重复；结果与正式考试用不同窗口名，避免 SPA 串台
      if (isExamUrl) {
        const key = urlStr.replace(/#.*$/, '') + '#' + (urlStr.match(/exam\/(?:train|result)[^?]*/)||[''])[0];
        const now = realNow();
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
        const now = realNow();
        // 刚完成的课，网站残留逻辑又要重开它：拦截，否则会把 course_done 覆盖回 playing，卡住不开下一门
        if (st.phase === 'course_done' && cid === st.lastFinishedCourseId) {
          LogW('拦截重开刚完成的课程', { cid: cid });
          return null;
        }
        // 同一门课短时间内的重复开课（网站一次点击会连发两次 window.open）：拦截重复，避免开两个播放标签
        if (recentCourseOpens[cid] && now - recentCourseOpens[cid] < (CFG.courseOpenDedupMs || 6000)) {
          LogW('拦截重复开课窗口', { cid: cid, ago: now - recentCourseOpens[cid] });
          return null;
        }
        recentCourseOpens[cid] = now;
        saveState({
          activeCourseId: cid,
          activeOpenedAt: now,
          playerHeartbeatAt: now,
          playerUnloadAt: 0,
          phase: 'playing',
          pathUrl: pageType() === 'path' ? location.href : loadState().pathUrl,
          lastAction: 'window_open_course',
        });
        // 固定窗口名：即使后续又触发开课，也复用同一播放标签，不再新开标签
        try {
          return rawOpen(urlStr, '_xue_player', specs);
        } catch (e) {
          return rawOpen(url, name || '_blank', specs);
        }
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
          const prevT = pageType();
          const r = rawPush.apply(history, arguments);
          setTimeout(function () {
            maybeReloadOnTypeChange(prevT);
          }, 200);
          return r;
        };
      }
      if (rawReplace) {
        history.replaceState = function () {
          LogN('history.replaceState', { args0: arguments[2] || arguments[0] });
          const prevT = pageType();
          const r = rawReplace.apply(history, arguments);
          setTimeout(function () {
            maybeReloadOnTypeChange(prevT);
          }, 200);
          return r;
        };
      }
      window.addEventListener('hashchange', function () {
        LogN('hashchange', { href: location.href });
        // 倍速引擎跟随页面类型启停：离开播放页立即还原钩子，进入播放页补挂
        if (speedInstalled && !isPlayerUrl()) restoreSpeedHooks();
        else if (!speedInstalled && isPlayerUrl() && loadSpeedCfg().on) installSpeedHooks();
        maybeReloadOnTypeChange(bootPageType);
      });
      window.addEventListener('popstate', function () {
        LogN('popstate', { href: location.href });
        maybeReloadOnTypeChange(bootPageType);
      });
      Log('导航监控已安装(beforeunload/history/hash)');
    } catch (e) {
      LogE('导航监控安装失败', e && e.message);
    }
  }

  // 报名类按钮文案（自定义课程的「我要学习」是 div.course-state-btn，不是 button/a）
  const ENROLL_TEXTS = ['我要学习', '立即学习', '报名学习', '参加学习'];

  function looksLikeEnrollControl(el) {
    // 按「叶子节点 + 按钮尺寸 + 指针光标/按钮样式类名」识别非标准标签的报名按钮
    if (!el || el.children.length > 0) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width < 20 || r.width > 400 || r.height < 12 || r.height > 80) return false;
    if (!isVisible(el)) return false;
    const cls = String(el.className || '');
    let pointer = false;
    try { pointer = getComputedStyle(el).cursor === 'pointer'; } catch (e) {}
    return pointer || /btn|button/i.test(cls);
  }

  function findEnrollButton() {
    const candidates = qsa('button, a, .btn, [role="button"]').filter((el) => {
      const t = text(el);
      if (!t) return false;
      if (ENROLL_TEXTS.indexOf(t) < 0) return false;
      return isVisible(el);
    });
    // 兜底：div/span 等非标准标签的报名按钮（实测 div.course-state-btn 文案「我要学习」）
    if (!candidates.length) {
      const leaf = qsa('div, span').find((el) => ENROLL_TEXTS.indexOf(text(el)) >= 0 && looksLikeEnrollControl(el));
      if (leaf) candidates.push(leaf);
    }
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
    if (!isAutoExamOn()) return false;
    let st = loadState();
    // 已通过的考试不再自动重考（路径页DOM状态不刷新时防止无限重考）
    const passedList = Array.isArray(st.passedExams) ? st.passedExams : [];
    const examTodos = list.filter(
      (x) =>
        x.needExam &&
        !passedList.some((p) => (p.id && p.id === x.examId) || (p.title && p.title === normalizeQTitle(x.title)))
    );
    if (!examTodos.length) {
      if (!list.filter((x) => isPathTodo(x.status)).length) {
        saveState({ phase: 'path_all_done', lastAction: 'path_all_done_no_exam' });
        setPanel(summary + '\n视频已学完，待考试=0\n路径处理完毕');
      }
      return false;
    }

    const now = realNow();
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

    const canExamAuto = !!(CFG.autoOpenExamFromPath || force || st.allowOpenExam || st.autoExamOn);
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
    // 多标签防打架：全站同一时刻只允许一个「操作标签」执行点击（播放页/考试页回到
    // 路径后会产生多个路径标签），其余标签仅监控显示
    const isWorker = amPathWorker(st0);
    if (isWorker) {
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
    }

    // 未报名先点「我要学习」（仅操作标签）
    if (isWorker && realNow() - lastEnrollClickAt > 2500 && clickEnrollIfNeeded()) {
      lastEnrollClickAt = realNow();
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
    // 路径页DOM状态不刷新时，用本地已完成清单过滤，防止反复重开刚学完的课
    const finishedSet = new Set(Array.isArray(st0.finishedCourseIds) ? st0.finishedCourseIds : []);
    const todo = videoList.filter(
      (x) => isPathTodo(x.status) && !finishedSet.has(x.courseId) && x.title !== (st0.lastFinishedTitle || '')
    );
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
    if (!isWorker) {
      const lease = loadState().pathWorker || {};
      const stw = loadState();
      let extra = '';
      if (hasLivePlayerLock(stw)) extra = '\n播放中：' + (stw.activeTitle || stw.activeCourseId || '');
      setPanel(summary + extra + '\n操作标签：#' + (lease.id || '?') + '\n本标签只监控，不重复点击');
      return;
    }

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
      setPanel(summary + '\n刚完成一门\n' + (CFG.autoOpenFromPath ? '将打开下一门' : '请点面板「自动学习」'));
    }

    if (hasLivePlayerLock(st)) {
      const ago = st.playerHeartbeatAt ? Math.round((realNow() - st.playerHeartbeatAt) / 1000) : -1;
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

    // 视频都学完 → 自动考试；没开自动考试（或已无可考项）→ 自动找下一个任务继续学
    if (!todo.length) {
      if (pathTryExam(list, summary, forceOpen)) return;
      markPathFinishedAndNext(summary, examTodos.length);
      return;
    }

    // 默认不自动开课：除非 CFG.autoOpenFromPath=true，或面板点了「自动学习」(forceOpen/forceOpenOnce)
    const st2 = loadState();
    // 总开关：未开启「自动学习」时绝不自动开课（纯手动浏览）
    const canAuto = !!(CFG.autoOpenFromPath || forceOpen || st2.forceOpenOnce) && isAutoLearnOn();
    if (!canAuto) {
      setPanel(
        summary +
          '\n自动开课：关闭（防闪退/重定向）\n请手动点「开始/继续学习」\n或点面板「自动学习」\n考试可点「自动考试」'
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

    if (realNow() - lastPathOpenAt < CFG.pathOpenCooldownMs) {
      setPanel(summary + '\n即将打开：' + todo[0].title + '\n(防抖中，防连环开课...)');
      Log('路径开课防抖中', { leftMs: CFG.pathOpenCooldownMs - (realNow() - lastPathOpenAt) });
      return;
    }

    const next = todo[0];
    lastPathOpenAt = realNow();
    saveState({
      pathUrl: location.href,
      activeCourseId: next.courseId || '',
      activeTitle: next.title,
      activeOpenedAt: realNow(),
      playerHeartbeatAt: realNow(),
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
  let lastAdvanceAt = realNow();
  let finishTriggered = false;
  let sectionClickAt = 0;
  let activePlayerCid = '';
  let playerSinceAt = realNow();
  let lastHbWriteAt = 0;
  // 播放页「学习」按钮节流（自定义/公开课程需要先点学习才开始登记学习记录）
  let lastEnrollBtnAt = 0;
  // 片尾降速：视频最后几秒按 1 倍速自然播完（内置倍速引擎 speedTailOverride 联动），
  // 让平台自己的上报逻辑按真人节奏登记完成 —— 不伪造任何完成请求
  let tailMode = false;
  let tailReplays = 0;
  // 视频播完后：等平台把目录状态确认成「已完成」再切下一节（根治来回跳）
  let waitSectionEl = null;
  let waitSectionKey = '';
  let waitSince = 0;
  // 重播多次平台仍不确认完成的项：标记放弃、不再回头点（防止死循环）
  let gaveUpKeys = {};

  function resetPlayerState(cid, why) {
    activePlayerCid = cid;
    playerSinceAt = realNow();
    finishTriggered = false;
    lastSrc = '';
    lastTime = 0;
    lastAdvanceAt = realNow();
    sectionClickAt = 0;
    gaveUpKeys = {};
    resetSectionState(why ? 'resetPlayerState:' + why : '');
    LogA('初始化播放页（新课程）', { cid: cid, why: why || '' });
  }

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

  function sectionKey(el) {
    return text(el).slice(0, 60);
  }

  // 当前正在播放的目录项：优先 active 高亮，其次「学习中/上次学习」标记
  function findCurrentSection(items) {
    for (let i = 0; i < items.length; i++) {
      if (/active/.test(items[i].className || '')) return { el: items[i], idx: i };
    }
    for (let i = 0; i < items.length; i++) {
      const t = text(items[i]);
      if (t.includes('学习中') || t.includes('上次学习')) return { el: items[i], idx: i };
    }
    return null;
  }

  function resetSectionState(why) {
    tailMode = false;
    tailReplays = 0;
    waitSectionEl = null;
    waitSectionKey = '';
    waitSince = 0;
    speedTailOverride = 0;
    if (why) Log('重置小视频状态', why);
  }

  // 点击目录项切到某一小视频（3s 节流，点击后清空等待/片尾状态）
  function clickSection(el, reason) {
    if (!el) return false;
    if (realNow() - sectionClickAt < 3000) return false;
    const clickable =
      el.querySelector('.category-name, .course-list__item__right, a, button, .title, .name') || el;
    const key = sectionKey(el);
    Log('切换小视频', { reason: reason, key: key.slice(0, 50) });
    sectionClickAt = realNow();
    lastAdvanceAt = realNow();
    lastTime = 0;
    lastSrc = '';
    resetSectionState('clickSection:' + reason);
    safeClick(clickable, reason);
    setPanel('>>> ' + reason + '\n' + key.slice(0, 50) + '\n未全部「已完成」前不换下一门课');
    return true;
  }

  // 找下一个未完成且未放弃的目录项：先从 fromIdx 往后，再从头补找
  function findNextUnconfirmed(items, fromIdx) {
    for (let i = fromIdx; i < items.length; i++) {
      const el = items[i];
      if (gaveUpKeys[sectionKey(el)]) continue;
      if (isSectionComplete(el)) continue;
      return el;
    }
    for (let i = 0; i < Math.min(fromIdx, items.length); i++) {
      const el = items[i];
      if (gaveUpKeys[sectionKey(el)]) continue;
      if (isSectionComplete(el)) continue;
      return el;
    }
    return null;
  }

  // 严格规则：课内每一个小视频都必须是「已完成」才允许换下一门课
  // 例外：多次片尾重播平台仍不确认的项（gaveUpKeys）视为已处理，避免卡死在同一门课
  function isCourseFullyDone() {
    const stats = sectionStats();
    if (stats.total <= 0) return false;
    if (stats.unfinished === 0 && stats.done === stats.total) return true;
    return stats.items.every((el) => isSectionComplete(el) || !!gaveUpKeys[sectionKey(el)]);
  }

  function finishCurrentCourse(reason) {
    if (finishTriggered) return;
    // 二次校验：目录未全部「已完成」绝不离开
    if (!isCourseFullyDone()) {
      Log('拒绝提前完课（仍有未完成小视频）', sectionStats());
      finishTriggered = false;
      return;
    }
    // 进页冷静期：刚进播放页（比如目录本来就是全部已完成的历史课）不立即完课，
    // 防止误判秒回跳（旧版 minStayBeforeFinishMs 配置从未生效，这里补上）
    const stayedMs = realNow() - playerSinceAt;
    if (stayedMs < (CFG.minStayBeforeFinishMs || 20000)) {
      Log('目录已全部完成，但冷静期未满暂不完课', { stayedMs: stayedMs });
      setPanel(
        '目录全部「已完成」\n冷静期 ' +
          Math.ceil(((CFG.minStayBeforeFinishMs || 20000) - stayedMs) / 1000) +
          's 后正式完课\n(防刚进页面就误判)'
      );
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
        (CFG.autoReturnToPath
          ? CFG.doneWaitMs / 1000 + 's 后回路径页开下一门'
          : '路径页将自动开下一门，本标签保持不动') +
        '\n不会关闭标签'
    );
    setTimeout(
      () => {
        // 默认不自动回跳路径（autoReturnToPath=false）：
        // 路径操作标签检测到 course_done 后会在本标签（_xue_player）里打开下一门课
        if (!CFG.autoReturnToPath) {
          setPanel('本课已完成 ✓\n保持在本播放页等待下一门课');
          // 兜底：若路径操作标签全关了（租约失活），本标签自动接替回路径，避免整体停摆
          setTimeout(function () {
            if (finishTriggered && pageType() === 'player') {
              const st2 = loadState();
              const lease = st2.pathWorker || {};
              if (!lease.id || realNow() - (lease.at || 0) > 30000) {
                LogW('路径操作标签已失活，播放页自动接替回路径');
                if (st2.pathUrl) location.href = st2.pathUrl;
              }
            }
          }, 60000);
          return;
        }
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
      },
      CFG.doneWaitMs
    );
  }

  function playerAdvanceTick() {
    if (!document.body) return;
    // 防僵尸：本标签 SPA 跳去了别的页面类型时，立即停止心跳/切课逻辑
    if (pageType() !== 'player') return;
    // 完课后等待期间，心跳绝不能把 course_done 覆盖回 playing；
    // 平台会自动循环重播已完成的视频，顺手暂停（核心3已联动不会重复拉起）
    if (finishTriggered) {
      const fv = getVideo();
      if (fv && !fv.paused) {
        // 进度条对齐：16倍速下平台按上报进度先判完成，视频物理位置可能没到头，
        // 拉到片尾再暂停，避免"课程已完成但进度条只有八成"的观感（不伪造上报，完成是平台判的）
        try {
          if (fv.duration && fv.currentTime < fv.duration - 1) fv.currentTime = fv.duration - 0.5;
        } catch (e) {}
        try { fv.pause(); } catch (e) {}
        Log('本课已完成，已暂停平台自动循环重播');
      }
      return;
    }
    const video = getVideo();
    const stats = sectionStats();
    const cid = courseIdFromUrl(location.href);

    // 心跳：告诉路径页「有课在播，别再开一门」（真实时钟；节流到 ≥1s 一次防 localStorage 狂写）
    if (realNow() - lastHbWriteAt >= 1000) {
      lastHbWriteAt = realNow();
      saveState({
        phase: 'playing',
        activeCourseId: cid || loadState().activeCourseId || '',
        activeOpenedAt: loadState().activeOpenedAt || realNow(),
        activeTitle: loadState().activeTitle || document.title,
        pathUrl: loadState().pathUrl || '',
        playerHeartbeatAt: realNow(),
        playerUnloadAt: 0,
        lastAction: 'player_heartbeat',
        allowOpenNext: false,
      });
    }

    // 学习按钮：自定义/公开课程的播放页要先点「学习/我要学习」才开始登记学习记录。
    // 成长计划路径开出来的课没有这个按钮，不受影响（带节流，点过一次就不再点）
    if (realNow() - lastEnrollBtnAt > 5000) {
      let enrollBtn = findEnrollButton();
      if (!enrollBtn) {
        enrollBtn =
          qsa('button, a, [role="button"]').find((el) => text(el) === '学习' && isVisible(el)) ||
          qsa('div, span').find((el) => text(el) === '学习' && looksLikeEnrollControl(el)) ||
          null;
      }
      if (enrollBtn) {
        lastEnrollBtnAt = realNow();
        LogA('检测到「学习」按钮，点击开始学习', { text: text(enrollBtn), tag: enrollBtn.tagName, cls: String(enrollBtn.className).slice(0, 40) });
        setPanel('检测到「学习」按钮\n>>> 点击开始学习');
        safeClick(enrollBtn, '播放页学习按钮');
        return;
      }
    }

    // 跟踪 src 变化（切小视频后）
    if (video) {
      const src = video.currentSrc || video.src || '';
      const t = video.currentTime || 0;
      if (src && src !== lastSrc) {
        lastSrc = src;
        lastTime = t;
        lastAdvanceAt = realNow();
        finishTriggered = false;
        resetSectionState('切换新小视频(src变化)');
      } else if (!video.paused && Math.abs(t - lastTime) > 0.2) {
        lastTime = t;
        lastAdvanceAt = realNow();
      }
    }

    // 1) 片尾降速：媒体时间剩余 ≤8s 时降为 1 倍速自然播完（内置倍速引擎联动）
    //    目的：高倍速下最后几秒一闪而过，平台上报来不及登记 → 服务器永远不给「已完成」。
    //    按真人节奏播完片尾，平台自己的上报逻辑就会自然登记完成，不需要伪造任何请求。
    if (video && !video.ended && !tailMode) {
      const d = video.duration || 0;
      if (d > 0 && d - (video.currentTime || 0) <= 8) {
        tailMode = true;
        speedTailOverride = 1;
        hackVideoSpeed();
        Log('进入片尾，自动降为1倍速自然播完', { leftSec: (d - video.currentTime).toFixed(1) });
      }
    }
    if (tailMode && video && !video.ended && (video.duration || 0) - (video.currentTime || 0) > 15) {
      // 片尾状态被重置（回看/换片），恢复加速
      tailMode = false;
      speedTailOverride = 0;
      hackVideoSpeed();
      Log('片尾状态解除，恢复倍速');
    }

    // 2) 当前小视频播完 → 等平台确认「已完成」再切下一节，绝不来回跳
    if (video && isVideoFinished(video)) {
      const items = stats.items;
      // 优先沿用正在等待确认的目录项，避免平台移动「上次学习」标记后跟错行
      let curIdx = -1;
      let curEl = null;
      if (waitSectionKey) {
        for (let i = 0; i < items.length; i++) {
          if (sectionKey(items[i]) === waitSectionKey) {
            curIdx = i;
            curEl = items[i];
            break;
          }
        }
      }
      if (!curEl) {
        const cur = findCurrentSection(items);
        if (cur) {
          curEl = cur.el;
          curIdx = cur.idx;
        }
      }

      // 已放弃等待的项不再回头处理（点了也是原地转圈）
      if (curEl && gaveUpKeys[sectionKey(curEl)]) {
        const nx = findNextUnconfirmed(items, curIdx + 1);
        if (nx) {
          clickSection(nx, '继续下一项(跳过已放弃项)');
          return;
        }
        if (isCourseFullyDone()) {
          finishCurrentCourse('含未确认项，其余全部完成');
          return;
        }
        setPanel('当前项已放弃等待且无下一项\n等待平台状态自愈...');
        return;
      }

      if (curEl && isSectionComplete(curEl)) {
        // 平台已确认完成 → 切下一节
        waitSectionKey = '';
        waitSectionEl = null;
        waitSince = 0;
        const nextEl = findNextUnconfirmed(items, curIdx + 1);
        if (nextEl) {
          clickSection(nextEl, '下一小视频');
          return;
        }
        if (isCourseFullyDone()) {
          finishCurrentCourse('全部小视频已确认完成 ' + stats.done + '/' + stats.total);
          return;
        }
        setPanel('当前小视频已确认完成\n但目录仍有未完成项，继续等待...\n完成 ' + stats.done + '/' + (stats.total || '?'));
        return;
      }

      // 平台可能已把「上次学习」标记移到下一项（前一项已确认完成）：直接开播标记项
      if (curEl && curIdx > 0 && !waitSince && video.ended && isSectionComplete(items[curIdx - 1])) {
        clickSection(curEl, '平台标记的下一项');
        return;
      }

      // 未确认：先等（90s）→ 片尾10秒1倍速重播（≤2次）→ 放弃该项继续
      if (!waitSince) {
        waitSince = realNow();
        waitSectionKey = curEl ? sectionKey(curEl) : '';
        waitSectionEl = curEl;
        Log('视频播完，等待平台确认「已完成」', { key: waitSectionKey.slice(0, 40) });
      }
      const waitedMs = realNow() - waitSince;
      if (waitedMs < 90000) {
        setPanel(
          '视频播完，等平台确认完成\n剩余 ' +
            Math.ceil((90000 - waitedMs) / 1000) +
            's\n' +
            waitSectionKey.slice(0, 40) +
            '\n完成 ' +
            stats.done +
            '/' +
            (stats.total || '?') +
            '\n未确认前不切下一节（防来回跳）'
        );
        return;
      }
      if (tailReplays < 2) {
        tailReplays += 1;
        waitSince = realNow();
        tailMode = true;
        speedTailOverride = 1;
        try {
          video.currentTime = Math.max(0, (video.duration || 12) - 10);
          video.muted = true;
          video.play().catch(function () {});
        } catch (e) {}
        LogW('平台未确认完成，片尾10秒按1倍速重播', { attempt: tailReplays, key: waitSectionKey.slice(0, 40) });
        setPanel('平台未确认完成\n>>> 片尾10秒按1倍速重播（第' + tailReplays + '次）\n' + waitSectionKey.slice(0, 40));
        return;
      }
      // 重播两次平台仍不确认：标记放弃，继续下一节，绝不回头反复点
      gaveUpKeys[waitSectionKey] = realNow();
      LogE('多次重播仍未确认完成，跳过该项继续', { key: waitSectionKey.slice(0, 60) });
      waitSectionKey = '';
      waitSectionEl = null;
      waitSince = 0;
      const nextEl2 = findNextUnconfirmed(items, 0);
      if (nextEl2) {
        clickSection(nextEl2, '跳过未确认项继续');
        return;
      }
      if (isCourseFullyDone()) {
        finishCurrentCourse('含未确认项，其余全部完成');
        return;
      }
      return;
    }

    // 3) 目录全部「已完成」→ 才算本课完成
    if (isCourseFullyDone()) {
      finishCurrentCourse('目录全部已完成 ' + stats.done + '/' + stats.total);
      return;
    }

    // 4) 卡死自愈（等待平台确认期间不触发，避免误杀正常等待）
    if (!waitSince) {
      const rn = realNow();
      if (video && !isVideoFinished(video) && rn - lastAdvanceAt > 180000) {
        if (rn - lastAdvanceAt > 240000) {
          LogE('播放超过4分钟无任何进展，自动刷新播放页', {
            t: video.currentTime,
            src: (video.currentSrc || '').slice(0, 80),
          });
          location.reload();
          return;
        }
        LogW('播放3分钟无进展（可能缓冲卡死）', { t: video.currentTime });
      }
      if (!video && rn - playerSinceAt > 120000) {
        LogW('播放页超过2分钟没有视频元素，自动刷新');
        location.reload();
        return;
      }
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
        (tailMode ? '\n片尾1倍速自然播完中…' : '') +
        '\n规则：全部已完成才换下一门课\n不会关标签/不会乱跳'
    );
  }

  // ---------- 学习列表页（可选，默认关闭自动点计划） ----------
  function studyHintLoop() {
    // 「自动学习」引导进行中时不覆盖引导提示
    if (loadBootstrap().active) return;
    setPanel(
      '我的学习页\n可点面板「自动学习」一键带路\n或手动进入：专属成长计划 → 具体任务\n进入路径后脚本会自动开未学完课程'
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
      // 兼容 "A" / "A.xxx" / "A、xxx" / "A xxx" / 「正确」「错误」等标签写法
      // （旧版只认整标签恰为单个字母，"A.选项内容" 全部漏配 → 正式考试全部盲答）
      const m = t.match(/^([A-Da-d])(?:[.、．\s]|$)/);
      let letter = m ? m[1].toUpperCase() : '';
      if (!letter) {
        if (/正确|对|是/.test(t) && !/错误|否|错/.test(t)) letter = '正确';
        else if (/错误|否|错/.test(t)) letter = '错误';
      }
      if (letter && want.some((w) => w === letter || w === t)) {
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
    // 试卷懒加载：题目变多时更新总数，避免漏答后面才渲染的题
    if (examAnswerProgress.total && items.length > examAnswerProgress.total) {
      LogW('试卷题目增多（懒加载），更新总数', { old: examAnswerProgress.total, now: items.length });
      examAnswerProgress.total = items.length;
    }

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
      examAnsweredAt = realNow();
      examSubmitStarted = false;
      const st0 = loadState();
      // 保留路径页写入的 examMode/examHasHistory；仅在完全未知时兜底
      const keepMode = st0.examMode || (examAnswerProgress.matched > 0 ? 'known' : 'blind');
      saveState({
        phase: 'exam_running',
        examId: examAnswerProgress.examId || examId,
        examTitle: examAnswerProgress.examTitle || examTitle,
        examOpenedAt: st0.examOpenedAt || realNow(),
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
    if (lastModalActionAt && realNow() - lastModalActionAt < (CFG.examModalWaitMs || 2500)) {
      return lastModalKind || 'wait';
    }
    const confirmBtn = findVisibleModalButton(['确认', '确定']);
    // 只取真正可见的弹窗文字：display:block 的元素在 display:none 父级下也能通过旧判断，
    // 隐藏的结果弹窗模板文字被误拼进来 → 误判"结果弹窗"反复空点（实测踩坑）
    const modalText = qsa('.modal, .modal-dialog, [role=dialog]')
      .filter((m) => m.offsetParent !== null || (m.getClientRects && m.getClientRects().length > 0))
      .map((m) => text(m))
      .join(' ');
    if (confirmBtn && /交卷|提交|无法更改|是否确定/.test(modalText + text(confirmBtn.parentElement || document.body))) {
      LogA('考试确认交卷弹窗', modalText.slice(0, 80));
      lastModalActionAt = realNow();
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
      lastModalActionAt = realNow();
      lastModalKind = 'result_close';
      saveState({
        lastAction: 'exam_result_modal',
        lastExamResultText: modalText.slice(0, 120),
        examPhase: failed ? 'failed' : 'passed',
        phase: failed ? 'exam_failed' : 'exam_passed',
        // 保持锁一会儿，避免路径页立刻又开
        examOpenedAt: realNow(),
        allowOpenExam: true,
        lastExamOpenAt: realNow(),
      });
      if (!failed) recordExamPassed('result_modal');
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
      lastModalActionAt = realNow();
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
    if (!document.body || !isAutoExamOn()) return;
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
    if (!examSubmitStarted && realNow() - examAnsweredAt >= submitDelay) {
      if (submitVisible) {
        examSubmitStarted = true;
        submitExamPaper();
        setPanel('已点「我要交卷」\n等待确认弹窗...');
      } else {
        setPanel('试卷已提交或按钮不可见\n等待结果弹窗...');
      }
    } else if (!examSubmitStarted) {
      const left = Math.ceil((submitDelay - (realNow() - examAnsweredAt)) / 1000);
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
    bank.updatedAt = realNow();
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
    if (!document.body || !isAutoExamOn()) return;
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
        if (detectResultPass()) recordExamPassed('result_page_cached');
        saveState({
          phase: 'exam_learned',
          examId: eid,
          allowOpenExam: true,
          lastAction: 'exam_already_learned',
          // 注意：不要刷新 lastExamOpenAt 成“刚开考”，否则路径页会误判冷却/锁
          lastExamHistoryAt: realNow(),
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
    if (detectResultPass()) recordExamPassed('result_page');
    saveState({
      phase: 'exam_learned',
      examId: learned.examId || loadState().examId || '',
      examTitle: learned.examTitle || loadState().examTitle || '',
      lastAction: 'exam_learn_answers',
      allowOpenExam: true,
      examPhase: 'learned',
      // 记答案完成：解开 exam 锁，允许路径页正式开考；仅保留 history 冷却
      examOpenedAt: 0,
      lastExamHistoryAt: realNow(),
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
    bootPageType = type;
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

    // 一键「自动学习」引导：每页启动时检查并继续，直到到达路径页（未激活时零开销）
    try {
      bootstrapTick();
      setInterval(bootstrapTick, 2000);
    } catch (e) {}

    if (type === 'study') {
      setPanel('页面：我的学习\n可点面板「自动学习」一键开始\n或手动进入：专属成长计划 → 具体任务\n可点「复制日志」');
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
          (isAutoExamOn() ? '开(全局)' : '关') +
          ' 倍速：' +
          (function () {
            const c = loadSpeedCfg();
            return c.on ? c.rate + 'x' : '关';
          })()
      );
      setTimeout(function () { pathLoop(false); }, 800);
      setTimeout(function () { pathLoop(false); }, 2000);
      setInterval(function () { pathLoop(false); }, CFG.pathScanMs);
      window.addEventListener('hashchange', () => setTimeout(function () { pathLoop(false); }, 800));
      return;
    }

    if (type === 'player') {
      activePlayerCid = courseIdFromUrl(location.href) || 'unknown';
      playerSinceAt = realNow();
      // 同标签换课（路径页 window.open 复用 _xue_player 标签、URL 仅 hash 变化）时，
      // 重置播放状态，避免上一门课的 finishTriggered/等待状态卡住新课
      window.addEventListener('hashchange', function () {
        if (pageType() !== 'player') return;
        const cid = courseIdFromUrl(location.href);
        if (cid && cid !== activePlayerCid) resetPlayerState(cid, 'hashchange换课');
      });
      // 0) 倍速引擎：document-start 已挂钩的保持；未挂钩（中途开启/SPA进入）的现在补挂。
      //    旧独立「16倍速」脚本若还在运行会双重加速，必须删除。
      if (loadSpeedCfg().on && !speedInstalled) installSpeedHooks();
      if (window.__hook_timer_loaded) {
        LogW('检测到旧「阳光学习平台16倍速」独立脚本仍在运行，会双重加速！请到 Tampermonkey 管理面板删除旧脚本');
        setPanel('⚠ 检测到旧「16倍速」独立脚本\n请先删除它，否则会双重加速');
      }
      // 倍速保持：每秒按当前设置/片尾降速强制视频倍速（用原始定时器，不自我加速狂刷）；
      // 新插入的 video 元素也立即应用
      {
        const schedSpeed =
          speedInstalled && speedOrigSetInterval ? speedOrigSetInterval : window.setInterval.bind(window);
        schedSpeed(hackVideoSpeed, 1000);
        try {
          new MutationObserver(function () {
            hackVideoSpeed();
          }).observe(document.body, { childList: true, subtree: true });
        } catch (e) {}
      }
      // 1) 严格加载你验证过的 v5.4（任何子核心启动失败都不能阻断后面的切课编排）
      try {
        installV54PlayerCore();
      } catch (e) {
        LogW('v5.4 播放核心部分功能启动失败（不影响自动切课）', String(e).slice(0, 80));
      }
      // 2) 仅附加：播完判定与下一课编排（默认不自动回路径）
      setInterval(playerAdvanceTick, CFG.playerAdvanceMs);
      // 3) 播放页关闭时留下信号，路径页几秒内即可释放播放锁（不用等满心跳超时）
      window.addEventListener('pagehide', function () {
        try {
          const st = loadState();
          const cid = courseIdFromUrl(location.href);
          if (st.phase === 'playing' && cid && cid === st.activeCourseId) {
            saveState({ playerUnloadAt: realNow(), lastAction: 'player_unload' });
          }
        } catch (e) {}
      });
      const spdCfg = loadSpeedCfg();
      setPanel(
        '播放页已加载 v5.4 原逻辑\n倍速：' +
          (spdCfg.on ? spdCfg.rate + 'x（片尾自动降1x）' : '关') +
          '\n播完等平台确认完成再切下一节\n全部「已完成」才算完课\n可点「复制日志」'
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

  // 倍速引擎要在页面自己的脚本调度计时器之前挂钩。本脚本整体在 document-start
  // 同步执行，这里虽在文件末尾，仍早于页面脚本运行。
  try {
    if (isPlayerUrl() && loadSpeedCfg().on) installSpeedHooks();
  } catch (e) {}

  startWhenReady();
})();
