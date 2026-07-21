// ==UserScript==
// @name         阳光学习平台16倍速
// @namespace    https://xue.sinosig.com/
// @version      8.0
// @description  默认16倍速（浏览器最高限制），解决CSP阻止问题
// @author       You
// @match        https://xue.sinosig.com/*
// @match        https://*.sinosig.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const RATE = 16; // 浏览器最高只支持16倍，32会报错
    const PERCENTAGE = 1 / RATE;

    // 使用 unsafeWindow 绕过 CSP
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    console.log('[16x加速] 脚本注入中...');

    // 1. Hook setInterval
    const origSetInterval = win.setInterval.bind(win);
    win.setInterval = function(fn, delay, ...args) {
        if (typeof delay === 'number' && delay > 0) {
            delay = Math.max(1, Math.floor(delay * PERCENTAGE));
        }
        return origSetInterval(fn, delay, ...args);
    };

    // 2. Hook setTimeout
    const origSetTimeout = win.setTimeout.bind(win);
    win.setTimeout = function(fn, delay, ...args) {
        if (typeof delay === 'number' && delay > 0) {
            delay = Math.max(1, Math.floor(delay * PERCENTAGE));
        }
        return origSetTimeout(fn, delay, ...args);
    };

    // 3. Hook Date.now - 让时间也加速
    const origDateNow = Date.now.bind(Date);
    let lastReal = origDateNow();
    let lastFake = lastReal;

    Date.now = function() {
        const now = origDateNow();
        const diff = now - lastReal;
        lastReal = now;
        lastFake += diff * RATE;
        return lastFake;
    };

    // 4. 视频加速（每1秒强制设置，防止被网站重置）
    function hackVideo() {
        try {
            const videos = win.document.querySelectorAll('video');
            videos.forEach(video => {
                if (video.playbackRate !== RATE) {
                    try {
                        video.playbackRate = RATE;
                    } catch(e) {
                        // 如果16倍失败，尝试8倍
                        try { video.playbackRate = 8; } catch(e2) {}
                    }
                }
            });
        } catch(e) {}
    }

    // 5. 立即执行 + 定时检查
    setInterval(hackVideo, 1000);

    // 6. 监听视频元素创建
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.tagName === 'VIDEO' || (node.querySelectorAll && node.querySelectorAll('video').length > 0)) {
                    hackVideo();
                }
            });
        });
    });

    // 尽早启动观察
    function startObserver() {
        if (win.document.body) {
            observer.observe(win.document.body, { childList: true, subtree: true });
            console.log('[16x加速] 已启动，当前倍速:', RATE);
        } else {
            setTimeout(startObserver, 100);
        }
    }
    startObserver();

    // 7. 如果是 iframe，也向上层发送消息（处理嵌套iframe）
    if (win.parent !== win) {
        win.parent.postMessage({type: 'timer_hook_loaded', rate: RATE}, '*');
    }

    // 标记已加载
    win.__hook_timer_loaded = true;
    console.log('[16x加速] 注入成功');
})();